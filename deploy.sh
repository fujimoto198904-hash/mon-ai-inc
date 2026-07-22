#!/bin/bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
CONF="$DIR/../collector/config.json"
URL=$(python3 -c "import json;print(json.load(open('$CONF'))['supabaseUrl'])")
KEY=$(python3 -c "import json;print(json.load(open('$CONF'))['supabaseAnonKey'])")
TOK=$(python3 -c "import json;print(json.load(open('$CONF'))['ingestToken'])")

upload() {
  local file="$1" ctype="$2"
  echo "upload: $file"
  curl -sf -X POST "$URL/storage/v1/object/ai-office/$file" \
    -H "Authorization: Bearer $KEY" \
    -H "apikey: $KEY" \
    -H "x-office-ingest: $TOK" \
    -H "Content-Type: $ctype" \
    -H "x-upsert: true" \
    --data-binary "@$DIR/$file" > /dev/null
}

upload index.html "text/html; charset=utf-8"
upload config.js "application/javascript; charset=utf-8"
upload app.js "application/javascript; charset=utf-8"
echo "done: $URL/storage/v1/object/public/ai-office/index.html"
