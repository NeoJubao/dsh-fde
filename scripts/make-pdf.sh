#!/usr/bin/env bash
# Markdown -> 正式排版 PDF（中文 A4）
# 用法: bash make-pdf.sh <input.md> [output.pdf]
#
# ⚠️ 按需使用：默认交付格式是 md；仅在需要打印/递交时才导出 PDF。
set -euo pipefail

SRC="${1:?用法: bash make-pdf.sh <input.md> [output.pdf]}"
DIR="$(cd "$(dirname "$0")" && pwd)"

if [ ! -f "$SRC" ]; then echo "找不到文件: $SRC" >&2; exit 1; fi

# 默认输出到同级 exports/ 子目录（md 为主格式，PDF 为按需产物）
if [ -n "${2:-}" ]; then
  OUT="$2"
else
  BASE="$(basename "${SRC%.md}").pdf"
  OUTDIR="$(dirname "$SRC")/exports"
  mkdir -p "$OUTDIR"
  OUT="$OUTDIR/$BASE"
fi
TMP_HTML="$(mktemp -t md2html).html"

echo "① 生成 HTML ..."
python3 "$DIR/md2html.py" "$SRC" "$TMP_HTML"

echo "② 渲染 PDF ..."
if command -v weasyprint >/dev/null 2>&1; then
  weasyprint "$TMP_HTML" "$OUT"
else
  echo "未找到 weasyprint，请先安装：pip3 install weasyprint" >&2; exit 1
fi

echo "③ 版面自检 ..."
PAGES="$(pdfinfo "$OUT" 2>/dev/null | awk '/^Pages/{print $2}')"
SIZE="$(pdfinfo "$OUT" 2>/dev/null | awk -F': *' '/^Page size/{print $2}')"
pdftotext -layout "$OUT" "${TMP_HTML%.html}.txt" 2>/dev/null || true
TXT="${TMP_HTML%.html}.txt"
ORPHAN=0; SPLIT=0; MISSING="no"
if [ -f "$TXT" ]; then
  ORPHAN="$(grep -cE '^[[:space:]]*[一-龥]{1,2}[[:space:]]*$' "$TXT" || true)"
  SPLIT="$(grep -cE '响应缺[[:space:]]*$|建设内[[:space:]]*$|数据前[[:space:]]*$' "$TXT" || true)"
  grep -q '□' "$TXT" && MISSING="YES" || true
fi

echo "   页数: ${PAGES:-?}   规格: ${SIZE:-?}"
echo "   孤行: ${ORPHAN}（应为 0）  拆标签: ${SPLIT}（应为 0）  缺字: ${MISSING}（应为 no）"
echo "输出: $OUT"
rm -f "$TMP_HTML" "$TXT"
