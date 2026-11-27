import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalWorkspacePolicy, planDevSpaceRootChange, revalidateDevSpaceRootPlan } from "../src/local-workspace-policy.js";

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codas-policy-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const allowed = path.join(home, "Projects");
  const project = path.join(allowed, "Demo");
  const neighbor = path.join(home, "Projects-old");
  const privateState = path.join(home, "Private");
  for (const dir of [project, neighbor, privateState]) fs.mkdirSync(dir, { recursive: true });
  const policy = new LocalWorkspacePolicy({ home, protectedRoots: [privateState] });
  return { home, allowed, project, neighbor, privateState, policy };
}

const code = (expected) => (error) => error.code === expected;

test("empty policy denies access; explicitly granted existing directory permits a child", (t) => {
  const { policy, project, allowed } = fixture(t);
  assert.throws(() => policy.openWorkspace(project), code("WORKSPACE_DENIED"));
  const grant = policy.grantRoot("~/Projects");
  assert.equal(grant.path, fs.realpathSync.native(allowed));
  const lease = policy.openWorkspace(project);
  assert.equal(lease.grantId, grant.id);
  assert.equal(policy.checkWorkspace(lease.id), fs.realpathSync.native(project));
});

test("rejects relative paths, non-directories, protected parents and overlapping grants", (t) => {
  const { policy, home, allowed, project, privateState } = fixture(t);
  const file = path.join(home, "file.txt"); fs.writeFileSync(file, "fixture");
  assert.throws(() => policy.grantRoot("Projects"), code("INVALID_PATH"));
  assert.throws(() => policy.grantRoot(file), code("NOT_DIRECTORY"));
  assert.throws(() => policy.grantRoot(home), code("PROTECTED_ROOT"));
  assert.throws(() => policy.grantRoot(privateState), code("PROTECTED_ROOT"));
  assert.throws(() => policy.grantRoot(path.parse(home).root), code("PROTECTED_ROOT"));
  policy.grantRoot(allowed);
  assert.throws(() => policy.grantRoot(project), code("OVERLAPPING_ROOT"));
  assert.throws(() => policy.grantRoot(allowed), code("OVERLAPPING_ROOT"));
});

test("prefix siblings and traversal cannot inherit a grant", (t) => {
  const { policy, allowed, neighbor } = fixture(t);
  policy.grantRoot(allowed);
  assert.throws(() => policy.openWorkspace(neighbor), code("WORKSPACE_DENIED"));
  assert.throws(() => policy.openWorkspace(allowed + path.sep + ".." + path.sep + "Projects-old"), code("INVALID_PATH"));
});

test("directory symlink or junction cannot escape; approved-target aliases work", (t) => {
  const { policy, home, allowed, project, neighbor } = fixture(t);
  const type = process.platform === "win32" ? "junction" : "dir";
  const escape = path.join(allowed, "escape");
  const shortcut = path.join(home, "shortcut");
  fs.symlinkSync(neighbor, escape, type);
  fs.symlinkSync(project, shortcut, type);
  policy.grantRoot(allowed);
  assert.throws(() => policy.openWorkspace(escape), code("WORKSPACE_DENIED"));
  assert.equal(policy.openWorkspace(shortcut).path, fs.realpathSync.native(project));
});

test("revocation invalidates old leases even after re-authorizing the same directory", (t) => {
  const { policy, allowed, project } = fixture(t);
  const first = policy.grantRoot(allowed);
  const old = policy.openWorkspace(project);
  assert.equal(policy.revokeRoot(first.id), true);
  assert.throws(() => policy.checkWorkspace(old.id), code("WORKSPACE_REVOKED"));
  const second = policy.grantRoot(allowed);
  assert.notEqual(second.id, first.id);
  assert.throws(() => policy.checkWorkspace(old.id), code("WORKSPACE_REVOKED"));
  assert.equal(policy.checkWorkspace(policy.openWorkspace(project).id), fs.realpathSync.native(project));
});

test("replacing the granted root cannot silently authorize the new directory", (t) => {
  const { policy, allowed, project } = fixture(t);
  policy.grantRoot(allowed);
  const old = policy.openWorkspace(project);
  fs.renameSync(allowed, allowed + "-previous");
  fs.mkdirSync(project, { recursive: true });
  assert.throws(() => policy.openWorkspace(project), code("ROOT_CHANGED"));
  assert.throws(() => policy.checkWorkspace(old.id), code("ROOT_CHANGED"));
});

