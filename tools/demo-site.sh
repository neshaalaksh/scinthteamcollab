#!/usr/bin/env bash
# Builds the hosted demo website into a folder (default: ./demo-site, which git ignores).
#
#   tools/demo-site.sh [out-dir]
#
# The demo website is the normal app in demo mode, with three differences for hosts that
# don't allow running fetched code, embedding other sites, printing or downloads:
#   * config.js: no Supabase (demo mode) and demoSite: true (embeds show as links; Print,
#     Download and Copy link are hidden)
#   * backend/code-demo.js: the demo backend (backend/Code.gs) wrapped as a plain script
#   * index.html: just the page's content (the host adds <html>, <head> and <body>)
set -euo pipefail
cd "$(dirname "$0")/.."
out="${1:-demo-site}"
rm -rf "$out"
mkdir -p "$out/backend" "$out/vendor"
cp -r css js "$out/"
cp vendor/marked.min.js vendor/purify.min.js vendor/editor.bundle.js "$out/vendor/"

sed -i -e "s#supabaseUrl: '[^']*'#supabaseUrl: ''#" -e "s#demoSite: false#demoSite: true#" "$out/js/config.js"
grep -q "demoSite: true" "$out/js/config.js" || { echo "config.js: couldn't switch on demoSite" >&2; exit 1; }

{
  echo "// Built from backend/Code.gs by tools/demo-site.sh: the demo backend as a plain script (no eval)."
  echo "window.TeamspaceBackend = function (DEMO_MODE, SpreadsheetApp, LockService, CacheService, PropertiesService, ContentService, UrlFetchApp, Utilities) {"
  cat backend/Code.gs
  echo "return { handle: handle, ensureSchema: ensureSchema, SCHEMA: SCHEMA };"
  echo "};"
} > "$out/backend/code-demo.js"

python3 - "$out/index.html" <<'EOF'
import re, sys
src = open('index.html').read()
head = re.search(r'<head>(.*?)</head>', src, re.S).group(1)
body = re.search(r'<body>(.*?)</body>', src, re.S).group(1)
head = re.sub(r'\s*<meta charset[^>]*>|\s*<meta name="viewport"[^>]*>', '', head)
head = head.replace('<title>Teamspace</title>', '<title>Scinth Team Demo</title>')
open(sys.argv[1], 'w').write(head.strip() + '\n' + body.strip() + '\n')
EOF
echo "Built $out"
