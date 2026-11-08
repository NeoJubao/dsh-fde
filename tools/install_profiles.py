#!/usr/bin/env python3
"""dsh-fde 安装助手（preflight + 官方命令封装）。

设计原则（ADR 0004 D3）：
- **不直接改写 profile 的 package.json / pnpm-lock.yaml / node_modules**，
  一律通过 DSH 官方 CLI：`dsh plugin --profile <name> add <spec>`（它转发给 pnpm）。
- 默认只做只读检查并打印命令；加 --run 才执行。

用法：
  python3 tools/install_profiles.py                # 只检查 + 打印命令（不会改任何文件）
  python3 tools/install_profiles.py --run          # 对检测到的 profile 执行官方安装
  python3 tools/install_profiles.py --profile web --run
  python3 tools/install_profiles.py --uninstall    # 打印卸载命令，--run 时执行
  python3 tools/install_profiles.py --plugin-dir /path/to/dsh-fde

退出码：0 检查通过 / 1 检查失败 / 2 参数错误。
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

PLUGIN_NAME = "dsh-fde"
MIN_NODE_MAJOR = 20


def find_plugin_dir(explicit: str | None) -> Path:
    if explicit:
        return Path(explicit).expanduser().resolve()
    return Path(__file__).resolve().parents[1]


def find_dsh() -> str | None:
    for name in ("dsh", "dsh.exe"):
        hit = shutil.which(name)
        if hit:
            return hit
    candidates = [
        Path.home() / ".bun" / "bin" / "dsh",
        Path("/opt/homebrew/bin/dsh"),
        Path("/usr/local/bin/dsh"),
    ]
    for c in candidates:
        if c.is_file() and os.access(c, os.X_OK):
            return str(c)
    return None


def node_major() -> int | None:
    for exe in ("node", "node.exe"):
        hit = shutil.which(exe)
        if not hit:
            continue
        try:
            out = subprocess.check_output([hit, "-v"], text=True, timeout=10).strip()
            return int(out.lstrip("v").split(".")[0])
        except (subprocess.SubprocessError, ValueError):
            return None
    return None


def read_plugin_manifest(plugin_dir: Path) -> dict | None:
    pkg = plugin_dir / "package.json"
    try:
        data = json.loads(pkg.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except (OSError, json.JSONDecodeError):
        return None


def profile_dirs() -> list[Path]:
    root = Path.home() / ".dsh" / "profiles"
    if not root.is_dir():
        return []
    return [d for d in sorted(root.iterdir()) if (d / "package.json").is_file()]


def preflight(plugin_dir: Path, profile: str | None) -> tuple[bool, list[str]]:
    lines: list[str] = []
    ok = True

    manifest = read_plugin_manifest(plugin_dir)
    if not manifest:
        return False, [f"✗ 找不到或无法解析 {plugin_dir / 'package.json'}"]
    name = manifest.get("name")
    version = manifest.get("version")
    if name != PLUGIN_NAME:
        ok = False
        lines.append(f"✗ 包名不是 {PLUGIN_NAME}（实际 {name!r}）：请在插件根目录运行")
    else:
        lines.append(f"✓ 插件包：{name}@{version}（{plugin_dir}）")
    if not (plugin_dir / "client.js").is_file():
        ok = False
        lines.append("✗ 缺 client.js：先运行 `node build.mjs`")
    else:
        lines.append("✓ 客户端产物 client.js 存在")
    if not manifest.get("dsh", {}).get("bundle", {}).get("patch"):
        ok = False
        lines.append("✗ package.json 缺 dsh.bundle.patch：DSH 不会把它当组合包安装")

    major = node_major()
    if major is None:
        lines.append("? 无法检测 Node 版本（请确认 node >= %d）" % MIN_NODE_MAJOR)
    elif major < MIN_NODE_MAJOR:
        ok = False
        lines.append(f"✗ Node {major} 低于要求 {MIN_NODE_MAJOR}")
    else:
        lines.append(f"✓ Node {major}")

    dsh = find_dsh()
    if dsh:
        lines.append(f"✓ dsh CLI：{dsh}")
    else:
        ok = False
        lines.append("✗ 找不到 dsh CLI：先在安装 DSH 的机器上确认 `dsh --help` 可用")

    known = profile_dirs()
    if known:
        names = ", ".join(p.name for p in known)
        lines.append(f"✓ 已有 profile：{names}")
    else:
        lines.append("? 未发现已有 profile；`dsh plugin add` 首次使用会创建")
    if profile and profile not in {p.name for p in known}:
        lines.append(f"! profile {profile!r} 还不存在，首次安装时会创建")

    lines.append("")
    lines.append("官方安装命令（在任意目录执行）：")
    targets = [profile] if profile else [p.name for p in known] or ["web"]
    add_cmd = f'{dsh or "dsh"} plugin --profile {{profile}} add "{plugin_dir}"'
    for t in targets:
        lines.append("  " + add_cmd.format(profile=t))
    lines.append("")
    lines.append("安装后：重启 DSH（或在插件管理里对本插件禁用→启用一次）；客户端改动刷新页面即可。")
    lines.append(f"卸载：{dsh or 'dsh'} plugin --profile <profile> remove {PLUGIN_NAME}")
    return ok, lines


def run_official(cmd: list[str]) -> int:
    print("$ " + " ".join(cmd))
    try:
        return subprocess.call(cmd)
    except OSError as e:
        print(f"✗ 执行失败：{e}")
        return 1


def main() -> int:
    ap = argparse.ArgumentParser(description="dsh-fde 安装助手（preflight + 官方命令封装）")
    ap.add_argument("--profile", help="目标 profile 名（默认：已存在的全部 profile；没有则 web）")
    ap.add_argument("--plugin-dir", help="插件目录（默认本脚本上一级）")
    ap.add_argument("--run", action="store_true", help="实际执行官方 dsh plugin add/remove（默认只打印）")
    ap.add_argument("--uninstall", action="store_true", help="卸载而不是安装")
    args = ap.parse_args()

    plugin_dir = find_plugin_dir(args.plugin_dir)
    if not plugin_dir.is_dir():
        print(f"✗ 插件目录不存在：{plugin_dir}")
        return 2
    dsh = find_dsh()
    if not dsh:
        print("✗ 找不到 dsh CLI：请先安装 DeepSeek Harness（或把 dsh 加入 PATH）")
        return 1

    if args.uninstall:
        target = args.profile or "<profile>"
        cmd = [dsh, "plugin", "--profile", target, "remove", PLUGIN_NAME]
        if args.run and args.profile:
            return run_official(cmd)
        if args.run and not args.profile:
            print("✗ --uninstall --run 需要同时给 --profile")
            return 2
        print("将执行（加 --run 才真正执行）：")
        print("  " + " ".join(cmd))
        return 0

    ok, lines = preflight(plugin_dir, args.profile)
    print("\n".join(lines))
    if not ok:
        print("\n✗ preflight 未通过，未安装。")
        return 1
    if not args.run:
        print("\n（只检查，不执行。确认无误后加 --run。）")
        return 0

    targets = [args.profile] if args.profile else [p.name for p in profile_dirs()] or ["web"]
    rc = 0
    for t in targets:
        rc = run_official([dsh, "plugin", "--profile", t, "add", str(plugin_dir)])
        if rc != 0:
            print(f"✗ profile {t} 安装失败（exit {rc}），已停止后续 profile。")
            return rc
    print("\n✓ 安装命令执行完成。请重启 DSH（或禁用→启用本插件）后打开「FDE 工作站」面板。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
