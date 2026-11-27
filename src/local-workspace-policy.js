import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

// A local, opt-in policy primitive. This is NOT a process sandbox, an admin
// endpoint, or a replacement for the execution backend's allowed roots.
export class WorkspacePolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorkspacePolicyError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new WorkspacePolicyError(code, message);
}

function absolutePath(value, home) {
  if (typeof value !== "string" || !value.length || value.includes("\0")) {
    fail("INVALID_PATH", "An absolute directory path is required");
  }
  const parts = process.platform === "win32" ? value.split(/[\\/]/) : value.split("/");
  if (parts.includes("..")) fail("INVALID_PATH", "Parent-directory traversal is not allowed");
  const expanded = value === "~" ? home : value.startsWith("~/")
    ? home + path.sep + value.slice(2) : value;
  if (!path.isAbsolute(expanded)) fail("INVALID_PATH", "An absolute directory path is required");
  return expanded;
}

function contains(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." &&
    !relative.startsWith(".." + path.sep));
}

function directory(value, home) {
  const absolute = absolutePath(value, home);
  try {
    const canonical = fs.realpathSync.native(absolute);
    const stat = fs.lstatSync(canonical, { bigint: true });
    if (!stat.isDirectory()) fail("NOT_DIRECTORY", "The selected path is not a directory");
    return { path: canonical, dev: String(stat.dev), ino: String(stat.ino) };
  } catch (error) {
    if (error instanceof WorkspacePolicyError) throw error;
    fail("DIRECTORY_UNAVAILABLE", "The selected directory could not be resolved");
  }
}

function sameDirectory(a, b) {
  return path.relative(a.path, b.path) === "" && a.dev === b.dev && a.ino === b.ino;
}

