#!/bin/zsh
# Distributed next to install-menu.py, a signed ZIP, and install-settings.json.
set -u
PACKAGE_ROOT="$(cd "$(dirname "$0")" && pwd -P)"
python3 - "$PACKAGE_ROOT" "$@" <<'PY'
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
from datetime import datetime

root = Path(sys.argv[1])
parser = argparse.ArgumentParser(description="Install the packaged Codas-mac app, or inspect it without installing.")
parser.add_argument("--plan", action="store_true", help="Verify package and print the installation plan without changing installed apps.")
parser.add_argument("--legacy-app", action="append", default=[], help="Explicit obsolete app path; repeat for each reviewed copy.")
arguments = parser.parse_args(sys.argv[2:])
try:
    settings = json.loads((root / "install-settings.json").read_text())
    name = settings["archive"]
    if Path(name).name != name or not name.endswith(".zip"):
        raise ValueError("Invalid package archive name")
    archive = root / name
    actual = hashlib.sha256(archive.read_bytes()).hexdigest()
    if actual != settings["sha256"]:
        raise ValueError("The package checksum changed; installation was not started")
    command = [sys.executable, str(root / "install-menu.py"), "--source", str(archive),
               "--plan" if arguments.plan else "--apply"]
    legacy_apps = settings.get("legacy_apps", [])
    if not isinstance(legacy_apps, list) or any(not isinstance(path, str) for path in legacy_apps):
        raise ValueError("legacy_apps must be a list of explicitly reviewed path strings")
    for path in [*legacy_apps, *arguments.legacy_app]:
        command.extend(["--legacy-app", path])
    if arguments.plan:
        result = subprocess.run(command, text=True, capture_output=True)
        print(result.stdout, end="")
        print(result.stderr, end="", file=sys.stderr)
        sys.exit(result.returncode)
    previous = [root / name for name in ("installation-output.log", "installation-result.json")]
    if any(path.exists() for path in previous):
        history = root / "install-attempts" / datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        history.mkdir(parents=True)
        for path in previous:
            if path.exists():
                path.rename(history / path.name)
    print("正在安装 Codas-mac（安装器修订版 2）：先校验新版启动，再处理历史副本。", flush=True)
    result = subprocess.run(command, text=True, capture_output=True)
    (root / "installation-output.log").write_text(result.stdout + result.stderr)
    if result.returncode:
        print(result.stderr or result.stdout)
        print("安装未完成。错误已保存在本目录 installation-output.log，请将结果告诉助手。")
        sys.exit(result.returncode)
    receipt = json.loads(result.stdout)
    if receipt.get("status") not in {"installed", "installed_with_cleanup_pending"}:
        raise RuntimeError("Installer did not report a verified installation")
    (root / "installation-result.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print("安装完成：Codas-mac " + receipt["version"] + "（build " + receipt["build"] + "）")
    print("正在运行：" + receipt["process"]["bundle_path"])
    print("重复启动检查已通过。下次自然重启后还需确认状态栏正常。")
    deferred = receipt.get("cleanup_deferred", [])
    if deferred:
        print("新版已安装；以下历史副本暂未完成清理，已记录在安装结果中：")
        for item in deferred:
            print("  " + item["path"] + "：" + item["reason"])
except Exception as error:
    print("安装未完成：" + str(error), file=sys.stderr)
    sys.exit(1)
PY
INSTALL_RESULT=$?
print
if [[ -t 0 ]]; then
    read -r "?按回车关闭此窗口。"
fi
exit "$INSTALL_RESULT"
