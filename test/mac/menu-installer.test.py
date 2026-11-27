#!/usr/bin/env python3
"""Isolated macOS installer regressions: real ZIPs/renames, mocked OS app/job control."""
import contextlib
import errno
import io
import json
from pathlib import Path
import plistlib
import shutil
import sys
import tempfile
import types
import unittest

ROOT = Path(__file__).resolve().parents[2]
INSTALLER = ROOT / "scripts/mac/menu-app/install-menu.py"


@unittest.skipUnless(sys.platform == "darwin", "ditto archive verification requires macOS")
class InstallerFaultTests(unittest.TestCase):
    def exercise(self, fault):
        ns = {"__name__": "installer_fixture"}
        exec(compile(INSTALLER.read_text(), str(INSTALLER), "exec"), ns)
        real_run, real_inspect, real_move = ns["run"], ns["inspect_bundle"], ns["move_verified"]
        real_rmtree = shutil.rmtree
        fixture_parent = ROOT / ".build/menu-installer-tests"
        fixture_parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=fault + "-", dir=fixture_parent) as temporary:
            root = Path(temporary).resolve()
            source, target = root / "Candidate/Codas-mac.app", root / "Applications/Codas-mac.app"
            old, legacy = root / "Applications/CodasSol-mac.app", root / "OldBackup/CodasSol-mac.app"
            agent, support = root / "LaunchAgents/menu.plist", root / "Support"
            agent.parent.mkdir()
            existing_target = fault == "core_failure_existing_target"

            def make_app(path, build, marker, executable="CodasSolMac"):
                (path / "Contents/MacOS").mkdir(parents=True)
                (path / "Contents/Info.plist").write_bytes(plistlib.dumps({
                    "CFBundleIdentifier": "com.codassol.mac", "CFBundleExecutable": executable,
                    "CFBundleVersion": str(build), "CFBundleShortVersionString": "0.3.15"}))
                binary = path / "Contents/MacOS" / executable
                binary.write_bytes(marker.encode())
                binary.chmod(0o755)

            make_app(source, 19, "reviewed candidate", "CodasMac")
            make_app(old, 15, "current working menu")
            if fault in ("partial_legacy", "active_partial_legacy"):
                (legacy / "Contents/Resources").mkdir(parents=True)
                (legacy / "Contents/Resources/remaining").write_bytes(b"preserve prior partial state")
            else:
                make_app(legacy, 14, "obsolete backup")
            if existing_target:
                make_app(target, 18, "previous final target", "CodasMac")
            source_files, old_files = ns["snapshot"](source), ns["snapshot"](old)
            legacy_files = ns["snapshot"](legacy)
            previous_target_files = ns["snapshot"](target) if existing_target else None
            config = {"Label": ns["LABEL"], "ProgramArguments": [
                str(target / "Contents/Helpers/CodasMenuLauncher"), str(target)],
                "RunAtLoad": True, "LimitLoadToSessionType": "Aqua", "ProcessType": "Interactive"}
            previous_plist = plistlib.dumps(config, fmt=plistlib.FMT_BINARY) if existing_target else None
            if previous_plist is not None:
                agent.write_bytes(previous_plist)
            foreign_plist = plistlib.dumps({"Label": "other-owner", "ProgramArguments": ["/bin/echo", "preserve"]})
            state = {"loaded": existing_target, "bootstrap": 0, "waits": 0, "helpers": 0,
                     "stops": 0, "legacy_moves": [], "commands": []}
            current = []

            def spawn(path):
                executable = "CodasMac" if path == target else "CodasSolMac"
                current[:] = [{"pid": 41 if path == target else 23, "bundle_path": str(path),
                               "executable_path": str(path / "Contents/MacOS" / executable)}]

            prior_path = target if existing_target else old
            if fault == "active_partial_legacy":
                prior_path = legacy
            if fault == "unknown_running":
                prior_path = root / "Other/CodasSol-mac.app"
                make_app(prior_path, 15, "unlisted running copy")
            spawn(prior_path)

            def answer(stdout="", returncode=0):
                return types.SimpleNamespace(stdout=stdout, stderr="", returncode=returncode)

            def fake_run(*arguments, **kwargs):
                args = [str(value) for value in arguments]
                state["commands"].append(args)
                if args[0] == "/usr/bin/ditto":
                    for argument in args[1:]:
                        if not argument.startswith("-"):
                            self.assertTrue(Path(argument).is_relative_to(root), args)
                    return real_run(*arguments, **kwargs)  # Actual isolated ZIP/hash/mode checks.
                if args[0] == "/usr/bin/codesign":
                    return answer()
                if args[0] == ns["LSREGISTER"]:
                    if fault == "startup_write_conflict" and args[1:] == ["-f", str(target)]:
                        agent.write_bytes(foreign_plist)
                    return answer()
                if args[0] == "/bin/launchctl":
                    if args[1] == "print-disabled":
                        return answer("{}")
                    if args[1] == "print":
                        if not state["loaded"]:
                            return answer(returncode=113)
                        return answer("path = " + str(agent) + "\nprogram = " + config["ProgramArguments"][0]
                                      + "\narguments = {\n" + "\n".join(config["ProgramArguments"]) + "\n}\n")
                    if args[1] == "bootout":
                        state["loaded"] = False
                        return answer()
                    if args[1] == "bootstrap":
                        state["bootstrap"] += 1
                        state["loaded"] = True
                        spawn(target)
                        if fault.startswith("core_failure") and state["bootstrap"] == 1:
                            raise RuntimeError("injected startup failure after job submission")
                        return answer()
                if args[0].endswith("/CodasMenuLauncher"):
                    state["helpers"] += 1
                    spawn(Path(args[1]))
                    return answer(json.dumps({"pid": current[0]["pid"], "bundle_path": args[1]}))
                raise AssertionError("Unexpected real-system operation: " + repr(args))

            def fake_stop(paths):
                state["stops"] += 1
                current[:] = [a for a in current if a["bundle_path"] not in {str(p) for p in paths}]

            def fake_wait(path):
                state["waits"] += 1
                self.assertEqual([a["bundle_path"] for a in current], [str(path)])
                return dict(current[0])

            def inspect(path, candidate=False):
                if path == legacy and fault == "unreadable_legacy":
                    raise PermissionError(errno.EPERM, "Operation not permitted", str(path / "Contents"))
                return real_inspect(path, candidate)

            def move(path, destination, expected):
                if path in (old, legacy):
                    self.assertGreaterEqual(state["waits"], 2, "legacy mutation preceded core verification")
                    self.assertTrue(state["loaded"])
                    state["legacy_moves"].append(path)
                if path == legacy and fault == "legacy_eperm":
                    raise PermissionError(errno.EPERM, "Operation not permitted", str(path / "Contents"))
                return real_move(path, destination, expected)

            def guarded_rmtree(path, *args, **kwargs):
                self.assertNotIn(Path(path), [old, legacy, target], "old bundle was recursively deleted")
                self.assertNotEqual(Path(path).suffix, ".noindex", "preserved holding was recursively deleted")
                return real_rmtree(path, *args, **kwargs)

            ns.update(run=fake_run, apps=lambda terminate=(): [dict(a) for a in current],
                      stop=fake_stop, wait_single=fake_wait, inspect_bundle=inspect, move_verified=move)
            shutil.rmtree = guarded_rmtree
            error = None
            try:
                with contextlib.redirect_stdout(io.StringIO()):
                    ns["_apply_locked"](source, source_files, target, [old, legacy], agent, config, support, source)
            except RuntimeError as caught:
                error = caught
            finally:
                shutil.rmtree = real_rmtree
            if fault in ("unknown_running", "active_partial_legacy"):
                self.assertIsNotNone(error)
                self.assertEqual(state["stops"], 0)
                self.assertEqual(ns["snapshot"](old), old_files)
                self.assertEqual(ns["snapshot"](legacy), legacy_files)
                self.assertFalse(target.exists())
                return
            receipt = json.loads(next((support / "Backups").glob("*/result.json")).read_text())
            self.assertEqual(receipt["installer_revision"], 2)
            if fault.startswith("core_failure"):
                self.assertIsNotNone(error)
                self.assertEqual(receipt["status"], "rolled_back", receipt)
                self.assertEqual(state["legacy_moves"], [])
                self.assertEqual(ns["snapshot"](old), old_files)
                self.assertEqual(ns["snapshot"](legacy), legacy_files)
                self.assertEqual(agent.read_bytes() if agent.exists() else None, previous_plist)
                self.assertEqual(state["loaded"], existing_target)
                if existing_target:
                    self.assertEqual(ns["snapshot"](target), previous_target_files)
                else:
                    self.assertFalse(target.exists())
                self.assertEqual(current[0]["bundle_path"], str(prior_path))
            elif fault == "startup_write_conflict":
                self.assertIsNotNone(error)
                self.assertEqual(receipt["status"], "rollback_blocked", receipt)
                self.assertEqual(agent.read_bytes(), foreign_plist)
                self.assertEqual(state["legacy_moves"], [])
                self.assertEqual(ns["snapshot"](old), old_files)
                self.assertEqual(ns["snapshot"](legacy), legacy_files)
            else:
                self.assertIsNone(error)
                self.assertEqual(receipt["status"], "installed_with_cleanup_pending", receipt)
                self.assertEqual(ns["snapshot"](target), source_files)
                self.assertTrue(state["loaded"])
                self.assertEqual(current[0]["bundle_path"], str(target))
                self.assertEqual(plistlib.loads(agent.read_bytes()), config)
                self.assertEqual(ns["snapshot"](legacy), legacy_files, "deferred legacy contents changed")
                self.assertTrue(any(item["path"] == str(legacy) for item in receipt["cleanup_deferred"]))
                held = next(item for item in receipt["cleanup_completed"] if item["path"] == str(old))
                self.assertFalse(old.exists())
                self.assertEqual(ns["snapshot"](Path(held["holding"])), old_files)

    def test_legacy_contents_eperm_does_not_undo_verified_installation(self):
        self.exercise("legacy_eperm")

    def test_inactive_partial_legacy_is_preserved_without_archive_replay(self):
        self.exercise("partial_legacy")

    def test_inactive_unreadable_legacy_is_deferred(self):
        self.exercise("unreadable_legacy")

    def test_core_failure_reopens_untouched_previous_gui(self):
        self.exercise("core_failure_no_target")

    def test_core_failure_restores_existing_target_by_rename(self):
        self.exercise("core_failure_existing_target")

    def test_startup_conflict_preserves_foreign_configuration(self):
        self.exercise("startup_write_conflict")

    def test_active_partial_legacy_still_fails_closed(self):
        self.exercise("active_partial_legacy")

    def test_unlisted_running_copy_still_fails_closed(self):
        self.exercise("unknown_running")


if __name__ == "__main__":
    unittest.main(verbosity=2)
