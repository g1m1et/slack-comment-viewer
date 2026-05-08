# MV3 Service Worker 再起動耐性の確保 設計

- 作成日: 2026-05-08
- 関連 issue: [KIRI-146](https://linear.app/ivry/issue/KIRI-146)
- 前提コミット: `53c733c` (KIRI-143: `oldest` 浮動小数点問題の修正)
- 対象リポジトリ: slack-comment-viewer

## 背景

KIRI-143（放置中のコメント表示詰まり）の修正過程で根本原因（`oldest` の浮動小数点問題）は片付いたが、その過程で **MV3 Service Worker のライフサイクル** に関する別の脆弱性が顕在化した。本設計はそれを最小限の変更で堅牢化する。

実運用テストでは 30 分の無音状態から問題なく復帰するため致命ではないが、長時間放置や Chrome のメモリ圧で SW が落ちた際にメッセージを取りこぼす可能性があり、ウェビナー本番中の保険として対応する。

### 問題の構造

`background.js` の現状（執筆時点）：

```js
function startPolling() {
  stopPolling();                                          // ← 状態を全消し
  loadLastTs().then(() => {
    pollOnce();
    pollingTimer = setInterval(pollOnce, 3000);           // ← SW idle で消滅
  });
}

function stopPolling() {
  if (pollingTimer) { clearInterval(pollingTimer); pollingTimer = null; }
  lastTsMicro = null;                                     // ← 状態リセット
  userCache = {};
  chrome.storage.local.remove("_lastTs");                 // ← 永続化済み ts を削除
}

chrome.storage.local.get({ enabled: false }, (settings) => {
  if (settings.enabled) startPolling();                   // ← SW 再起動時もここを通る
});
```

#### 問題1: `setInterval` が SW idle terminate で消える

MV3 では SW が約 30 秒のアイドルで terminate される設計。`setInterval` は SW と運命を共にするため、再起動後はポーリングが復活しない。CLAUDE.md の記述（「`_lastTs` 永続化で差分取得を維持」）は、`setInterval` 自体が消えれば成立しない。

#### 問題2: SW 再起動のたびに `_lastTs` が wipe される

`startPolling()` 冒頭の `stopPolling()` が `chrome.storage.local.remove("_lastTs")` を実行する。SW 再起動時の起動シーケンス（`storage.get → startPolling → stopPolling → loadLastTs`）でも同経路を通るため、毎回 `_lastTs` が削除されてから読み出される。結果、無音 → アイドル落ち → 再起動の間の投稿はすべて取りこぼし、初期取得の「直近 30 秒」境界以前は見えない。

`stopPolling()` が「タイマー停止 / 状態リセット / storage 削除」を一つにまとめており、責務が混ざっていることが根本原因。

## 目的・スコープ

### 対象

- `setInterval` ベースのポーリングに加えて `chrome.alarms` ベースの watchdog を導入し、SW 再起動時に自己治癒する経路を作る
- `stopPolling()` の責務を分離し、SW 再起動時に `_lastTs` を消さないようにする
- CLAUDE.md の「MV3 Service Worker のライフサイクル」セクションを実装と整合させる

### 非対象

- 拡張の自動テストインフラ整備（現状無いため、本 issue でも導入しない）
- ポーリング間隔の最適化（3 秒間隔は据え置き）
- SW 再起動回数のメトリクス収集
- alarm 失敗時のリトライ・exponential backoff（次の alarm が 1 分後に来るので不要）
- token/channel 切替時のキャッシュ最適化

### 成功条件（exit criteria）

1. 30 分以上の無音状態（SW idle terminate を含む）から、Slack に投稿された新着が漏れなく表示される
2. 設定変更（`token` / `channel` / `enabled` トグル）時のリセット動作は従来通り
3. 通常時の新着レイテンシは現状維持（最大 3 秒）

## 設計

### アーキテクチャ概要

`setInterval` + `chrome.alarms` のハイブリッド方式：

- **通常時**: `setInterval(pollOnce, 3000)` で 3 秒間隔ポーリング
- **watchdog**: `chrome.alarms` を `periodInMinutes: 1` で並走させ、SW 再起動時の保険として機能させる
- alarm 発火時の処理: `pollingTimer === null` なら `startPolling()` を呼んで自己治癒。既に動いていれば念のため `pollOnce()` を 1 回

最小周期 1 分の制約上、SW が落ちている瞬間の取りこぼしは最大 1 分。Chrome の制約上どうにもならず、現状の「設定変更時に `_lastTs` が wipe される」問題の方が体感影響が大きいので許容する。

### 関数の責務分離

`stopPolling()` を廃止し、責務ごとに分離：

```js
function pausePolling() {
  if (pollingTimer) { clearInterval(pollingTimer); pollingTimer = null; }
}

function resetPollingState() {
  lastTsMicro = null;
  userCache = {};
  return chrome.storage.local.remove("_lastTs");
}
```

呼び出し側で意図に応じて使い分ける：

| イベント | 処理 |
|----------|------|
| `enabled: false → true` | `resetPollingState()` → `startPolling()` → `ensureWatchdog()` |
| `enabled: true → false` | `pausePolling()` → `resetPollingState()` → `chrome.alarms.clear(WATCHDOG_ALARM)` |
| `channel` 変更（enabled 中） | `resetPollingState()` → `startPolling()`（過去 ts は無意味） |
| `token` 変更（enabled 中） | `pausePolling()` → `startPolling()`（lastTs は据え置き） |
| SW 再起動 | `startPolling()` のみ。状態は触らない |

`startPolling()` 自体は冒頭で `pausePolling()` のみを呼び、状態には触らない：

```js
function startPolling() {
  pausePolling();
  loadLastTs().then(() => {
    pollOnce();
    pollingTimer = setInterval(pollOnce, 3000);
  });
}
```

### chrome.alarms watchdog

```js
const WATCHDOG_ALARM = "polling-watchdog";

async function ensureWatchdog() {
  const settings = await chrome.storage.local.get({ enabled: false });
  if (!settings.enabled) return;
  await chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 1 });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== WATCHDOG_ALARM) return;
  if (pollingTimer === null) startPolling();
  else pollOnce();
});

chrome.runtime.onStartup.addListener(ensureWatchdog);
chrome.runtime.onInstalled.addListener(ensureWatchdog);
```

- alarm は `enabled: true` の時だけ作成
- `enabled: false` への遷移で `chrome.alarms.clear(WATCHDOG_ALARM)`
- alarm リスナーは SW のトップレベルで登録する（再起動時にも復活する経路）

### 起動シーケンス（SW 再起動時）

```
SW 起動
  → chrome.storage.onChanged リスナー登録（トップレベル）
  → chrome.alarms.onAlarm リスナー登録（トップレベル）
  → chrome.runtime.onStartup / onInstalled リスナー登録（トップレベル）
  → chrome.storage.local.get({ enabled }) → enabled なら startPolling() & ensureWatchdog()
```

- `startPolling()` 内では `loadLastTs()` が storage から `_lastTs` を読み出す
- `_lastTs` は wipe されていないので**正しく再開できる**
- 万が一 `setInterval` が成立しなかった場合も、1 分後の alarm 発火で自己治癒する

### CLAUDE.md 更新

`設計上の注意点` セクションの「MV3 Service Worker のライフサイクル」を以下の方針に書き換える：

- `setInterval` + `chrome.alarms` watchdog のハイブリッド構造
- `_lastTs` 永続化と状態リセット (`resetPollingState`) の責務分離
- alarm の最小周期 1 分制約と、SW 再起動時の最大取りこぼし時間の関係

## 検証方針

拡張テストインフラが無いため、手動シナリオで検証する：

1. 拡張を有効化 → Slack に投稿 → 表示される（通常動作の確認）
2. 30〜45 分放置（SW idle terminate を意図的に誘発）
3. 放置中に Slack 投稿 → 1 分以内に表示されることを確認
4. token を変更 → lastTs 据え置きで継続動作することを確認
5. channel を変更 → 過去メッセージが流れず、新チャネルから取得開始することを確認
6. enabled を OFF → ON → 状態が完全リセットされてから再開することを確認

SW idle terminate の誘発は `chrome://serviceworker-internals/` で手動 stop も可能。
