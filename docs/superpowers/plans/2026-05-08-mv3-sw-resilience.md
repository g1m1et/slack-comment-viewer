# MV3 Service Worker 再起動耐性 実装プラン

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MV3 Service Worker の idle terminate / 再起動が起きても、Slack の新着メッセージを取りこぼさず表示する。

**Architecture:** `setInterval(3秒)` + `chrome.alarms(1分)` のハイブリッド方式。`stopPolling()` を `pausePolling()`（タイマー停止のみ）と `resetPollingState()`（lastTs / userCache / storage 削除）に責務分離し、SW 再起動時に `_lastTs` が wipe されない経路を作る。alarm を watchdog として並走させ、SW が落ちて setInterval が消えても 1 分以内に自己治癒する。

**Tech Stack:** Vanilla JavaScript、Chrome Extension MV3、`chrome.storage.local`、`chrome.alarms`、`chrome.runtime.onStartup` / `onInstalled`。

**Spec:** `docs/superpowers/specs/2026-05-08-mv3-sw-resilience-design.md`

**関連 issue:** KIRI-146

## 前提

- 本リポジトリには自動テスト基盤がない。検証は Chrome での手動動作確認で行う
- ビルドプロセスはない。`background.js` または `manifest.json` を編集したら、`chrome://extensions` で拡張の「更新」ボタンを押すだけで反映される
- Slack Bot Token と channel ID が popup で設定済みで、対象 Slack チャネルでメッセージが送受信できる状態で検証する
- background.js のデバッグは `chrome://extensions` → 拡張カード内の「Service Worker（検証）」リンクから開く DevTools コンソールで行う
- SW idle terminate を手動で誘発するには、`chrome://serviceworker-internals/` で対象 SW を検索して「Stop」ボタンを押す方法が最も確実

## File Structure

- **Modify:** `manifest.json` — `"alarms"` permission 追加
- **Modify:** `background.js` — 以下の変更：
  - 関数分離: `stopPolling()` を廃止し `pausePolling()` + `resetPollingState()` に分割
  - `startPolling()` の冒頭呼び出しを `pausePolling()` に変更
  - `chrome.storage.onChanged` リスナーの分岐を更新（`enabled` / `channel` / `token` で挙動を区別）
  - 起動時 `chrome.storage.local.get` ブロックに `ensureWatchdog()` 呼び出しを追加
  - `chrome.alarms.onAlarm` リスナー追加
  - `chrome.runtime.onStartup` / `onInstalled` リスナー追加
  - `ensureWatchdog()` 関数追加
- **Modify:** `CLAUDE.md` — 「設計上の注意点」の MV3 SW ライフサイクル記述を実装と整合させる

他ファイル（`content.js`、`content.css`、`popup.html`、`popup.js`）は無変更。

### Task の順序設計

各 Task が独立してコミット可能（コンパイルが通る、ロード可能）になるよう以下の順で進める：

1. **Task 1**: 現状再現（観察のみ）
2. **Task 2**: alarms permission 追加（manifest のみ。コードは無変更で alarms API は未使用）
3. **Task 3**: `stopPolling()` の責務分離（onChanged 更新含む。alarms はまだ呼ばない）
4. **Task 4**: chrome.alarms watchdog 接続（alarms-clear や ensureWatchdog 呼び出しを onChanged と起動経路に挿入）
5. **Task 5**: 手動検証（SW 再起動シナリオ）
6. **Task 6**: CLAUDE.md 更新
7. **Task 7**: 最終リグレッションテスト

---

## Task 1: 現状挙動の再現（ベースライン確認）

**目的:** 実装前に現状の問題挙動を観察し、実装後の比較基準を確立する。

**Files:** 変更なし（観察のみ）

- [ ] **Step 1: 現在の `background.js` を Chrome に読み込み直す**

1. `chrome://extensions` を開く
2. デベロッパーモード ON を確認
3. 拡張「Slack Comment Overlay」の「更新」ボタンを押す（または未読み込みなら「パッケージ化されていない拡張機能を読み込む」でリポジトリのルートを指定）
4. エラーなく読み込まれることを確認

- [ ] **Step 2: enabled トグル時の `_lastTs` wipe を再現**

