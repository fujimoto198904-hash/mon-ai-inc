#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
git add -A
git commit -m "${1:-update dashboard}" || true
git push origin main
echo "deployed: https://fujimoto198904-hash.github.io/mon-ai-inc/"
