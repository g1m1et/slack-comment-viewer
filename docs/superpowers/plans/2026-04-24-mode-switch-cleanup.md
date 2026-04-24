# モード切替・無効化時のクリーンアップ実装プラン

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ticker↔flow モード切替時と enabled: true→false 遷移時に、旧モードの表示要素を DOM から即時クリーンアップする。

**Architecture:** `content.js` に `clearAllDisplayElements()` 関数を 1 つ追加し、`chrome.storage.onChanged` ハンドラに変化検知ロジックを追加する。両モードの要素（ticker は `#sco-ticker-list` の子、flow は `document.body` 直下の `.sco-flow-item`）と flow のレーン占有記録を一括クリアする「完全リセット」方針。

**Tech Stack:** Vanilla JavaScript、Chrome Extension MV3、`chrome.storage.local`、`chrome.storage.onChanged`、DOM API。

**Spec:** `docs/superpowers/specs/2026-04-24-mode-switch-cleanup-design.md`

**関連 issue:** KIRI-141（起点 observation: KIRI-140）

## 前提

- 本リポジトリには自動テスト基盤がない。検証は Chrome での手動動作確認で行う
- ビルドプロセスはない。`content.js` を編集したら Chrome の拡張管理画面で「更新」ボタンを押すだけで反映される
- Slack Bot Token と channel ID が popup で設定済みで、任意の Slack チャネルでメッセージが送受信できる状態で検証する
- 検証は DevTools コンソール（対象タブ上で F12）で `document.querySelectorAll('.sco-ticker-item, .sco-flow-item').length` を観測することで要素残存を定量確認する

## File Structure

- **Modify:** `content.js`
  - 関数追加: `clearAllDisplayElements()`（`renderFlowMessage` の直後、`handleNewMessages` の前に配置）
  - ハンドラ変更: `chrome.storage.onChanged.addListener`（現状 136-144 行目）

他ファイル（`content.css`、`background.js`、`popup.js`、`manifest.json`）は無変更。

---

## Task 1: バグの再現（ベースライン確認）

**目的:** 実装前に現状の不具合挙動を再現し、実装後の比較基準を確立する。TDD の「red」相当。

**Files:** 変更なし（観察のみ）

- [ ] **Step 1: 現在のブランチの `content.js` を Chrome に読み込む**

1. `chrome://extensions` を開く
2. 拡張「Slack Comment Viewer」の「更新」ボタンを押す（または未読み込みなら「パッケージ化されていない拡張機能を読み込む」でこのディレクトリを指定）
3. 拡張がエラーなく読み込まれることを確認

- [ ] **Step 2: ticker→flow 切替時のバグを再現**

1. 任意のページ（例: google.com）を開く
2. 拡張の popup を開き、`enabled=ON`、`mode=ticker` に設定
3. 連携中の Slack チャネルに 2〜3 件メッセージを投稿（ticker に表示されるのを待つ）
4. popup で `mode=flow` に切り替える
5. ページ右下（または左下）を観察

**Expected（バグ挙動）:** 旧 ticker 要素が画面に残留し続ける。DevTools コンソールで `document.querySelectorAll('.sco-ticker-item').length` を実行し **2 以上** が返ることを確認。

- [ ] **Step 3: enabled=false 遷移時のバグを再現**

1. `mode=ticker` に戻して、Slack に 2〜3 件メッセージを投稿
2. ticker に表示されたら、popup で `enabled=OFF` に切り替える
3. overlay は視覚的に消えているが、DevTools で `document.querySelectorAll('.sco-ticker-item').length` を実行

**Expected（バグ挙動）:** **2 以上** が返る（DOM 上に残っている）。さらに popup で `enabled=ON` に戻すと、古いメッセージが再び画面に出現する（ゴースト）。

- [ ] **Step 4: ベースライン記録**

以下をメモ（実装後の Task 3 で比較する）:
- Step 2 時点の ticker 要素残存数
- Step 3 時点の ticker 要素残存数
- ゴースト復活の再現性（Yes/No）

---

## Task 2: `clearAllDisplayElements()` の追加と `storage.onChanged` への接続

**Files:**
- Modify: `content.js`（関数追加: 行 100 直後、ハンドラ変更: 行 136-144）

- [ ] **Step 1: `clearAllDisplayElements()` 関数を追加**

`content.js` の `renderFlowMessage` 関数の直後（現在の行 100 の閉じ括弧 `}` の後）に以下を挿入する。具体的には `function handleNewMessages(messages) {` の直前。