1. popup で `enabled=ON` にし、Slack チャネルに 1 件投稿
2. 任意のページで content.js が新着を表示することを確認
3. `chrome://extensions` → 拡張カードの「Service Worker（検証）」リンクで DevTools を開く
4. DevTools コンソールで以下を実行：

```js
await chrome.storage.local.get('_lastTs')
```

**Expected:** `{_lastTs: "1746...123456"}` のような値が返る（直近メッセージの ts）

5. popup で `enabled=OFF` に切り替える
6. DevTools コンソールで再び：

```js
await chrome.storage.local.get('_lastTs')
```

**Expected:** `{}` が返る（OFF 時に消されている — これは仕様通り）

- [ ] **Step 3: SW 再起動時の `_lastTs` wipe を再現（最重要）**

1. popup で `enabled=ON` にして Slack に 1 件投稿、表示と `_lastTs` の保存を確認
2. `chrome://serviceworker-internals/` を開く
3. URL 検索欄で対象拡張の URL（`chrome-extension://<拡張ID>/`）を絞り込み
4. 対象 SW の「Stop」ボタンを押す
5. すぐに `chrome://extensions` のデベロッパーツール（Service Worker）を再度開く（自動的に SW が再起動する）
6. 新しい DevTools コンソールで：

```js
await chrome.storage.local.get('_lastTs')
```

**Expected（現状の問題）:** `{}` が返る — SW 再起動時の `startPolling()` → `stopPolling()` 経路で wipe されている

7. この瞬間に Slack に投稿しても、初期取得が「直近 30 秒」基準のため、SW 停止前の投稿は取りこぼす

このベースラインを基準に、実装後は **Task 5 Step 2 の Expected が `{_lastTs: "..."}` を保持する** ことを確認する。

---

## Task 2: manifest.json に alarms permission を追加

**目的:** `chrome.alarms` API を使うために必須の permission を宣言する（コードは無変更）。

**Files:**
- Modify: `manifest.json:6`

- [ ] **Step 1: permission を追加**

`manifest.json` の `"permissions"` 配列に `"alarms"` を追加する：

```json
{
  "manifest_version": 3,
  "name": "Slack Comment Overlay",
  "version": "1.0.0",
  "description": "Slackチャンネルのコメントをページ上にオーバーレイ表示する",
  "permissions": ["storage", "alarms"],
  "host_permissions": ["https://slack.com/api/*"],
  ...
}
```

- [ ] **Step 2: 拡張を再読み込みして permission が反映されたことを確認**

1. `chrome://extensions` で拡張の「更新」ボタンを押す
2. エラー表示が出ないことを確認
3. 拡張詳細ページの「権限」項目に「アラーム」が増えていることを確認

- [ ] **Step 3: コミット**

```bash
git add manifest.json
git commit -m "feat: alarms permission を追加（KIRI-146 SW watchdog の前準備）"
```

---

## Task 3: stopPolling を pausePolling と resetPollingState に分離

**目的:** SW 再起動時に意図せず `_lastTs` を wipe してしまう根本原因を断つ。タイマー停止と状態リセットの責務を関数名で明示する。本タスク完了時点で **alarms は導入しないが、SW 再起動時の `_lastTs` wipe は止まる**（最重要なバグはここで修正される）。

**Files:**
- Modify: `background.js:132-172`

- [ ] **Step 1: `stopPolling()` を削除し、新関数 `pausePolling()` と `resetPollingState()` を追加**

`background.js` の `function stopPolling() { ... }` ブロック（141-150 行目）を削除し、その位置に以下を挿入：

```js
function pausePolling() {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
}

function resetPollingState() {
  lastTsMicro = null;
  userCache = {};
  return chrome.storage.local.remove("_lastTs");
}
```

- [ ] **Step 2: `startPolling()` の冒頭呼び出しを変更**

`background.js:132-139` の `startPolling()` を以下に書き換え：

```js
function startPolling() {
  pausePolling();
  loadLastTs().then(() => {
    pollOnce();
    pollingTimer = setInterval(pollOnce, 3000);
    console.log("Slack Comment Overlay: polling started");
  });
}
```

唯一の変更は `stopPolling()` → `pausePolling()`。これで `startPolling()` は `_lastTs` を消さない。

- [ ] **Step 3: `chrome.storage.onChanged` リスナーを更新**

`background.js:152-172` の onChanged リスナーを以下に書き換え：