test("replacing a bound workspace invalidates its old lease", (t) => {
  const { policy, allowed, project } = fixture(t);
  policy.grantRoot(allowed);
  const old = policy.openWorkspace(project);
  fs.renameSync(project, project + "-previous");
  fs.mkdirSync(project);
  assert.throws(() => policy.checkWorkspace(old.id), code("WORKSPACE_CHANGED"));
});

test("a protected directory not yet created is still excluded", (t) => {
  const { home, allowed } = fixture(t);
  const policy = new LocalWorkspacePolicy({ home, protectedRoots: [path.join(allowed, "future", "state")] });
  assert.throws(() => policy.grantRoot(allowed), code("PROTECTED_ROOT"));
});

test("only issued opaque lease IDs work; closing a lease invalidates it", (t) => {
  const { policy, allowed, project } = fixture(t);
  const grant = policy.grantRoot(allowed);
  const lease = policy.openWorkspace(project);
  assert.throws(() => policy.checkWorkspace(grant.id), code("WORKSPACE_REVOKED"));
  assert.throws(() => policy.checkWorkspace(lease), code("WORKSPACE_REVOKED"));
  assert.throws(() => policy.checkWorkspace("fabricated"), code("WORKSPACE_REVOKED"));
  assert.equal(policy.closeWorkspace(lease.id), true);
  assert.throws(() => policy.checkWorkspace(lease.id), code("WORKSPACE_REVOKED"));
});

test("retargeted aliases are checked against the resolved destination, not the old grant", (t) => {
  const { policy, home, allowed, project, neighbor, privateState } = fixture(t);
  const type = process.platform === "win32" ? "junction" : "dir";
  const link = path.join(home, "alias");
  fs.symlinkSync(privateState, link, type);
  assert.throws(() => policy.grantRoot(link), code("PROTECTED_ROOT"));
  fs.unlinkSync(link);
  fs.symlinkSync(project, link, type);
  policy.grantRoot(allowed);
  const lease = policy.openWorkspace(link);
  fs.unlinkSync(link);
  fs.symlinkSync(neighbor, link, type);
  assert.throws(() => policy.openWorkspace(link), code("WORKSPACE_DENIED"));
  // An existing workspace stays bound to its original canonical directory.
  assert.equal(policy.checkWorkspace(lease.id), fs.realpathSync.native(project));
});

test("restoring trusted grant state retains permissions, not old leases", (t) => {
  const { home, policy, allowed, project, privateState } = fixture(t);
  const grant = policy.grantRoot(allowed);
  const old = policy.openWorkspace(project);
  const restored = new LocalWorkspacePolicy({ home, protectedRoots: [privateState], state: JSON.parse(JSON.stringify(policy.snapshot())) });
  assert.deepEqual(restored.list(), [grant]);
  assert.throws(() => restored.checkWorkspace(old.id), code("WORKSPACE_REVOKED"));
  assert.equal(restored.checkWorkspace(restored.openWorkspace(project).id), fs.realpathSync.native(project));
});

test("restoring a stale grant does not approve a directory replacement", (t) => {
  const { home, policy, allowed, project, privateState } = fixture(t);
  policy.grantRoot(allowed);
  const saved = policy.snapshot();
  fs.renameSync(allowed, allowed + "-old");
  fs.mkdirSync(project, { recursive: true });
  const restored = new LocalWorkspacePolicy({ home, protectedRoots: [privateState], state: saved });
  assert.throws(() => restored.openWorkspace(project), code("ROOT_CHANGED"));
  assert.equal(restored.revokeRoot(saved.grants[0].id), true);
  assert.throws(() => restored.openWorkspace(project), code("WORKSPACE_DENIED"));
});

test("malformed saved policies and duplicate grants fail closed", (t) => {
  const { home, policy, allowed, privateState } = fixture(t);
  policy.grantRoot(allowed);
  const state = policy.snapshot();
  const restore = (saved) => new LocalWorkspacePolicy({ home, protectedRoots: [privateState], state: saved });
  assert.throws(() => restore({ version: 2, grants: [] }), code("INVALID_POLICY_STATE"));
  assert.throws(() => restore({ version: 1, grants: [...state.grants, ...state.grants] }), code("INVALID_POLICY_STATE"));
  assert.throws(() => restore({ version: 1, grants: [{ ...state.grants[0], path: "relative" }] }), code("INVALID_POLICY_STATE"));
});

