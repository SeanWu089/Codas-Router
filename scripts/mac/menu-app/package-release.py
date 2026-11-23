#!/usr/bin/env python3
"""Package an existing signed app ZIP with a portable, path-free installer."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True, help="Signed app ZIP produced by build.sh.")
    parser.add_argument("--output", type=Path, required=True, help="New installer-package directory; never overwritten.")
    args = parser.parse_args()
    here = Path(__file__).resolve().parent
    source = args.source.expanduser().resolve(strict=True)
    output = Path(os.path.abspath(args.output.expanduser()))
    if source.suffix.lower() != ".zip" or output.exists() or output.is_symlink():
        raise RuntimeError("Source must be a ZIP and output must be a new directory.")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".codas-package-", dir=output.parent) as folder:
        temporary = Path(folder)
        frozen = temporary / "candidate.zip"
        shutil.copyfile(source, frozen)
        validation = subprocess.run(
            [sys.executable, str(here / "install-menu.py"), "--source", str(frozen), "--plan"],
            text=True, capture_output=True, check=True,
        )
        plan = json.loads(validation.stdout)
        if plan.get("mode") != "plan_only" or plan.get("destination_accessed") is not False:
            raise RuntimeError("Candidate did not pass source-only installer verification.")
        # The verifier strictly validates the expected version/build and bundle signature.
        archive_name = "Codas-mac-" + plan["version"] + ".zip"
        package = temporary / "package"
        package.mkdir()
        shutil.copyfile(frozen, package / archive_name)
        shutil.copyfile(here / "install-menu.py", package / "install-menu.py")
        shutil.copyfile(here / "install-package.command", package / "Install-Codas-mac.command")
        (package / "Install-Codas-mac.command").chmod(0o755)
        settings = {
            "archive": archive_name,
            "sha256": hashlib.sha256((package / archive_name).read_bytes()).hexdigest(),
            "legacy_apps": [],  # User-selected backups may be added via --legacy-app at invocation.
        }
        (package / "install-settings.json").write_text(json.dumps(settings, indent=2) + "\n")
        if output.exists() or output.is_symlink():
            raise RuntimeError("Output appeared during packaging; refusing to replace it.")
        os.rename(package, output)
    print(json.dumps({"package": str(output), "version": plan["version"], "build": plan["build"],
                      "archive": archive_name, "sha256": settings["sha256"],
                      "installer_revision": plan["installer_revision"],
                      "installer_command": "Install-Codas-mac.command"}, indent=2))


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        print(error.stderr or str(error), file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