```js
chrome.storage.onChanged.addListener((changes) => {
  // Ignore our own _lastTs changes
  if (changes._lastTs && Object.keys(changes).length === 1) return;

  if (changes.enabled) {
    if (changes.enabled.newValue) {
      // OFF → ON: ensure clean state, then start
      resetPollingState().then(() => {
        startPolling();
      });
    } else {
      // ON → OFF: stop everything
      pausePolling();
      resetPollingState();
    }
    return;
  }

  // token / channel changes while enabled
  if (changes.token || changes.channel) {
    chrome.storage.local.get({ enabled: false }, (settings) => {
      if (!settings.enabled) return;
      if (changes.channel) {
        // Channel changed: prior ts is meaningless
        resetPollingState().then(() => startPolling());
      } else {
        // Token changed only: keep lastTs
        pausePolling();
        startPolling();
      }
    });
  }
});
```

本タスクでは `chrome.alarms.clear(...)` や `ensureWatchdog()` は **まだ呼ばない**。Task 4 で挿入する。

- [ ] **Step 4: 拡張を再読み込みして基本動作を確認**

1. `chrome://extensions` で拡張の「更新」ボタンを押す
2. SW DevTools のコンソールにエラーが出ていないことを確認
3. `enabled=ON` にして Slack に投稿 → 表示されることを確認
4. `enabled=OFF` → `enabled=ON` を繰り返して、トグル動作が壊れていないことを確認

- [ ] **Step 5: SW 再起動時に `_lastTs` が保持されることを確認（このタスクの肝）**

1. `enabled=ON` の状態で Slack に 1 件投稿、表示確認
2. SW DevTools コンソールで：

```js
await chrome.storage.local.get('_lastTs')
```

**Expected:** `{_lastTs: "1746...."}` が返る

3. `chrome://serviceworker-internals/` で対象 SW の「Stop」を押す
4. SW DevTools を再度開く（再起動が走る）
5. 新しいコンソールで：

```js
await chrome.storage.local.get('_lastTs')
```

**Expected（修正後）:** `{_lastTs: "1746...."}` が**保持されている**（Task 1 Step 3 の Expected と対比して、ここが治っている）

- [ ] **Step 6: コミット**

```bash
git add background.js
git commit -m "refactor: stopPolling を責務分離して SW 再起動時の _lastTs wipe を防止 (KIRI-146)"
```

---

## Task 4: chrome.alarms watchdog の追加

**目的:** SW 再起動時に setInterval が消失したまま放置される経路を塞ぐ。1 分以内に自己治癒する watchdog を導入する。

**Files:**
- Modify: `background.js`（複数箇所）

- [ ] **Step 1: 定数と `ensureWatchdog()` を追加**

`background.js` の冒頭近く（`let userCache = {};` の直後あたり）に以下を追加：

```js
const WATCHDOG_ALARM = "polling-watchdog";

async function ensureWatchdog() {
  const settings = await chrome.storage.local.get({ enabled: false });
  if (!settings.enabled) return;
  await chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 1 });
}
```

`chrome.alarms.create` は同名 alarm を上書きするため idempotent。何度呼んでも安全。

- [ ] **Step 2: `chrome.alarms.onAlarm` リスナーを追加**

`background.js` のトップレベル（`chrome.storage.onChanged.addListener(...)` の直後あたり）に追加：

```js
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== WATCHDOG_ALARM) return;
  // pollingTimer !== null means setInterval is alive; no work needed.
  if (pollingTimer !== null) return;
  console.log("Slack Comment Overlay: watchdog reviving polling");
  startPolling();
});
```

`pollingTimer === null` は SW 再起動直後（モジュール初期化で `let pollingTimer = null` が走り、まだ `startPolling()` が動いていない状態）。`pollingTimer !== null` の時は `pausePolling()` を経由しない限りタイマーが生きているため、watchdog は何もしない。

- [ ] **Step 3: 起動時ブロックに `ensureWatchdog()` を追加**

`background.js` の末尾近く（現状 175-179 行目）を以下に変更：

```js
chrome.storage.local.get({ enabled: false }, (settings) => {
  if (settings.enabled) {
    startPolling();
    ensureWatchdog();
  }
});
```

- [ ] **Step 4: `chrome.runtime.onStartup` / `onInstalled` リスナーを追加**

`background.js` のトップレベル（起動時 get ブロックの直前あたり）に追加：

