# モード切替・無効化時のクリーンアップ設計

- 作成日: 2026-04-24
- 関連 issue: [KIRI-141](https://linear.app/ivry/issue/KIRI-141)
- 起点 observation: [KIRI-140](https://linear.app/ivry/issue/KIRI-140)
- 対象リポジトリ: slack-comment-viewer

## 背景

Chrome 拡張 Slack Comment Viewer には 2 つの表示モード（ticker / flow）があるが、モード切替時と無効化時に旧モードの DOM 要素がクリーンアップされない。

- **ticker 要素**: `#sco-overlay` 配下に DOM として残る。FIFO で順次削除される設計だが、モード切替という横断的イベントをトリガとしない
- **flow 要素**: `document.body` 直下に残る。`animationend` による自己削除はあるが、`flowSpeed` 秒（デフォルト 8 秒）は画面に残り続ける
- **enabled: true → false 遷移**: overlay が `display: none` になるだけで DOM 上の ticker items は残存。再有効化時に過去のメッセージがゴーストとして復活する

### 問題の構造

単発の表示バグではなく、「自己削除機構を持たない表示方式には、外部トリガによるクリーンアップ経路が必要」という設計原則の欠落。現状：

| モード | 通常運用時のクリーンアップ | モード横断イベント対応 |
|--------|-----------------------------|-------------------------|
| ticker | FIFO（追加時に `maxItems` 超過分を削除） | ❌ なし |
| flow | `animationend` による自己削除 | ❌ なし（最大 `flowSpeed` 秒残る） |

## 目的・スコープ

### 対象

- **モード切替時（ticker ↔ flow）**: 両方向で旧モードの表示要素を即時クリーンアップ
- **無効化時（enabled: true → false）**: すべての表示要素をクリーンアップ

### 非対象（本 issue のスコープ外）

- `seenTs` セットのクリア（重複排除記録。Slack API 再送時の再表示を避けるため保持）
- モード抽象化（`TICKER.cleanup()` / `FLOW.cleanup()` のようなモジュール分割）。将来 3 つ目のモードが追加される時点で再検討
- 位置・フォントサイズ・`maxItems`・`opacity` などの通常設定変更時の挙動（現状通り、要素を保持）

### 成功条件

1. ticker 表示中 → flow に切替 → 旧 ticker 要素が **即座に** DOM から消える
2. flow 表示中 → ticker に切替 → 流れている flow 要素が **即座に** DOM から消える
3. enabled: true → false の遷移で、すべての ticker/flow 要素が即座に消える
4. 再有効化（false → true）後、過去のメッセージが復活しない
5. 既存の通常運用時のライフサイクル（FIFO、animationend）は壊れない
6. 他の設定変更（`position`, `fontSize`, `opacity`, `maxItems`）で表示中の要素が意図せず消えない

## 設計方針

**「完全リセット」方針**を採用する。モード切替・無効化は両モードの表示要素を即時クリアするイベントとして扱う。

理由:
- observation で示された「自己削除機構の非対称性」を、方向依存なく一貫して解消できる
- enabled→false と mode 切替で挙動の整合性を取りやすい（どちらも「状態のリセット」として扱える）
- ユーザーの認知モデルとしても、モード切替 = 画面の切り替わり、という期待に沿う

「スムーズ遷移（flow 要素は自然消滅に任せる）」方針は、整合性の取りづらい分岐を生むため採用しない。

## 実装

### 対象ファイル

- `content.js` のみ

`content.css`、`background.js`、`popup.js` は無変更。

### 追加する関数: `clearAllDisplayElements()`

```js
function clearAllDisplayElements() {
  // 1. Ticker items: #sco-ticker-list の子要素すべて
  if (tickerListEl) {
    tickerListEl.replaceChildren();
  }

  // 2. Flow items: document.body 直下の .sco-flow-item すべて
  for (const el of document.querySelectorAll(".sco-flow-item")) {
    el.remove();
  }

  // 3. Flow レーン占有記録をリセット
  laneNextAvailable.fill(0);
}
```

**設計判断**:

| 項目 | 判断 | 理由 |
|------|------|------|
| `tickerListEl` の null ガード | あり | `createOverlay()` 前に呼ばれうる（enabled が false のまま保存されるケース等） |
| `replaceChildren()` を使用 | 採用 | `while` ループより意図が明瞭。空配列呼び出しで全削除が一行で済む |
| `.sco-flow-item` を `document` 全体から取得 | 採用 | 設計上は body 直下だが、将来の位置変更に備えて `querySelectorAll` でグローバル取得 |
| `laneNextAvailable.fill(0)` を含める | 採用 | flow→ticker→flow と戻った場合、古いレーン占有記録で初動のレーン選択が歪む |
| `seenTs` は触らない | 採用 | Slack 側の再送時に同一メッセージが再表示される可能性があり、別関心事として分離 |

### 変更する関数: `chrome.storage.onChanged` ハンドラ

**現状（`content.js:136-144`）**:

```js
chrome.storage.onChanged.addListener((changes) => {
  for (const [key, { newValue }] of Object.entries(changes)) {
    if (key in currentSettings) {
      currentSettings[key] = newValue;
    }
  }
  if (currentSettings.enabled) createOverlay();
  applySettings();
});
```

**変更後**:

```js
chrome.storage.onChanged.addListener((changes) => {
  const modeChanged = changes.mode
    && changes.mode.oldValue !== changes.mode.newValue;
  const disabledTransition = changes.enabled
    && changes.enabled.oldValue === true
    && changes.enabled.newValue === false;

  for (const [key, { newValue }] of Object.entries(changes)) {
    if (key in currentSettings) {
      currentSettings[key] = newValue;
    }
  }

  if (modeChanged || disabledTransition) {
    clearAllDisplayElements();
  }

  if (currentSettings.enabled) createOverlay();
  applySettings();
});
```

### トリガ条件

| 変化 | `clearAllDisplayElements()` を呼ぶ | 理由 |
|------|:--:|------|
| `mode` の値が変わった | ✅ | 本 issue 主題。旧モードの表示要素を除去 |
| `enabled: true → false` | ✅ | 無効化時スコープ。`applySettings` だけでは overlay が非表示になるだけで DOM が残り、再有効化時にゴースト出現 |
| `enabled: false → true` | ❌ | 初期状態。クリアするものがない |
| `position` / `opacity` / `fontSize` / `maxItems` 等の変化 | ❌ | 既存要素を保持したまま見た目だけ更新 |

### 判定ロジックの設計根拠

- **`changes.mode` の存在 + `oldValue !== newValue`**: `chrome.storage.onChanged` は同値 `set` でも通知を飛ばす実装がありうるため、真の値変化を厳密に判定
- **`disabledTransition` を方向付き判定**: `oldValue === true && newValue === false` の厳格比較で、初回ロード時の `undefined → false` を対象外にする（不要な DOM 操作を避ける）
- **処理順序**: `currentSettings` 更新 → `clearAllDisplayElements()` → `createOverlay()` → `applySettings()`。クリア後に `createOverlay` で overlay を保証し、`applySettings` で最終表示状態を決める

### エラーハンドリング

本設計に例外を投げる操作は含まれない。

| 操作 | リスク | 対応 |
|------|--------|-----|
| `tickerListEl.replaceChildren()` | `tickerListEl` が null | null ガード |
| `document.querySelectorAll` | 要素ゼロでもエラーなし | ループがスキップされるだけ |
| `changes.mode.oldValue !== changes.mode.newValue` | `undefined` の初回通知 | 真と評価されるが副作用は「空 DOM をクリア」で実害なし |

## 確認戦略

本リポジトリには自動テスト基盤がない。Chrome 拡張の特性上 E2E 自動化も大掛かりになるため、**手動動作確認マトリクス**で検証する。

### 確認シナリオ

| # | シナリオ | 期待挙動 |
|---|---------|---------|
| 1 | ticker でメッセージ表示 → mode を flow に変更 | 旧 ticker 要素が即座に消える。flow は新着から表示開始 |
| 2 | flow でメッセージ流し中 → mode を ticker に変更 | 流れ中の flow 要素が即座に消える。ticker は新着から表示 |
| 3 | ticker→flow→ticker と往復して新メッセージ到着 | flow のレーン選択が歪まない（`laneNextAvailable` リセット確認） |
| 4 | enabled=true で表示中 → enabled を false | 全要素消滅。overlay が非表示 |
| 5 | enabled=false→true、その後に新メッセージ | 新メッセージのみ表示（過去のゴーストなし） |
| 6 | ticker 表示中に `position` を left/right 切替 | 要素は保持、位置のみ変わる |
| 7 | ticker 表示中に `fontSize`/`opacity`/`maxItems` 変更 | 要素は保持、スタイルのみ変わる |
| 8 | ticker 表示中、新メッセージ到着（同一モード内） | FIFO が従来通り動作。maxItems 超過で最古が消える |
| 9 | flow 表示中、新メッセージ到着（同一モード内） | animationend の自己削除が従来通り動作 |

### 確認環境

- Chrome「パッケージ化されていない拡張機能を読み込む」でこのリポジトリを読み込み
- 任意の Slack チャネルに連携（bot token と channel ID を popup で設定）
- DevTools コンソールで `document.querySelectorAll('.sco-ticker-item, .sco-flow-item').length` を観測し、要素残存数を検証

## 今後に残す課題（本 issue の対象外）

- **モード抽象化**: 3 つ目の表示モード（例: toast）を追加する際、各モードに `init` / `render` / `cleanup` を持つモジュール構造へのリファクタを検討する
- **`seenTs` の長時間セッションでの蓄積**: セット構造のため実害は小さいが、メモリ使用量は単調増加する
- **`_lastTs` とメッセージキャッシュの関係**: 無効化→有効化の間に蓄積された Slack メッセージの扱い（現状は `stopPolling` で `_lastTs` がクリアされ、再開後の初回は直近 30 秒のみを取得）