test("retargeting a protected link into a granted subtree blocks future preflights", (t) => {
  const { home, allowed, project, privateState } = fixture(t);
  const link = path.join(home, "state-link");
  const type = process.platform === "win32" ? "junction" : "dir";
  fs.symlinkSync(privateState, link, type);
  const policy = new LocalWorkspacePolicy({ home, protectedRoots: [link] });
  policy.grantRoot(allowed);
  const lease = policy.openWorkspace(project);
  fs.unlinkSync(link);
  fs.symlinkSync(project, link, type);
  assert.throws(() => policy.checkWorkspace(lease.id), code("PROTECTED_ROOT"));
  assert.throws(() => policy.openWorkspace(project), code("PROTECTED_ROOT"));
});

test("a local configuration plan preserves existing roots and requires restart and verification", (t) => {
  const { home, allowed, neighbor, privateState } = fixture(t);
  const allowedRoots = ["~/Projects"];
  const plan = planDevSpaceRootChange({ allowedRoots, action: { type: "add", path: neighbor }, home, protectedRoots: [privateState] });
  assert.deepEqual(allowedRoots, ["~/Projects"]);
  assert.deepEqual(plan.before, allowedRoots);
  assert.deepEqual(plan.after, ["~/Projects", fs.realpathSync.native(neighbor)]);
  assert.equal(plan.restartRequired, true);
  assert.equal(plan.verificationRequired, true);
  assert.equal(plan.selection.path, fs.realpathSync.native(neighbor));
  assert.deepEqual(revalidateDevSpaceRootPlan({ plan, allowedRoots, home, protectedRoots: [privateState] }), plan);
});

test("configuration planning refuses broadening, protected roots and redundant grants", (t) => {
  const { home, allowed, project, privateState } = fixture(t);
  const plan = (allowedRoots, value) => planDevSpaceRootChange({ allowedRoots, home, protectedRoots: [privateState], action: { type: "add", path: value } });
  assert.throws(() => plan([allowed], project), code("ROOT_ALREADY_COVERED"));
  assert.throws(() => plan([project], allowed), code("OVERLAPPING_ROOT"));
  assert.throws(() => plan([allowed], privateState), code("PROTECTED_ROOT"));
  assert.throws(() => plan([allowed], home), code("PROTECTED_ROOT"));
});

test("empty/missing roots and removal of the last root cannot trigger default access", (t) => {
  const { home, allowed, neighbor } = fixture(t);
  const action = { type: "add", path: neighbor };
  for (const allowedRoots of [undefined, [], null]) {
    assert.throws(() => planDevSpaceRootChange({ allowedRoots, action, home }), code("EXPLICIT_ROOTS_REQUIRED"));
  }
  assert.throws(() => planDevSpaceRootChange({ allowedRoots: [allowed], action: { type: "remove", index: 0, expectedPath: allowed }, home }), code("LAST_ROOT"));
});

test("removal preserves the other entries and may remove a missing root without granting anything", (t) => {
  const { home, allowed, neighbor } = fixture(t);
  const missing = path.join(home, "missing");
  const allowedRoots = [allowed, missing, neighbor];
  const plan = planDevSpaceRootChange({ allowedRoots, action: { type: "remove", index: 1, expectedPath: missing }, home });
  assert.deepEqual(plan.after, [allowed, neighbor]);
  assert.equal(plan.selection, null);
  assert.deepEqual(revalidateDevSpaceRootPlan({ plan, allowedRoots, home }), plan);
});

test("changed config, changed selection identity and modified plans require renewed review", (t) => {
  const { home, allowed, neighbor } = fixture(t);
  const allowedRoots = [allowed];
  const plan = planDevSpaceRootChange({ allowedRoots, action: { type: "add", path: neighbor }, home });
  assert.throws(() => revalidateDevSpaceRootPlan({ plan, allowedRoots: [allowed, neighbor], home }), code("STALE_ROOT_PLAN"));
  assert.throws(() => revalidateDevSpaceRootPlan({ plan: { ...plan, after: [home] }, allowedRoots, home }), code("STALE_ROOT_PLAN"));
  fs.renameSync(neighbor, neighbor + "-old");
  fs.mkdirSync(neighbor);
  assert.throws(() => revalidateDevSpaceRootPlan({ plan, allowedRoots, home }), code("STALE_ROOT_PLAN"));
});