```js
chrome.runtime.onStartup.addListener(ensureWatchdog);
chrome.runtime.onInstalled.addListener(ensureWatchdog);
```

これは Chrome 起動時 / 拡張インストール時の確実な watchdog 復活経路。

- [ ] **Step 5: `chrome.storage.onChanged` リスナーに alarms 制御を追加**

Task 3 で書いた onChanged リスナーの enabled 分岐を以下に更新：

```js
  if (changes.enabled) {
    if (changes.enabled.newValue) {
      // OFF → ON: ensure clean state, then start
      resetPollingState().then(() => {
        startPolling();
        ensureWatchdog();
      });
    } else {
      // ON → OFF: stop everything
      pausePolling();
      resetPollingState();
      chrome.alarms.clear(WATCHDOG_ALARM);
    }
    return;
  }
```

差分は OFF→ON で `ensureWatchdog()` を、ON→OFF で `chrome.alarms.clear(WATCHDOG_ALARM)` を呼ぶ点。

- [ ] **Step 6: 拡張を再読み込みして構文エラーがないことを確認**

1. `chrome://extensions` で拡張の「更新」ボタンを押す
2. SW DevTools を開き、コンソールにエラーが出ていないことを確認
3. `enabled=ON` の状態で DevTools コンソールに以下を入力：

```js
await chrome.alarms.getAll()
```

**Expected:** `[{name: "polling-watchdog", periodInMinutes: 1, scheduledTime: <number>}]` が返る

- [ ] **Step 7: enabled 切替で alarm が出入りすることを確認**

DevTools コンソールで：

```js
await chrome.storage.local.set({ enabled: false })
await chrome.alarms.getAll()
```

**Expected:** `[]` が返る

```js
await chrome.storage.local.set({ enabled: true })
await chrome.alarms.getAll()
```

**Expected:** `[{name: "polling-watchdog", ...}]` が返る

- [ ] **Step 8: コミット**

```bash
git add background.js
git commit -m "feat: chrome.alarms watchdog で SW 再起動時の自己治癒経路を追加 (KIRI-146)"
```

---

## Task 5: SW 再起動シナリオの手動検証（最重要）

**目的:** 実装が当初の問題（SW idle terminate → 再起動時の `_lastTs` wipe + setInterval 消失）を解決していることを実機確認する。

**Files:** 変更なし（検証のみ）

- [ ] **Step 1: 通常動作の確認**

1. popup で `enabled=ON` にし、Slack に 1 件投稿
2. ページ上に表示されることを確認
3. SW DevTools コンソールで：

```js
await chrome.storage.local.get('_lastTs')
```

**Expected:** `{_lastTs: "1746...."}` が返る

```js
await chrome.alarms.getAll()
```

**Expected:** `[{name: "polling-watchdog", ...}]` が返る

- [ ] **Step 2: 手動 SW 停止 → 再起動で `_lastTs` と alarm が保持されることを確認（KIRI-146 のコア検証）**

1. `chrome://serviceworker-internals/` を開き、対象拡張の SW の「Stop」ボタンを押す
2. SW DevTools を再度開く（自動的に再起動する）
3. 新しいコンソールで：

```js
await chrome.storage.local.get('_lastTs')
```

**Expected（修正後）:** `{_lastTs: "1746...."}` が保持されている

```js
await chrome.alarms.getAll()
```

**Expected:** `[{name: "polling-watchdog", ...}]` が返る（再起動後も alarm は永続化されている）

4. Slack に新規投稿 → 3 秒以内に表示されることを確認（setInterval が復活している）

- [ ] **Step 3: setInterval が消えても alarm が復活させることを確認**

1. SW DevTools コンソールで以下を実行（手動で setInterval を破壊）：

```js
clearInterval(pollingTimer); pollingTimer = null;
```

2. Slack に投稿しても **3 秒以内には表示されない** ことを確認（setInterval が無効化されている証拠）
3. **最大 1 分待つ**
4. alarm が発火し、`pollingTimer === null` を検知して `startPolling()` が走り、メッセージが表示されることを確認
5. SW DevTools コンソールに `Slack Comment Overlay: watchdog reviving polling` のログが出ることを確認

- [ ] **Step 4: 設定変更時の挙動が従来通りであることを確認**

各シナリオで期待通りの動作になることを確認。一つでもズレていればここで実装を見直す。