```js
function clearAllDisplayElements() {
  // Ticker items: #sco-ticker-list の子要素すべて
  if (tickerListEl) {
    tickerListEl.replaceChildren();
  }

  // Flow items: document.body 直下の .sco-flow-item すべて
  for (const el of document.querySelectorAll(".sco-flow-item")) {
    el.remove();
  }

  // Flow レーン占有記録をリセット
  laneNextAvailable.fill(0);
}
```

- [ ] **Step 2: `chrome.storage.onChanged` ハンドラを書き換え**

現状のハンドラ（行 136-144）:

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

を以下に置き換える:

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

- [ ] **Step 3: シンタックスエラーなく拡張が再読み込みできることを確認**

1. `chrome://extensions` で拡張の「更新」ボタンを押す
2. エラーバッジが表示されていないことを確認
3. `chrome://extensions` → Service Worker の「検証」リンクから background.js のコンソールを開き、エラーがないことを確認
4. 任意のタブで DevTools を開き、コンソールに `content.js` 由来のエラーがないことを確認

**Expected:** エラーなく再読み込みされる。

---

## Task 3: 手動動作確認マトリクス

**Files:** 変更なし（検証のみ）

すべての確認で、対象ページの DevTools コンソールを開いた状態で実施する。要素残存数の検証は `document.querySelectorAll('.sco-ticker-item, .sco-flow-item').length` を使う。

- [ ] **Step 1: シナリオ 1 - ticker→flow 切替で旧 ticker が消える**

1. popup で `enabled=ON`、`mode=ticker` に設定
2. Slack に 3 件メッセージを投稿（ticker に表示を確認）
3. コンソールで `document.querySelectorAll('.sco-ticker-item').length` を実行 → **3** が返ることを確認
4. popup で `mode=flow` に切り替え
5. コンソールで再度実行 → **0** が返ることを確認

**Expected:** 旧 ticker 要素が即座に DOM から消える。

- [ ] **Step 2: シナリオ 2 - flow→ticker 切替で旧 flow が消える**

1. popup で `mode=flow` のまま、Slack に 3 件メッセージを投稿（画面を流れているのを視認）
2. コンソールで `document.querySelectorAll('.sco-flow-item').length` を実行 → **1 以上** が返ることを確認（流れ中）
3. popup で `mode=ticker` に切り替え
4. コンソールで再度実行 → **0** が返ることを確認

**Expected:** 流れ中の flow 要素が即座に DOM から消える。

- [ ] **Step 3: シナリオ 3 - ticker→flow→ticker 往復後のレーン挙動**

1. popup で `mode=flow`、Slack に 3 件メッセージを投稿（流れを確認）
2. popup で `mode=ticker` に切替、さらに `mode=flow` に切替
3. Slack に 1 件メッセージを投稿
4. 新メッセージがどのレーンから出てくるか観察

**Expected:** レーン 0（最上段）から出てくる。`laneNextAvailable` がリセットされているため、全レーンが空として扱われ最初のレーンが選択される。

- [ ] **Step 4: シナリオ 4 - enabled=false で全要素消滅**

1. popup で `enabled=ON`、`mode=ticker`、Slack に 3 件メッセージを投稿
2. コンソールで `document.querySelectorAll('.sco-ticker-item').length` を実行 → **3** を確認
3. popup で `enabled=OFF` に切り替え
4. コンソールで再度実行 → **0** が返ることを確認

**Expected:** 全 ticker 要素が即座に DOM から消える。overlay も非表示。

- [ ] **Step 5: シナリオ 5 - 再有効化後のゴーストなし**

1. Step 4 の直後（enabled=OFF の状態）から続行
2. popup で `enabled=ON` に切り替え
3. この時点でコンソール実行 → **0** を確認（過去メッセージが復活しない）
4. Slack に 1 件新メッセージを投稿
5. コンソール実行 → **1** を確認

**Expected:** 過去のゴーストなく、新メッセージのみが表示される。

- [ ] **Step 6: シナリオ 6 - position 変更で要素は保持（regression）**

1. popup で `enabled=ON`、`mode=ticker`、Slack に 2 件メッセージを投稿
2. コンソール実行 → **2** を確認
3. popup で `position` を `left` に切り替え
4. コンソール実行 → **2** のまま（要素は保持されている）を確認
5. 画面上、overlay が左下に移動していることを目視確認

**Expected:** 要素は保持、位置のみ変わる。

- [ ] **Step 7: シナリオ 7 - fontSize/opacity/maxItems 変更で要素は保持（regression）**

