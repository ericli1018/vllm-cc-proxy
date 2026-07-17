#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

node --version
node --check vllm-cc-proxy.js
node --test

node -e "JSON.parse(require('node:fs').readFileSync('package.json','utf8')); console.log('package.json: ok')"

echo "verification: ok"