1. **enabled OFF → ON**: 状態リセット後にポーリング再開、alarm 再作成
   - `await chrome.storage.local.get('_lastTs')` → 一時的に `{}`、その後新規取得で値が入る
   - `await chrome.alarms.getAll()` → 1 件
2. **enabled ON → OFF**: ポーリング停止、状態クリア、alarm 削除
   - `await chrome.storage.local.get('_lastTs')` → `{}`
   - `await chrome.alarms.getAll()` → `[]`
3. **channel 変更（enabled 中）**: 過去 ts は無効になり、新チャネルから取得開始
   - 旧 channel の `_lastTs` がリセットされ、新 channel の最新メッセージが流れ始める
4. **token 変更（enabled 中）**: lastTs 据え置きで継続
   - `_lastTs` が保持されたまま、新 token で API 呼び出しが続く

---

## Task 6: CLAUDE.md の MV3 SW ライフサイクル記述を更新

**目的:** ドキュメント（特にエージェントが参照する CLAUDE.md）を実装と整合させる。

**Files:**
- Modify: `CLAUDE.md`（「設計上の注意点」セクション）

- [ ] **Step 1: 現在の記述を確認**

```bash
grep -n "MV3 Service Worker" CLAUDE.md
```

「設計上の注意点」セクションの該当箇所を読む。現状の記述：

```
- **MV3 Service Worker のライフサイクル**: ワーカーは Chrome により随時終了・再起動される。`setInterval` は失われるため、`_lastTs` を storage に永続化して差分取得を維持している
```

- [ ] **Step 2: 該当箇所を以下に書き換え**

```
- **MV3 Service Worker のライフサイクル**: ワーカーは Chrome により随時終了・再起動される。対策として 2 段構え：
  - `setInterval(pollOnce, 3000)` で通常時の 3 秒間隔ポーリング
  - `chrome.alarms` を 1 分間隔の watchdog として並走させ、SW 再起動時に `pollingTimer === null` を検知して `startPolling()` で自己治癒
  - `_lastTs` は `chrome.storage.local` に永続化され、SW 再起動時も差分取得を維持。`startPolling()` は冒頭で `pausePolling()`（タイマー停止のみ）を呼び、`_lastTs` の wipe は `resetPollingState()`（無効化や channel 変更時のみ呼ばれる）に分離されている
```

- [ ] **Step 3: コミット**

```bash
git add CLAUDE.md
git commit -m "docs: KIRI-146 SW 再起動耐性に合わせて CLAUDE.md を更新"
```

---

## Task 7: 最終リグレッションテスト

**目的:** 全タスク完了後、KIRI-141 / KIRI-143 など以前の修正にデグレがないことを確認する。

**Files:** 変更なし（検証のみ）

- [ ] **Step 1: 通常運用シナリオ**

1. 拡張を再読み込み
2. `enabled=ON`、`mode=ticker` で Slack に複数件投稿 → ticker に表示
3. `mode=flow` に切替 → 旧 ticker 要素が消えて flow が動く（KIRI-141 の挙動）
4. `enabled=OFF` → 全要素消える、`enabled=ON` でゴーストが復活しない
5. token / channel 変更 → 期待通り再開

- [ ] **Step 2: 30 分放置シナリオ（時間に余裕があれば）**

1. `enabled=ON` の状態で 30 分放置（途中 Slack には何も投稿しない）
2. 30 分後に Slack に投稿
3. 1 分以内に表示されることを確認

このシナリオは時間がかかるため、急ぎでない場合のみ実施。Task 5 Step 2/3 の手動 SW 停止で同等の検証は済んでいる。

- [ ] **Step 3: 完了確認**

すべての Task のチェックボックスが埋まり、Task 5・Task 7 の手動検証で問題が出なければ実装完了。

---

## 補足: 後続作業

このプランの完了後、以下を別 issue / 別ブランチで検討する余地がある（本プランのスコープ外）：

- 拡張用の自動テスト基盤導入（`@web/test-runner` や `puppeteer` での E2E 等）
- watchdog の発火回数 / SW 再起動回数のメトリクス収集（運用観察用）
- `chrome.alarms` の最小周期制約を緩和する将来的な MV4 / Chrome 仕様変更への追従

これらは「めったに起きない問題への over-engineering」になるため、本 issue では明確に対象外とする。
