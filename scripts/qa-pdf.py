#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""PDF 版面质量检查（中文正式文档）

区分三类问题：
  FATAL  表头或标签列被逐字断开（如 "响应缺/口"）—— 必须修复
  WARN   表格单元格末行仅剩 1–2 字 —— CJK 窄列的固有现象，可接受
  OK     无异常

用法: python3 qa-pdf.py <file.pdf>
"""
import re, subprocess, sys, tempfile, os, pathlib

# 这些词若被拆开即为 FATAL（表头/标签专用词）
CRITICAL_WORDS = ["响应缺口", "建设内容", "数据前提", "交付形态", "可检查指标",
                  "责任边界", "项目名称", "文件版本", "编制单位", "置信度",
                  "合作机会", "对接载体", "风险类别", "工作内容", "参与方"]

def extract(pdf):
    out = os.path.join(tempfile.gettempdir(), "qa_pdf.txt")
    subprocess.run(["pdftotext", "-layout", pdf, out], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return pathlib.Path(out).read_text(encoding="utf-8", errors="ignore")

def main(pdf):
    txt = extract(pdf)
    lines = txt.split("\n")
    flat = re.sub(r"[ \t]+", " ", txt)

    fatal = []
    # 1) 关键标签是否被拆开：形如 "响应缺" 结尾或 "口" 单独一行
    for w in CRITICAL_WORDS:
        # 拆分模式：词的前 n-1 字后紧跟换行，末字在下一行
        for cut in range(2, len(w)):
            head, tail = w[:cut], w[cut:]
            if re.search(r"%s\s*\n\s*%s\s*\n" % (re.escape(head), re.escape(tail[:1])), txt):
                fatal.append("%s → 被拆为 '%s' / '%s'" % (w, head, tail))
                break

    # 2) 表头被拆：header 行后紧跟 1 字独立行（表格区）
    warn = []
    for i, ln in enumerate(lines):
        s = ln.strip()
        if re.fullmatch(r"[\u4e00-\u9fff]{1,2}", s):
            prev = lines[i - 1].strip() if i else ""
            # 标题类（前后为空行）属正常，不计
            prev_blank = (not prev)
            next_blank = (i + 1 >= len(lines)) or (not lines[i + 1].strip())
            if not (prev_blank and next_blank):
                warn.append("第 %d 行: '%s'（上一行: %s）" % (i + 1, s, prev[:40]))

    pages = subprocess.run(["pdfinfo", pdf], capture_output=True, text=True).stdout
    pg = re.search(r"^Pages:\s*(\d+)", pages, re.M)
    size = re.search(r"^Page size:\s*(.+)$", pages, re.M)

    print("文件: %s" % os.path.basename(pdf))
    print("页数: %s ｜ 规格: %s" % (pg.group(1) if pg else "?", (size.group(1).strip() if size else "?")))
    print("缺字: %s" % ("是 ✗" if ("□" in txt or "\ufffd" in txt) else "否 ✓"))
    print("致命问题（标签/表头被拆）: %d %s" % (len(fatal), "✓" if not fatal else "✗"))
    for f in fatal[:8]:
        print("   - %s" % f)
    print("提示（末行残字，CJK 窄列固有）: %d" % len(warn))
    for w in warn[:6]:
        print("   · %s" % w)
    return 0 if not fatal else 1

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("用法: python3 qa-pdf.py <file.pdf>"); sys.exit(2)
    sys.exit(main(sys.argv[1]))