1. popup で `enabled=ON`、`mode=ticker`、Slack に 2 件メッセージを投稿
2. popup で `fontSize` を 18 に変更 → 要素数は 2 のまま、文字が大きくなることを確認
3. `opacity` を 0.5 に変更 → 要素数は 2 のまま、半透明になることを確認
4. `maxItems` を 3 に変更 → 要素数は 2 のまま（上限を超えていない）を確認

**Expected:** 要素は保持、スタイルのみ変わる。

- [ ] **Step 8: シナリオ 8 - 同一モード内の FIFO（regression）**

1. popup で `enabled=ON`、`mode=ticker`、`maxItems=3` に設定
2. Slack に 5 件メッセージを連続投稿
3. 投稿が終わったらコンソール実行 → **3** が返ることを確認
4. 最新 3 件のみが表示されていることを目視確認（古い 2 件が FIFO で削除されている）

**Expected:** FIFO が従来通り動作。

- [ ] **Step 9: シナリオ 9 - flow 自己削除（regression）**

1. popup で `mode=flow`、`flowSpeed=4` に設定
2. Slack に 1 件メッセージを投稿、画面を流れ始めるのを確認
3. コンソールで `document.querySelectorAll('.sco-flow-item').length` を実行 → **1** を確認
4. 4 秒待つ（flowSpeed 秒後に自己削除されるはず）
5. コンソール実行 → **0** を確認

**Expected:** animationend による自己削除が従来通り動作。

- [ ] **Step 10: 全シナリオ OK の場合のみコミット**

すべてのシナリオで Expected 挙動を確認できた場合、以下のコマンドでコミットする:

```bash
git add content.js
git commit -m "$(cat <<'EOF'
fix: モード切替・無効化時に表示要素をクリーンアップ

KIRI-141 の対応。旧モードの ticker/flow 要素と flow レーン占有記録を
一括クリアする clearAllDisplayElements() を追加し、storage.onChanged で
mode 変化と enabled: true→false 遷移を検知して呼び出す。

設計: docs/superpowers/specs/2026-04-24-mode-switch-cleanup-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

シナリオで期待と異なる挙動があった場合は commit せず、Task 2 に戻って原因を特定し修正する。

---

## Task 4: 完了処理

- [ ] **Step 1: このプランを docs/superpowers/plans にコミット**

```bash
git add docs/superpowers/plans/2026-04-24-mode-switch-cleanup.md
git commit -m "$(cat <<'EOF'
docs: モード切替・無効化時のクリーンアップ実装プランを追加

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

（プラン作成時にまとめて commit 済みなら本ステップはスキップ可）

- [ ] **Step 2: Linear KIRI-141 に作業完了コメント投稿（ユーザー承認後）**

作業完了後、以下のテンプレートでユーザーに Linear コメント投稿を提案する:

```markdown
## モード切替・無効化時のクリーンアップ実装

**背景**: observation KIRI-140 で検出された「自己削除機構を持たない表示方式に外部トリガが必要」という設計原則の欠落に対応。

**実施内容**:
- `content.js` に `clearAllDisplayElements()` を追加（ticker/flow 要素と flow レーン占有記録を一括クリア）
- `chrome.storage.onChanged` ハンドラで mode 変化と enabled: true→false 遷移を検知してクリアを発火
- スコープを当初の「mode 切替のみ」から「mode 切替 + 無効化遷移」に拡張

**成果**:
- 設計: `docs/superpowers/specs/2026-04-24-mode-switch-cleanup-design.md`
- 実装プラン: `docs/superpowers/plans/2026-04-24-mode-switch-cleanup.md`
- 実装: `content.js`（コミット `<commit-hash>`）
- 手動動作確認マトリクス 9 シナリオすべて合格

**備考**: モード抽象化（`TICKER.cleanup()` / `FLOW.cleanup()` のモジュール化）は 3 つ目のモードが追加される時点で再検討する。`seenTs` の長期蓄積は別 observation として切り出す可能性あり。
```

---

## 実装上の注意

- Chrome 拡張の更新は「更新」ボタンで即座に反映されるが、**content script は対象タブに再注入されない**場合がある。動作確認時は対象タブをリロード（F5）してから実施する
- `laneNextAvailable.fill(0)` は既存の配列を mutate する（再代入ではない）。他所の参照を壊さない
- `replaceChildren()` は Chrome 86+ で利用可能。本拡張の `manifest.json` の `minimum_chrome_version` は明示されていないが、MV3 拡張は Chrome 88+ が必要なので問題なし
- `changes.mode.oldValue` や `changes.enabled.oldValue` は `chrome.storage` の仕様上、初回書き込み時に `undefined` となる。プラン中の判定はこれを考慮して厳格比較（`=== true` など）を使っている
