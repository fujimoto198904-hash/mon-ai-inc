# GPT生成ポートレートの入れ方

ChatGPTの会話「画像生成リクエスト」(2026-07-22)に monai_assets.zip が用意済み。

1. その会話で「monai_assets.zip をダウンロード」をクリック
2. zipを展開して claude.png / codex.png / koen.png / tsuki.png / short.png / watcher.png / mon.png を このassets/ に置く
3. `bash ../deploy.sh "add portraits"` を実行

置くだけで社員名簿の顔がドット絵ポートレートに自動で切り替わる(無くても既定の顔で動く)。
