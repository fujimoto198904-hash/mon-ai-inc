# MON-AI Inc. AI社員オフィス ダッシュボード

AI社員(Claude Code / Codex / 自動ルーチン)の稼働・使用量・課金をドット絵オフィスで可視化する。

- データ: **GitHub `mon-ai-inc` の `data` ブランチ**(`data/snapshot.json` / `history.json` / `public.json`)。
  5分ごとにMacのコレクターが Contents API で push し、表示側は `raw.githubusercontent.com` から読む
  (`config.js` の `dataBase`)。**2026-08-09にSupabaseを廃止**した(03_DECISIONS §12・プロジェクト消失で20時間停止したため)。
  履歴の実体はMac側の `collector/history.jsonl`
- 表示: GitHub Pages(このリポジトリ)。**Pagesは `main` しかビルドしない**ので、5分毎のデータpushを `data` ブランチに逃がしてビルド上限(1時間10回)を避けている
- 閲覧: URL末尾に `#v=閲覧トークン` が必要。**ただしこれは画面のゲートであってセキュリティではない** —
  RLSが無くなり `data/*.json` は認証なしで読める。出してよいかの判断は掲載台帳ゲート(collector側)が持つ

運用の正典: Project-T/ツール/ai-office/README.md
