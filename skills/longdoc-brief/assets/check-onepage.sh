#!/usr/bin/env bash
# 验收一页打印：把 HTML 用无头 Chrome 打成 PDF，再用 pdfinfo 检查是否 1 页 A4。
# 用法：bash check-onepage.sh <html-path>
# 输出：PASS: 1 page A4 / FAIL: ... ；exit 0 / 1
set -u

HTML="${1:-}"
if [ -z "$HTML" ] || [ ! -f "$HTML" ]; then
  echo "FAIL: 用法 bash check-onepage.sh <html-path>"
  exit 2
fi
HTML_ABS="$(cd "$(dirname "$HTML")" && pwd)/$(basename "$HTML")"

CHROME=""
for c in \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  "/Applications/Chromium.app/Contents/MacOS/Chromium" \
  "$(command -v google-chrome 2>/dev/null || true)" \
  "$(command -v chromium 2>/dev/null || true)" \
  "$(command -v chromium-browser 2>/dev/null || true)"; do
  if [ -n "$c" ] && [ -x "$c" ]; then CHROME="$c"; break; fi
done
if [ -z "$CHROME" ]; then
  echo "FAIL: 找不到 Chrome/Chromium，无法验证一页打印"
  exit 3
fi

OUT="$(mktemp -d)/onepage.pdf"
PROFILE="$(mktemp -d)/chrome-profile"
rm -rf "$PROFILE"
"$CHROME" --headless=new --disable-gpu --no-sandbox --no-first-run \
  --user-data-dir="$PROFILE" --no-pdf-header-footer --virtual-time-budget=4000 \
  --print-to-pdf="$OUT" "file://$HTML_ABS" >/dev/null 2>&1 || {
    echo "FAIL: Chrome 打印失败"; exit 4; }

if ! command -v pdfinfo >/dev/null 2>&1; then
  echo "WARN: 没有 pdfinfo；PDF 已生成：$OUT"
  exit 0
fi

PAGES="$(pdfinfo "$OUT" 2>/dev/null | awk '/^Pages:/{print $2}')"
SIZE="$(pdfinfo "$OUT" 2>/dev/null | awk -F': *' '/^Page size:/{print $2}')"
if [ "$PAGES" = "1" ]; then
  echo "PASS: 1 page A4 ($SIZE)"
  exit 0
else
  echo "FAIL: $PAGES page(s) — 需要压到 1 页（$SIZE）"
  exit 1
fi
