#!/usr/bin/env python3
"""把对外 md 转成 DOCX（可选桥接，不内置 DOCX 引擎）。

定位：调研工作台里「md 定稿 → 正式对外 DOCX」的桥。
- md 是事实来源，本脚本只做**结构与版式**的转换，不改写正文。
- DOCX 由**使用者自备**的外部生成器完成：只要它提供 `scripts/build_docx.py` 并满足内容块契约
  （见 methods/05 §六），就能被本脚本调用；没装生成器时只交 md，不影响主功能。

用法：
  python3 md2docx.py 输入.md 输出.docx [--overwrite] [--fonts gb|mac] [--drop-heading "7.2 团队配置与人月"]
  python3 md2docx.py 输入.md 输出.docx --skill-dir <含 scripts/build_docx.py 的目录>

约定：
- 首个一级标题作标题；其余 # / ## / ### / #### 映射为一~四级标题；
- | 表格 | 原样转表格（首行为表头，跳过 md 分隔行）；
- > 引用块 → 无首行缩进的独立段落；
- 列表项 → 以 · 开头的独立段落（保留缩进）；
- ``` 代码块 → 等宽段落（原样保留）；
- 行内 **粗体** / *斜体* / `代码` / [文字](链接) 去标记后取纯文本；
- --- 分隔线 → 页间空段（不主动分页）。
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

# GB/T 9704 常用字体（收文方 Windows 中文环境通常具备）
FONTS_GB = {"title": "方正小标宋简体", "body": "仿宋", "h1": "黑体", "h2": "楷体", "page": "宋体"}
# 本机 macOS 实际具备的中文字体（所见即所得，但收文方可能缺）
FONTS_MAC = {"title": "宋体", "body": "宋体", "h1": "黑体", "h2": "宋体", "page": "宋体"}


def strip_inline(text: str) -> str:
    """去掉行内 markdown 标记，保留文字。"""
    text = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", text)          # 图片 → alt
    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r"\1", text)          # 链接 → 文字
    text = re.sub(r"`([^`]*)`", r"\1", text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"\1", text)
    text = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"\1", text)
    text = re.sub(r"~~([^~]+)~~", r"\1", text)
    return text.strip()


def split_row(line: str):
    """按 | 拆表格行（忽略首尾空段）。"""
    cells = [c.strip() for c in line.strip().strip("|").split("|")]
    return [strip_inline(c) for c in cells]


def is_separator(line: str) -> bool:
    return bool(re.fullmatch(r"\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?", line.strip()))


def parse_md(md: str):
    lines = md.split("\n")
    blocks, i, title = [], 0, None
    in_code, code_buf = False, []
    table_buf = []

    def flush_table():
        nonlocal table_buf
        if len(table_buf) >= 2:
            headers = split_row(table_buf[0])
            rows = [split_row(r) for r in table_buf[1:] if not is_separator(r)]
            width = len(headers)
            rows = [(r + [""] * width)[:width] for r in rows]
            blocks.append({"type": "table", "headers": headers, "rows": rows,
                           "widths": [1] * width})
        table_buf = []

    while i < len(lines):
        raw = lines[i]
        line = raw.rstrip()

        # 代码块
        if line.startswith("```"):
            if in_code:
                blocks.append({"type": "paragraph", "text": "\n".join(code_buf),
                               "align": "left", "indent": False})
                code_buf = []
            in_code = not in_code
            i += 1
            continue
        if in_code:
            code_buf.append(raw)
            i += 1
            continue

        # 表格
        if line.strip().startswith("|") and "|" in line.strip()[1:]:
            table_buf.append(line)
            i += 1
            # 下一行不是表格则收尾
            if i >= len(lines) or not lines[i].strip().startswith("|"):
                flush_table()
            continue
        if table_buf:
            flush_table()

        if not line.strip():
            i += 1
            continue

        # 标题
        m = re.match(r"^(#{1,6})\s+(.*)$", line)
        if m:
            level, text = len(m.group(1)), strip_inline(m.group(2))
            if level == 1 and title is None:
                title = text
            else:
                blocks.append({"type": "heading", "level": max(1, min(level - 1, 4)), "text": text})
            i += 1
            continue

        # 分隔线
        if re.fullmatch(r"\s*([-*_])\s*(\1\s*){2,}", line):
            blocks.append({"type": "paragraph", "text": "", "indent": False})
            i += 1
            continue

        # 引用
        if line.lstrip().startswith(">"):
            blocks.append({"type": "paragraph", "text": strip_inline(line.lstrip()[1:].strip()),
                           "align": "left", "indent": False})
            i += 1
            continue

        # 列表
        m = re.match(r"^(\s*)([-*+]|\d+[.)])\s+(.*)$", raw)
        if m:
            depth = len(m.group(1)) // 2
            bullet = "·" if m.group(2) in "-*+" else m.group(2)
            prefix = "　" * depth
            blocks.append({"type": "paragraph",
                           "text": f"{prefix}{bullet} {strip_inline(m.group(3))}",
                           "align": "left"})
            i += 1
            continue

        # 普通段落：**一行一段**；只有上一行以连接符结尾（句子未完）才续行合并。
        # 这样"文件编号／编制单位／提交对象"这类元信息行不会被并成一句。
        buf = [strip_inline(line)]
        i += 1
        while i < len(lines):
            nxt = lines[i]
            cont = bool(re.search(r"[，、；：（「『“]$", buf[-1]))
            if (not cont or not nxt.strip() or nxt.lstrip().startswith(("#", ">", "|", "```"))
                    or re.match(r"^(\s*)([-*+]|\d+[.)])\s+", nxt)):
                break
            buf.append(strip_inline(nxt))
            i += 1
        text = "".join(buf)
        if text:
            blocks.append({"type": "paragraph", "text": text})

    if table_buf:
        flush_table()
    return title, blocks


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--overwrite", action="store_true")
    ap.add_argument("--fonts", choices=["gb", "mac"], default="gb")
    ap.add_argument("--skill-dir", default=None)
    ap.add_argument("--subtitle", default=None)
    ap.add_argument("--drop-heading", action="append", default=[], metavar="PREFIX",
                    help="出库删节：按标题前缀删掉整节（标题行起，到下一个同级或更高级标题前）。可重复。")
    args = ap.parse_args()

    src, dst = Path(args.src), Path(args.dst)
    if not src.exists():
        sys.exit(f"源文件不存在：{src}")
    if dst.exists() and not args.overwrite:
        sys.exit(f"输出已存在：{dst}（确认重建请加 --overwrite）")

    # 定位外部生成器（可选桥接：由使用者自备并自行确认许可）
    if args.skill_dir:
        skill = Path(args.skill_dir)
    else:
        cand = []
        env_dir = os.environ.get("FDE_DOCX_SKILL_DIR")
        if env_dir:
            cand.append(Path(env_dir))
        cand += [Path.cwd() / "cn-procurement-docs", Path.cwd() / "skills/cn-procurement-docs"]
        skill = next((c for c in cand if (c / "scripts/build_docx.py").exists()), None)
    if skill is None or not (skill / "scripts/build_docx.py").exists():
        sys.exit("未找到外部 skill，DOCX 导出不可用，md 不受影响；"
                 "如已安装兼容 build_docx.py 契约的生成器，用 --skill-dir <目录> 指定（或设 FDE_DOCX_SKILL_DIR）")

    md = src.read_text(encoding="utf-8")
    md = re.sub(r"\A---\n.*?\n---\n", "", md, count=1, flags=re.S)  # 去 frontmatter
    title, blocks = parse_md(md)

    # 出库删节：按标题前缀整节删除（含其下所有内容，直到下一个同级/更高级标题）
    dropped = []
    for prefix in args.drop_heading:
        out, skipping, skip_level = [], False, None
        for b in blocks:
            if b["type"] == "heading" and b["text"].startswith(prefix):
                skipping, skip_level = True, b["level"]
                dropped.append(prefix)
                continue
            if skipping and b["type"] == "heading" and b["level"] <= skip_level:
                skipping = False
            if not skipping:
                out.append(b)
        blocks = out
    if args.drop_heading and not dropped:
        sys.exit(f"--drop-heading 未匹配到任何标题：{args.drop_heading}（检查标题前缀）")

    payload = {
        "title": title or src.stem,
        "blocks": blocks,
        "fonts": FONTS_GB if args.fonts == "gb" else FONTS_MAC,
    }
    if args.subtitle:
        payload["subtitle"] = args.subtitle

    dst.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
        tmp = f.name

    cmd = [sys.executable, str(skill / "scripts/build_docx.py"), tmp, str(dst)]
    if args.overwrite:
        cmd.append("--overwrite")
    proc = subprocess.run(cmd, capture_output=True, text=True)
    Path(tmp).unlink(missing_ok=True)

    if proc.returncode != 0:
        sys.exit(f"build_docx.py 失败：\n{proc.stdout}\n{proc.stderr}")
    print(proc.stdout.strip())
    drop_note = f" ｜ 已删节：{'、'.join(dropped)}" if dropped else ""
    print(f"✓ {dst} ｜ 标题：{payload['title']} ｜ 内容块：{len(blocks)} ｜ 字体组：{args.fonts}{drop_note}")
    kinds = {}
    for b in blocks:
        kinds[b["type"]] = kinds.get(b["type"], 0) + 1
    print("  块构成：" + "，".join(f"{k}×{v}" for k, v in kinds.items()))


if __name__ == "__main__":
    main()
