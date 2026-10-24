# ONSEI_LRN

PDFの内容を **自分の声で説明** し、間違っていればAIが「どこが・なぜ」違うかをテキストで返す学習アプリです。
正しく説明できるまで「説明 → フィードバック → 再説明」を繰り返し、正しく説明できた概念は **自分の言葉のまま** フラッシュカードになります。

## 流れ

1. **教材** で PDF を追加 → Claude がPDFを読み、説明すべき概念と要点を抽出
2. 概念を選び、**● 録音して説明する** を押して声で説明 → **説明を終えて判定する**
3. 間違いがあれば、引用・なぜ違うか・正しい理解・抜けている要点が表示される
4. フィードバックを踏まえてもう一度説明（過去の説明とフィードバックもAIに渡され、改善点も評価されます）
5. 正しく説明できたら、その時の言葉でフラッシュカードを作成（表 = 問い、裏 = あなたの説明）

その他の画面:

- **ボード**: 全概念を「未着手 / 学習中 / 習得」のカンバンで表示
- **カレンダー**: 日ごとの説明回数・習得数・カード復習数・復習予定、連続学習日数
- **復習**: Anki と同じ「答えを表示 → もう一度 / 難しい / 正解 / 簡単」（キーボード: Space, 1〜4）
- **カード**: 作成されたカードの編集・削除

見た目は Anki デスクトップ版の配色・フォント・余白に合わせています（ダークモード対応）。

## 起動（Claude Pro / Max プランで追加料金なし）

AIの判定は、自分のPCにインストールした **Claude Code**（Pro/Max プランに含まれる）を裏で呼び出して行います。API キーは不要です。

1. [Node.js](https://nodejs.org/) (v20 以上) をインストール
2. Claude Code をインストールして、Pro プランのアカウントでログイン
   ```bash
   npm install -g @anthropic-ai/claude-code
   claude        # 初回はブラウザでログイン。ログインできたら /exit で終了
   ```
3. このアプリを起動
   ```bash
   git clone https://github.com/ou1051/ONSEI_LRN.git
   cd ONSEI_LRN
   npm install
   npm start
   ```
4. Chrome で http://localhost:3000 を開く

起動ログに `AI: Claude Code（Proプランのログインを使用）` と出ていればOKです。
使った分は claude.ai と共通の Pro プランの利用上限から消費されます（上限に達したら数時間待つと回復）。
PDFが長いほど1回あたりの消費が大きくなります。

### Claude API（従量課金）で動かす場合

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm start
```
`ANTHROPIC_API_KEY` が設定されていると API が使われます。`ONSEI_PROVIDER=claude-code` で明示的に Claude Code 側に固定できます。

- 音声認識はブラウザの Web Speech API（`ja-JP`）を使います。**Chrome / Edge / Safari** で開いてください。マイク許可が必要で、`localhost` か HTTPS でのみ動作します。対応していないブラウザではテキスト入力で使えます。
- データは `data/`（`db.json` と PDF）に保存されます。

### 環境変数

| 変数 | 既定値 | 説明 |
|---|---|---|
| `ONSEI_PROVIDER` | 自動 | `claude-code`（Pro/Max プラン）または `api`。未指定なら API キーの有無で決定 |
| `ANTHROPIC_API_KEY` | – | Claude API キー（`api` のとき） |
| `PORT` | `3000` | ポート |
| `ONSEI_MODEL` | Claude Code の既定 / API は `claude-opus-5-5` | 使用モデル |
| `ONSEI_CLAUDE_BIN` | `claude` | Claude Code の実行ファイル |
| `ONSEI_EFFORT` | `medium` | 推論の深さ（API のみ） |
| `ONSEI_FALLBACKS` | `1` | `0` で拒否時のサーバー側フォールバックを無効化（API のみ） |
| `ONSEI_DATA_DIR` | `./data` | 保存先 |
| `ONSEI_MOCK` | – | `1` でAIを呼ばないモック動作（画面確認用） |

## 構成

- `server.js` — Express の API（PDF取り込み、説明の判定、カード、活動ログ）
- `lib/ai.js` — AI 呼び出し。Claude Code CLI (`claude -p`) または Claude API。どちらも構造化出力でJSONを受け取る
- `lib/srs.js` — Anki風の間隔反復スケジューラ
- `lib/db.js` — JSONファイルのストア
- `public/` — フロントエンド（ビルド不要の素のJS）
