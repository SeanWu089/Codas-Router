#!/usr/bin/env python3
"""Install the reviewed menu app. Default is a candidate-only, read-only plan."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import uuid
import zipfile

BUNDLE_ID = "com.codassol.mac"  # Keep preferences and application identity.
LABEL = "com.codas.mac.menu"
LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"


def run(*args, check=True, timeout=30):
    result = subprocess.run([str(a) for a in args], capture_output=True, text=True, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError(f"{args[0]} failed ({result.returncode}): {(result.stderr or result.stdout)[-1800:]}")
    return result


def no_links(path):
    for part in [path, *path.parents]:
        if part.is_symlink():
            raise RuntimeError(f"Refusing symlink: {part}")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def snapshot(app):
    no_links(app)
    result = {}
    for item in sorted(app.rglob("*")):
        if item.is_symlink():
            raise RuntimeError(f"Refusing symlink inside bundle: {item}")
        if item.is_file():
            result[str(item.relative_to(app))] = [digest(item.read_bytes()), stat.S_IMODE(item.stat().st_mode)]
        elif not item.is_dir():
            raise RuntimeError(f"Unsupported bundle entry: {item}")
    return result


def inspect_bundle(app, candidate=False):
    no_links(app)
    if not app.is_dir() or app.suffix != ".app":
        raise RuntimeError(f"Not an application directory: {app}")
    info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    executable = info.get("CFBundleExecutable", "")
    if info.get("CFBundleIdentifier") != BUNDLE_ID or not executable or Path(executable).name != executable:
        raise RuntimeError(f"Unexpected bundle identity/executable: {app}")
    if not os.access(app / "Contents/MacOS" / executable, os.X_OK):
        raise RuntimeError(f"Missing executable: {app}")
    build = str(info.get("CFBundleVersion", ""))
    if not build.isdecimal():
        raise RuntimeError(f"Unrecognized build number: {app}")
    if candidate:
        expected = {"CFBundleName": "Codas-mac", "CFBundleDisplayName": "Codas-mac",
                    "CFBundleShortVersionString": "0.3.12", "CFBundleVersion": "16",
                    "CFBundleExecutable": "CodasMac"}
        if any(str(info.get(k, "")) != v for k, v in expected.items()):
            raise RuntimeError("Candidate metadata is not Codas-mac 0.3.12/build 16.")
        if not os.access(app / "Contents/Helpers/CodasMenuLauncher", os.X_OK):
            raise RuntimeError("Candidate lacks the exact-path native launcher.")
        run("/usr/bin/codesign", "--verify", "--strict", app)
    return info, snapshot(app)


def apps(terminate=()):
    # Cocoa process metadata and graceful termination; no Apple Events automation.
    script = r'''
ObjC.import('AppKit');
function run(argv) {
    var allowed = JSON.parse(argv[0]);
    var list = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.codassol.mac');
    var output = [];
    for (var i = 0; i < list.count; i++) {
        var a = list.objectAtIndex(i);
        var p = ObjC.unwrap(a.bundleURL.path);
        var item = {pid: a.processIdentifier, bundle_path: p,
                    executable_path: ObjC.unwrap(a.executableURL.path)};
        if (allowed.indexOf(p) >= 0) item.termination_requested = Boolean(a.terminate);
        output.push(item);
    }
    return JSON.stringify(output);
}
'''
    return json.loads(run("/usr/bin/osascript", "-l", "JavaScript", "-e", script,
                          json.dumps([str(p) for p in terminate]), timeout=15).stdout)


def stop(paths):
    for app in apps(terminate=paths):
        if app["bundle_path"] in {str(p) for p in paths} and not app.get("termination_requested"):
            raise RuntimeError(f"Application refused graceful termination: {app['bundle_path']}")
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        if not any(a["bundle_path"] in {str(p) for p in paths} for a in apps()):
            return
        time.sleep(0.25)
    raise RuntimeError("Menu application did not exit; no force termination was attempted.")


def wait_single(target):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        current = apps()
        if len(current) == 1 and current[0]["bundle_path"] == str(target):
            return current[0]
        time.sleep(0.3)
    raise RuntimeError(f"Expected one canonical menu process; observed {current!r}")


def archive(app, expected, destination):
    if snapshot(app) != expected:
        raise RuntimeError(f"Application changed before backup: {app}")
    run("/usr/bin/ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", app, destination, timeout=120)
    with zipfile.ZipFile(destination) as zipped:
        if zipped.testzip() is not None:
            raise RuntimeError(f"Backup failed CRC verification: {destination}")
        for relative, (sha, mode) in expected.items():
            item = zipped.getinfo(app.name + "/" + relative)
            if digest(zipped.read(item)) != sha or stat.S_IMODE(item.external_attr >> 16) != mode:
                raise RuntimeError(f"Backup differs from source: {app}/{relative}")
    if snapshot(app) != expected:
        raise RuntimeError(f"Application changed during backup: {app}")


def read_config(path):
    no_links(path)
    return path.read_bytes() if path.exists() else None


def atomic_write(path, data, expected):
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        temporary.write_bytes(data)
        temporary.chmod(0o644)
        if read_config(path) != expected:
            raise RuntimeError(f"Startup plist changed concurrently; preserved: {path}")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def holding_path(path, purpose):
    return path.with_name("." + path.stem + "." + purpose + "-" + uuid.uuid4().hex + ".noindex")


def move_verified(path, destination, expected):
    no_links(path)
    no_links(destination)
    if path.parent != destination.parent or destination.exists():
        raise RuntimeError("Holding destination must be a vacant same-parent path.")
    if snapshot(path) != expected:
        raise RuntimeError(f"Application changed before atomic retirement: {path}")
    os.rename(path, destination)  # Whole-bundle rename: no recursive deletion or partial tree changes.


def restore_held(holding, path, expected):
    no_links(holding)
    no_links(path)
    if path.exists() or snapshot(holding) != expected:
        raise RuntimeError(f"Cannot restore an occupied or changed application path: {path}")
    os.rename(holding, path)


def startup_state(agent, service, config, expected):
    if read_config(agent) != expected:
        raise RuntimeError("Startup plist changed concurrently; preserved for review.")
    loaded = run("/bin/launchctl", "print", service, check=False)
    if loaded.returncode != 0:
        return False
    lines = [line.strip() for line in loaded.stdout.splitlines()]
    start = lines.index("arguments = {") + 1 if "arguments = {" in lines else -1
    if (expected is None or "path = " + str(agent) not in lines
            or "program = " + config["ProgramArguments"][0] not in lines
            or start < 0 or lines[start:start + 3] != [*config["ProgramArguments"], "}"]):
        raise RuntimeError("Loaded startup job is not the owned path/program/arguments; preserved.")
    return True


def apply(source, source_files, target, obsolete, agent, config, support, origin):
    if sys.platform != "darwin" or os.geteuid() == 0:
        raise RuntimeError("Run as the signed-in Mac user, without sudo.")
    for p in [target, *obsolete, agent, support]:
        if not p.is_relative_to(Path.home()):
            raise RuntimeError(f"Installation target is outside this user's home: {p}")
    for p in [target, agent, support]:
        no_links(p)
    support.mkdir(parents=True, exist_ok=True)
    no_links(support / "install.lock")
    with (support / "install.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        _apply_locked(source, source_files, target, obsolete, agent, config, support, origin)


def _apply_locked(source, source_files, target, obsolete, agent, config, support, origin):
    domain = f"gui/{os.getuid()}"
    service = domain + "/" + LABEL
    paths = [target, *obsolete]
    prior_apps = apps()
    allowed = {str(p) for p in paths}
    if any(a["bundle_path"] not in allowed for a in prior_apps):
        raise RuntimeError("Another same-ID menu copy is running. Quit it or explicitly list its exact path with --legacy-app.")
    existing, executables = {}, {}
    deferred, completed = [], []
    for path in paths:
        running = [a for a in prior_apps if a["bundle_path"] == str(path)]
        try:
            no_links(path)
            if not path.exists():
                if running:
                    raise RuntimeError("The running bundle is absent on disk.")
                continue
            info, files = inspect_bundle(path)
            if int(info["CFBundleVersion"]) > 16:
                raise RuntimeError("The existing bundle is newer than this candidate.")
            expected_exe = str(path / "Contents/MacOS" / info["CFBundleExecutable"])
            if any(a["executable_path"] != expected_exe for a in running):
                raise RuntimeError("The running executable does not match the verified bundle.")
            existing[path], executables[path] = files, expected_exe
        except Exception as error:
            if path == target or running:
                raise RuntimeError(f"Cannot verify a core target or running menu copy: {path}: {error}") from error
            # A partial/inaccessible INACTIVE backup is optional cleanup, not an installation prerequisite.
            deferred.append({"path": str(path), "reason": str(error), "phase": "legacy_validation"})
    old_plist = read_config(agent)
    if old_plist is not None and plistlib.loads(old_plist) != config:
        raise RuntimeError(f"Existing startup configuration differs; review it before replacing: {agent}")
    was_loaded = startup_state(agent, service, config, old_plist)
    disabled = run("/bin/launchctl", "print-disabled", domain).stdout
    if f'"{LABEL}" => true' in disabled:
        raise RuntimeError("This login startup is disabled. Enable it in macOS settings before installing.")
    backup = support / "Backups" / (time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:8])
    no_links(backup.parent)
    backup.mkdir(parents=True)
    archives, holdings = {}, {}
    previous_target_hold = holding_path(target, "previous")
    failed_candidate_hold = holding_path(target, "failed-install")
    if target in existing:
        archives[target] = backup / "previous-target.zip"
        archive(target, existing[target], archives[target])
    if old_plist is not None:
        (backup / "previous-launchagent.plist").write_bytes(old_plist)
    def save_manifest():
        (backup / "manifest.json").write_text(json.dumps({
            "source": str(origin), "unpacked_candidate": str(source), "target": str(target), "agent": str(agent),
            "previously_loaded": was_loaded, "previous_processes": prior_apps,
            "previous_target_holding": str(previous_target_hold),
            "failed_candidate_holding": str(failed_candidate_hold),
            "bundles": [{"path": str(p), "archive": str(archives[p]) if p in archives else None,
                         "holding": str(holdings[p]) if p in holdings else None, "files": files}
                        for p, files in existing.items()]}, indent=2) + "\n")
    save_manifest()
    target.parent.mkdir(parents=True, exist_ok=True)
    stage = target.parent / (".Codas-mac-stage-" + uuid.uuid4().hex + ".app")
    run("/usr/bin/ditto", source, stage, timeout=120)
    if snapshot(stage) != source_files:
        raise RuntimeError(f"Staged app differs from reviewed source; retained at {stage}")
    run("/usr/bin/codesign", "--verify", "--strict", stage)
    installed = startup_changed = startup_unloaded = core_moved = core_unregistered = False
    new_plist = plistlib.dumps(config)
    try:
        if snapshot(source) != source_files:
            raise RuntimeError("Candidate changed after verification.")
        # Recheck running identities immediately before gracefully stopping the verified GUI copies.
        current = apps()
        if any(Path(a["bundle_path"]) not in executables or
               a["executable_path"] != executables[Path(a["bundle_path"])] for a in current):
            raise RuntimeError("A new or unverified menu instance appeared before cutover.")
        stop([Path(a["bundle_path"]) for a in current])
        if apps():
            raise RuntimeError("A competing menu instance appeared during installation.")
        if startup_state(agent, service, config, old_plist) != was_loaded:
            raise RuntimeError("Startup loaded state changed before cutover; preserved.")
        if was_loaded:
            run("/bin/launchctl", "bootout", service)
            startup_unloaded = True
        # Only an existing FINAL target needs replacement. All obsolete paths remain untouched here.
        if target in existing:
            if snapshot(target) != existing[target]:
                raise RuntimeError("The existing final target changed before replacement.")
            core_unregistered = True
            run(LSREGISTER, "-u", target)
            move_verified(target, previous_target_hold, existing[target])
            core_moved = True
        if target.exists():
            raise RuntimeError("Target reappeared during installation.")
        os.replace(stage, target)
        installed = True
        run(LSREGISTER, "-f", target)
        agent.parent.mkdir(parents=True, exist_ok=True)
        if startup_state(agent, service, config, old_plist):
            raise RuntimeError("Startup job reappeared before plist update; preserved.")
        atomic_write(agent, new_plist, old_plist)
        startup_changed = True
        if startup_state(agent, service, config, new_plist):
            raise RuntimeError("Startup job appeared before bootstrap; preserved.")
        run("/bin/launchctl", "bootstrap", domain, agent)
        first = wait_single(target)
        receipt = json.loads(run(*config["ProgramArguments"], timeout=25).stdout)
        second = wait_single(target)
        if receipt["pid"] != first["pid"] or second["pid"] != first["pid"]:
            raise RuntimeError("Reinvoking the launcher created or selected another process.")
        if snapshot(target) != source_files or not startup_state(agent, service, config, new_plist):
            raise RuntimeError("Installed bundle or startup registration failed final verification.")
    except BaseException as original:
        failures = []
        def recover(label, action):
            try:
                action()
                return True
            except BaseException as error:
                failures.append(f"{label}: {error}")
                return False
        def recover_startup():
            expected = new_plist if startup_changed else old_plist
            loaded = startup_state(agent, service, config, expected)
            if startup_changed and loaded:
                run("/bin/launchctl", "bootout", service)
            elif loaded != (was_loaded and not startup_unloaded):
                raise RuntimeError("Startup loaded state changed during rollback; preserved.")
            if startup_changed:
                if startup_state(agent, service, config, new_plist):
                    raise RuntimeError("Startup job reappeared during rollback; preserved.")
                if old_plist is None:
                    if read_config(agent) != new_plist:
                        raise RuntimeError("Startup plist changed before removal; preserved.")
                    agent.unlink()
                else:
                    atomic_write(agent, old_plist, new_plist)
        startup_safe = recover("startup ownership/restore", recover_startup)
        def retire_candidate():
            if not installed:
                return
            if not startup_safe:
                raise RuntimeError("Preserved the new target because startup ownership is conflicted.")
            stop([target])
            run(LSREGISTER, "-u", target)
            move_verified(target, failed_candidate_hold, source_files)
        target_safe = recover("new target", retire_candidate)
        if core_moved:
            def restore_target():
                if not target_safe:
                    raise RuntimeError("Original target retained in its holding directory and ZIP.")
                restore_held(previous_target_hold, target, existing[target])
            recover("previous final target", restore_target)
        if core_unregistered:
            def register_target():
                if snapshot(target) != existing[target]:
                    raise RuntimeError("Original final target was not restored; registration skipped.")
                run(LSREGISTER, "-f", target)
            recover("previous final target registration", register_target)
        if was_loaded and startup_safe:
            def resume_startup():
                if not startup_state(agent, service, config, old_plist):
                    run("/bin/launchctl", "bootstrap", domain, agent)
            recover("resume previous startup", resume_startup)
        for previous in prior_apps:
            def reopen(previous=previous):
                path = Path(previous["bundle_path"])
                if path not in existing or snapshot(path) != existing[path]:
                    raise RuntimeError("Original running bundle changed; did not reopen it.")
                if not any(a["bundle_path"] == previous["bundle_path"] for a in apps()):
                    run(source / "Contents/Helpers/CodasMenuLauncher", previous["bundle_path"], timeout=25)
            recover(f"reopen {previous['bundle_path']}", reopen)
        (backup / "result.json").write_text(json.dumps({
            "installer_revision": 2, "status": "rollback_blocked" if failures else "rolled_back", "error": str(original),
            "rollback_errors": failures, "cleanup_deferred": deferred, "cleanup_completed": [],
            "previous_target_holding": str(previous_target_hold) if core_moved else None,
            "failed_candidate_holding": str(failed_candidate_hold) if installed else None}, indent=2) + "\n")
        raise RuntimeError(f"Installation failed: {original}. Rollback errors: {failures}. Backups: {backup}") from original
    finally:
        # Only this installer-created staging copy is disposable; never recursively delete an old app.
        if stage.exists() and snapshot(stage) == source_files:
            shutil.rmtree(stage)

    # COMMIT BOUNDARY: verified installation/startup must not be rolled back for optional legacy cleanup.
    result = {"installer_revision": 2, "status": "installed", "version": "0.3.12", "build": "16", "process": second,
              "startup_plist": str(agent), "backup": str(backup),
              "previous_target_holding": str(previous_target_hold) if core_moved else None,
              "cleanup_deferred": deferred, "cleanup_completed": completed,
              "reboot_acceptance": "awaiting user retest"}
    def save_result():
        if deferred:
            result["status"] = "installed_with_cleanup_pending"
        try:
            (backup / "result.json").write_text(json.dumps(result, indent=2) + "\n")
        except OSError as error:
            result["receipt_write_error"] = str(error)
    save_result()
    for i, path in enumerate(obsolete):
        if path not in existing:
            continue
        details = {"path": str(path)}
        try:
            if any(a["bundle_path"] == str(path) for a in apps()):
                raise RuntimeError("Legacy copy is running again; cleanup deferred without termination.")
            if snapshot(path) != existing[path]:
                raise RuntimeError("Legacy contents changed or are partial; retained without deletion.")
            zipped = backup / f"legacy-{i:02d}-{path.name}.zip"
            archive(path, existing[path], zipped)
            archives[path] = zipped
            details["archive"] = str(zipped)
            holding = holding_path(path, "retired")
            holdings[path] = holding
            details["holding"] = str(holding)
            save_manifest()  # Record the intended destination before the single atomic operation.
            if any(a["bundle_path"] == str(path) for a in apps()):
                raise RuntimeError("Legacy copy became active; retained without mutation.")
            move_verified(path, holding, existing[path])
            details["retired"] = True
            # Forget only these two explicit URLs. Registration failures leave the verified core running.
            run(LSREGISTER, "-u", path)
            run(LSREGISTER, "-u", holding)
            completed.append(details)
        except Exception as error:
            details["reason"] = str(error)
            deferred.append(details)
        save_result()
    print(json.dumps(result, indent=2))


def process_source(args, source, origin):
    _, source_files = inspect_bundle(source, candidate=True)
    home = Path.home()
    target = home / "Applications/Codas-mac.app"
    obsolete = list(dict.fromkeys([home / "Applications/CodasSol-mac.app",
                                  *(Path(os.path.abspath(p.expanduser())) for p in args.legacy_app)]))
    all_paths = [source, target, *obsolete]
    for i, path in enumerate(all_paths):
        if path.suffix != ".app" or any(path.is_relative_to(p) or p.is_relative_to(path) for p in all_paths[i + 1:]):
            raise RuntimeError("Candidate, target and obsolete applications must have distinct, non-overlapping .app paths.")
    support = home / "Library/Application Support/Codas-mac"
    agent = home / "Library/LaunchAgents" / (LABEL + ".plist")
    config = {"Label": LABEL, "ProgramArguments": [str(target / "Contents/Helpers/CodasMenuLauncher"), str(target)],
              "RunAtLoad": True, "LimitLoadToSessionType": "Aqua", "ProcessType": "Interactive"}
    if not args.apply:
        # Do not stat/read destination paths here: the plan works in a source-only workspace.
        print(json.dumps({"mode": "plan_only", "installer_revision": 2, "source": str(origin), "candidate": str(source),
                          "version": "0.3.12", "build": "16",
                          "candidate_binary_sha256": source_files["Contents/MacOS/CodasMac"][0],
                          "target": str(target), "explicit_obsolete_apps": [str(p) for p in obsolete],
                          "startup_plist": str(agent), "startup": config,
                          "backups": str(support / "Backups"),
                          "apply_verification": "Verify the signed core app and exact startup first; then archive and atomically rename optional inactive legacy copies to same-parent .noindex holdings. Inaccessible or partial legacy copies remain untouched and are reported in cleanup_deferred. Physical reboot remains a user retest.",
                          "destination_accessed": False}, indent=2))
        return
    apply(source, source_files, target, obsolete, agent, config, support, origin)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True, help="Reviewed .app or ZIP containing Codas-mac.app.")
    parser.add_argument("--legacy-app", action="append", type=Path, default=[],
                        help="Explicit obsolete same-ID app to archive; repeat for each reviewed path.")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--plan", action="store_true", help="Default; validates only the candidate.")
    mode.add_argument("--apply", action="store_true", help="Install locally; requires access to printed destinations.")
    args = parser.parse_args()
    source = Path(os.path.abspath(args.source.expanduser()))
    if source.suffix.lower() != ".zip":
        return process_source(args, source, source)
    no_links(source)
    with tempfile.TemporaryDirectory(prefix="codas-menu-candidate-") as folder:
        physical = Path(folder).resolve()
        frozen = physical / "candidate.zip"
        shutil.copyfile(source, frozen)
        with zipfile.ZipFile(frozen) as zipped:
            seen = set()
            total = 0
            for item in zipped.infolist():
                parts = item.filename.rstrip("/").split("/")
                top_ok = parts[0] == "Codas-mac.app" or (parts[0] == "__MACOSX" and
                         (len(parts) == 1 or parts[1] in ("Codas-mac.app", "._Codas-mac.app")))
                kind = stat.S_IFMT(item.external_attr >> 16)
                total += item.file_size
                if (not top_ok or any(p in ("", ".", "..") for p in parts) or "\\" in item.filename
                        or item.filename in seen or kind not in (0, stat.S_IFREG, stat.S_IFDIR)
                        or total > 128 * 1024 * 1024 or len(seen) >= 5000):
                    raise RuntimeError("ZIP contains an unsafe, duplicate, oversized or unexpected entry.")
                seen.add(item.filename)
            if zipped.testzip() is not None:
                raise RuntimeError("Candidate ZIP failed CRC verification.")
        unpacked = physical / "unpacked"
        unpacked.mkdir()
        run("/usr/bin/ditto", "-x", "-k", frozen, unpacked, timeout=120)
        process_source(args, unpacked / "Codas-mac.app", source)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