function protectedPath(value, home) {
  const absolute = path.resolve(absolutePath(value, home));
  // Resolve the nearest existing ancestor even when a protected state
  // directory has not been created yet. Do not trust an unreadable ancestor.
  const suffix = [];
  let current = absolute;
  for (;;) {
    try { return path.join(fs.realpathSync.native(current), ...suffix); }
    catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") {
        fail("PROTECTED_PATH_UNAVAILABLE", "A protected directory could not be resolved");
      }
      try {
        if (fs.lstatSync(current).isSymbolicLink()) {
          fail("PROTECTED_PATH_UNAVAILABLE", "A protected directory has a dangling link");
        }
      } catch (inspectError) {
        if (inspectError instanceof WorkspacePolicyError) throw inspectError;
        if (inspectError?.code !== "ENOENT" && inspectError?.code !== "ENOTDIR") {
          fail("PROTECTED_PATH_UNAVAILABLE", "A protected directory could not be inspected");
        }
      }
      const parent = path.dirname(current);
      if (parent === current) fail("PROTECTED_PATH_UNAVAILABLE", "A protected directory could not be resolved");
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Local owner-approved grants and revocable workspace leases. Directory
 * identity checks prevent a removed/replaced root or workspace from silently
 * inheriting an old grant. No policy changes are exposed over MCP or HTTP.
 * Callers must separately enforce file/command isolation at execution time.
 */
export class LocalWorkspacePolicy {
  #grants = new Map();
  #leases = new Map();
  #home;
  #protected;

  constructor({ home = os.homedir(), protectedRoots = [], state = null } = {}) {
    this.#home = directory(path.resolve(home), path.resolve(home)).path;
    this.#protected = protectedRoots.map((value) => ({ value, initial: protectedPath(value, this.#home) }));
    if (state !== null) this.#restore(state);
  }

  list() {
    return [...this.#grants.values()].map((grant) => ({ id: grant.id, path: grant.path }));
  }

  #checkProtected(canonical) {
    const roots = this.#protected.flatMap(({ value, initial }) => [initial, protectedPath(value, this.#home)]);
    if (contains(canonical, this.#home) || canonical === path.parse(canonical).root ||
        roots.some((root) => contains(root, canonical) || contains(canonical, root))) {
      fail("PROTECTED_ROOT", "This directory overlaps a protected location");
    }
  }

  // For a trusted local persistence adapter only. Preserve the original file
  // identity: restoring state must not silently approve a replacement path.
  // Leases are intentionally process-local and never serialized.
  snapshot() {
    return { version: 1, grants: [...this.#grants.values()].map((grant) => ({ ...grant })) };
  }

  #restore(state) {
    if (state?.version !== 1 || !Array.isArray(state.grants)) {
      fail("INVALID_POLICY_STATE", "The saved workspace policy is invalid");
    }
    for (const record of state.grants) {
      if (!record || typeof record.id !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(record.id) ||
          typeof record.path !== "string" || !path.isAbsolute(record.path) ||
          path.normalize(record.path) !== record.path ||
          typeof record.dev !== "string" || !/^\d+$/.test(record.dev) ||
          typeof record.ino !== "string" || !/^\d+$/.test(record.ino) ||
          this.#grants.has(record.id)) {
        fail("INVALID_POLICY_STATE", "The saved workspace policy contains an invalid grant");
      }
      absolutePath(record.path, this.#home);
      this.#checkProtected(record.path);
      for (const existing of this.#grants.values()) {
        if (contains(existing.path, record.path) || contains(record.path, existing.path)) {
          fail("INVALID_POLICY_STATE", "The saved workspace policy contains overlapping grants");
        }
      }
      this.#grants.set(record.id, { id: record.id, path: record.path, dev: record.dev, ino: record.ino });
    }
  }

  // For the local approval controller only; never call on the basis of a
  // remote request. Overlaps are rejected to make revocation unambiguous.
  grantRoot(value) {
    const root = directory(value, this.#home);
    this.#checkProtected(root.path);
    for (const grant of this.#grants.values()) {
      if (contains(grant.path, root.path) || contains(root.path, grant.path)) {
        fail("OVERLAPPING_ROOT", "This directory overlaps an existing grant");
      }
    }
    const grant = { ...root, id: randomUUID() };
    this.#grants.set(grant.id, grant);
    return { id: grant.id, path: grant.path };
  }

  revokeRoot(id) {
    if (!this.#grants.delete(id)) return false;
    for (const [leaseId, lease] of this.#leases) {
      if (lease.grantId === id) this.#leases.delete(leaseId);
    }
    return true;
  }

  #checkGrant(grant) {
    let current;
    try { current = directory(grant.path, this.#home); }
    catch { fail("ROOT_CHANGED", "The approved directory is no longer available"); }
    if (!sameDirectory(current, grant)) fail("ROOT_CHANGED", "The approved directory has changed");
    this.#checkProtected(current.path);
  }

  openWorkspace(value) {
    const workspace = directory(value, this.#home);
    const grant = [...this.#grants.values()].find((root) => contains(root.path, workspace.path));
    if (!grant) fail("WORKSPACE_DENIED", "The workspace is outside the approved directories");
    this.#checkGrant(grant);
    const lease = { id: randomUUID(), grantId: grant.id, ...workspace };
    this.#leases.set(lease.id, lease);
    return Object.freeze({ id: lease.id, grantId: lease.grantId, path: lease.path });
  }

  checkWorkspace(leaseId) {
    const lease = this.#leases.get(leaseId);
    const grant = lease && this.#grants.get(lease.grantId);
    if (!grant) fail("WORKSPACE_REVOKED", "The workspace authorization is no longer valid");
    this.#checkGrant(grant);
    const workspace = directory(lease.path, this.#home);
    if (!sameDirectory(workspace, lease) || !contains(grant.path, workspace.path)) {
      fail("WORKSPACE_CHANGED", "The workspace directory has changed");
    }
    return workspace.path;
  }

  closeWorkspace(leaseId) {
    return this.#leases.delete(leaseId);
  }
}

// Read-only planning for DevSpace's explicitly configured allowedRoots array.
// The empty array is NOT a deny-all policy in DevSpace: it falls back to its
// working directory. Never use it to implement revocation. No live config or
// process is touched by either function below.
export function planDevSpaceRootChange({ allowedRoots, action, home = os.homedir(), protectedRoots = [] }) {
  if (!Array.isArray(allowedRoots) || !allowedRoots.length ||
      allowedRoots.some((value) => typeof value !== "string" || !value.trim())) {
    fail("EXPLICIT_ROOTS_REQUIRED", "An explicit non-empty DevSpace root list is required");
  }
  const before = [...allowedRoots];
  let after;
  let selection = null;
  let operation;
  if (action?.type === "add") {
    const policy = new LocalWorkspacePolicy({ home, protectedRoots });
    const grant = policy.grantRoot(action.path);
    const { path: selectedPath, dev, ino } = policy.snapshot().grants[0];
    // Recheck the original approved directory identity rather than silently
    // capturing a replacement identity if the selection changes during planning.
    const lease = policy.openWorkspace(grant.path);
    policy.closeWorkspace(lease.id);
    selection = { path: selectedPath, dev, ino };
    for (const value of before) {
      const existing = directory(value, home);
      if (contains(existing.path, selection.path)) {
        fail("ROOT_ALREADY_COVERED", "An existing directory already covers the selection");
      }
      if (contains(selection.path, existing.path)) {
        fail("OVERLAPPING_ROOT", "The selection would implicitly broaden an existing grant");
      }
    }
    after = [...before, selection.path];
    operation = { type: "add", path: selection.path };
  } else if (action?.type === "remove") {
    const index = action.index;
    if (!Number.isInteger(index) || index < 0 || index >= before.length || before[index] !== action.expectedPath) {
      fail("STALE_ROOT_PLAN", "The selected root no longer matches the configuration");
    }
    if (before.length === 1) fail("LAST_ROOT", "Removing the last root would enable DevSpace's default-root fallback");
    after = before.filter((_, i) => i !== index);
    operation = { type: "remove", index, expectedPath: action.expectedPath };
  } else {
    fail("INVALID_ROOT_ACTION", "Select an explicit add or remove operation");
  }
  return { version: 1, before, after, operation, selection, restartRequired: true, verificationRequired: true };
}

// A local apply controller must revalidate the complete current config and
// selected directory immediately before an atomic write. This only validates
// the root-list part of that future transaction; the controller must also
// check the config file digest, ownership and effective service state.
export function revalidateDevSpaceRootPlan({ plan, allowedRoots, home = os.homedir(), protectedRoots = [] }) {
  if (plan?.version !== 1 || !Array.isArray(plan.before) || !Array.isArray(plan.after) ||
      !Array.isArray(allowedRoots) || JSON.stringify(plan.before) !== JSON.stringify(allowedRoots)) {
    fail("STALE_ROOT_PLAN", "The root configuration has changed; review a fresh plan");
  }
  const fresh = planDevSpaceRootChange({ allowedRoots, action: plan.operation, home, protectedRoots });
  if (JSON.stringify(fresh.after) !== JSON.stringify(plan.after) ||
      (fresh.selection !== null && (!plan.selection || !sameDirectory(fresh.selection, plan.selection)))) {
    fail("STALE_ROOT_PLAN", "The proposed root change is no longer identical; review a fresh plan");
  }
  return fresh;
}
