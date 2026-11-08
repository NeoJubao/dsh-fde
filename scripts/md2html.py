#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""markdown -> styled HTML for PDF export (Chinese formal report).

Table rules (v2, fixes CJK label wrapping):
- first column is treated as a LABEL column: nowrap when the label is short,
  fixed comfortable width, no justification;
- body cells are left-aligned (justify is what caused mid-word CJK breaks);
- no width:1% shrink hacks.
"""
import re, sys, html, pathlib

SRC, OUT_HTML = sys.argv[1], sys.argv[2]
md = pathlib.Path(SRC).read_text(encoding="utf-8")

LABEL_NOWRAP_MAX = 12   # CJK chars: first-column labels up to this length never wrap

def tidy_list_item(s):
    """A trailing Chinese semicolon on a definition list item can wrap onto a
    line of its own (visual orphan). Convert to a full stop when the item is a
    self-contained definition, which reads better in print."""
    if s.rstrip().endswith(("；", ";")):
        return s.rstrip()[:-1].rstrip() + "。"
    return s

def inline(s):
    s = html.escape(s, quote=False)
    s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"(?<!\*)\*([^*\n]+?)\*(?!\*)", r"<em>\1</em>", s)
    s = re.sub(r"`([^`]+?)`", r"<code>\1</code>", s)
    return s

def plain(s):
    return re.sub(r"<[^>]+>", "", s).strip()

def build_table(header, rows):
    """Emit a table; first column = label column.

    Three shapes:
      lbl-table  : all first-column labels short  -> nowrap, auto width
      wide-table : first column holds long text   -> generous min width so
                   document names / long phrases don't break character-by-character
      kv-table   : mixed                          -> modest fixed width
    """
    firsts = [plain(inline(r[0])) for r in rows if r]
    maxlen = max((len(x) for x in firsts), default=0)
    if firsts and maxlen <= LABEL_NOWRAP_MAX:
        cls, nowrap = ' class="lbl-table"', True
    elif maxlen >= 20:
        cls, nowrap = ' class="wide-table"', False
    else:
        cls, nowrap = ' class="kv-table"', False

    # ---- content-aware column widths -------------------------------------
    # CJK wraps at any character, so a column given too little width ends up
    # with a single trailing character on its own line. Size columns by the
    # square root of their maximum content length (weighted), which keeps the
    # proportional feel but never starves a column.
    ncols = len(header)
    maxw = []
    for c in range(ncols):
        lens = [len(plain(inline(header[c])))]
        lens += [len(plain(inline(r[c]))) for r in rows if c < len(r)]
        maxw.append(max(lens) if lens else 1)
    # exponent > 0.5 keeps longer columns proportionally wider, which avoids
    # the "last character wraps to its own line" effect in the middle columns
    weight = [w ** 0.65 for w in maxw]
    total = sum(weight) or 1.0
    widths = [w / total * 100 for w in weight]
    # keep the first column above a readable floor for label tables
    if nowrap and widths[0] < 12:
        deficit = 12 - widths[0]
        widths[0] = 12
        rest = sum(widths[1:]) or 1.0
        widths[1:] = [w - deficit * (w / rest) for w in widths[1:]]

    # breathing room: CJK wraps on every character, so give each column a
    # little slack over its nominal share and renormalise
    slack = 1.12
    widths = [w * slack for w in widths]
    tot2 = sum(widths) or 1.0
    widths = [w / tot2 * 100 for w in widths]

    colgroup = "".join('<col style="width:%.1f%%">' % w for w in widths)

    t = ["<table%s><colgroup>%s</colgroup><thead><tr>" % (cls, colgroup)]
    for c in header:
        t.append("<th>%s</th>" % inline(c))
    t.append("</tr></thead><tbody>")
    for r in rows:
        t.append("<tr>")
        for idx, c in enumerate(r):
            if idx == 0 and nowrap:
                t.append('<td class="lbl">%s</td>' % inline(c))
            else:
                t.append("<td>%s</td>" % inline(c))
        t.append("</tr>")
    t.append("</tbody></table>")
    return "".join(t)

lines = md.split("\n")
out, i, N = [], 0, len(lines)
while i < N:
    s = lines[i].strip()

    if s.startswith("```"):
        i += 1
        buf = []
        while i < N and not lines[i].strip().startswith("```"):
            buf.append(lines[i]); i += 1
        i += 1
        out.append('<pre class="diagram">' + html.escape("\n".join(buf)) + "</pre>")
        continue

    if re.fullmatch(r"-{3,}", s):
        out.append('<hr class="rule">'); i += 1; continue

    m = re.match(r"^(#{1,6})\s+(.*)$", s)
    if m:
        lvl = len(m.group(1))
        out.append("<h%d>%s</h%d>" % (lvl, inline(m.group(2)), lvl)); i += 1; continue

    if s.startswith("|") and i + 1 < N and re.match(r"^\|[\s:|-]+\|$", lines[i + 1].strip()):
        header = [c.strip() for c in s.strip("|").split("|")]
        i += 2
        rows = []
        while i < N and lines[i].strip().startswith("|"):
            rows.append([c.strip() for c in lines[i].strip().strip("|").split("|")])
            i += 1
        out.append(build_table(header, rows)); continue

    if s.startswith(">"):
        buf = []
        while i < N and lines[i].strip().startswith(">"):
            buf.append(lines[i].strip().lstrip(">").strip()); i += 1
        out.append("<blockquote>%s</blockquote>" % "<br>".join(inline(x) for x in buf)); continue

    if re.match(r"^\d+\.\s+", s):
        buf = []
        while i < N and re.match(r"^\d+\.\s+", lines[i].strip()):
            buf.append(tidy_list_item(re.sub(r"^\d+\.\s+", "", lines[i].strip()))); i += 1
        out.append("<ol>" + "".join("<li>%s</li>" % inline(x) for x in buf) + "</ol>"); continue

    if re.match(r"^[-*]\s+", s):
        buf = []
        while i < N and re.match(r"^[-*]\s+", lines[i].strip()):
            buf.append(tidy_list_item(re.sub(r"^[-*]\s+", "", lines[i].strip()))); i += 1
        out.append("<ul>" + "".join("<li>%s</li>" % inline(x) for x in buf) + "</ul>"); continue

    if not s:
        i += 1; continue

    out.append("<p>%s</p>" % inline(s)); i += 1

body = "\n".join(out)

CSS = """
@page { size: A4; margin: 20mm 18mm 18mm 18mm; }
* { box-sizing: border-box; }
body {
  font-family: "PingFang SC", "Hiragino Sans GB", "Songti SC", "Arial Unicode MS", sans-serif;
  font-size: 10.5pt; line-height: 1.75; color: #1a1a1a; margin: 0;
}
h1 { font-size: 19pt; text-align: center; line-height: 1.5; margin: 0 0 6pt 0; font-weight: 700; letter-spacing: .5px; }
h2 { font-size: 13.5pt; font-weight: 700; margin: 20pt 0 8pt 0; padding-bottom: 4pt;
     border-bottom: 1.5px solid #1f4e79; color: #1f4e79; page-break-after: avoid; }
h3 { font-size: 11.5pt; font-weight: 700; margin: 13pt 0 6pt 0; color: #232323; page-break-after: avoid; }
h4 { font-size: 10.5pt; font-weight: 700; margin: 10pt 0 4pt 0; page-break-after: avoid; }
p  { margin: 0 0 7pt 0; text-align: justify; }
strong { font-weight: 700; }
em { font-style: normal; }
code { font-family: "SF Mono", Menlo, monospace; font-size: 9.5pt; background: #f2f4f7; padding: 1px 3px; border-radius: 2px; }
hr.rule { border: none; border-top: 1px solid #d8dde3; margin: 14pt 0; }

/* ---- tables ---- */
table { width: 100%; border-collapse: collapse; margin: 8pt 0 12pt 0; font-size: 9.5pt;
        page-break-inside: avoid; table-layout: fixed; }
th { background: #eef3f8; border: 0.75pt solid #b9c6d4; padding: 5pt 6pt;
     text-align: left; font-weight: 700; color: #1f4e79; line-height: 1.5;
     white-space: nowrap; }
td { border: 0.75pt solid #cfd8e2; padding: 5pt 6pt; vertical-align: top;
     line-height: 1.6; text-align: left; word-break: normal; overflow-wrap: break-word; }
tr:nth-child(even) td { background: #fafbfd; }

/* label column: never wrap short CJK labels. Width comes from <colgroup>. */
table.lbl-table td.lbl { white-space: nowrap; font-weight: 600; color: #232323;
     background: #f7f9fc; }
table.lbl-table tr:nth-child(even) td.lbl { background: #f2f6fa; }

/* key-value tables: emphasise first column */
table.kv-table td:first-child { font-weight: 600; color: #232323; background: #f7f9fc; }

/* wide first column (document titles, long phrases) */
table.wide-table td:first-child { font-size: 8.8pt; line-height: 1.5;
     font-weight: 600; color: #232323; background: #f7f9fc; }
table.wide-table td { padding: 5pt 6pt; }

blockquote { margin: 8pt 0; padding: 7pt 10pt; background: #f7f9fc;
             border-left: 3pt solid #1f4e79; page-break-inside: avoid; }
blockquote p { margin: 0; text-align: left; }
pre.diagram { font-family: "SF Mono", Menlo, monospace; font-size: 8pt; line-height: 1.45;
  background: #f7f9fc; border: 0.75pt solid #cfd8e2; padding: 8pt 10pt; margin: 8pt 0 12pt 0;
  white-space: pre; page-break-inside: avoid; }
ol, ul { margin: 5pt 0 8pt 0; padding-left: 18pt; }
li { margin-bottom: 3pt; text-align: justify; }
h1 + p { text-align: center; font-size: 12pt; color: #1f4e79; margin-bottom: 2pt; }
"""

HTML = """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>正式文档</title>
<style>%s</style></head><body>%s</body></html>""" % (CSS, body)

pathlib.Path(OUT_HTML).write_text(HTML, encoding="utf-8")
print("HTML written:", OUT_HTML, len(HTML), "bytes")
