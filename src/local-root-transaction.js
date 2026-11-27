import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { planDevSpaceRootChange, revalidateDevSpaceRootPlan, WorkspacePolicyError } from "./local-workspace-policy.js";

// Local-only transaction foundation. No HTTP/MCP entry point. The host must
// supply a trusted JSONC codec and a managed-service adapter that implements
// quiescence and *effective* authorization verification, not merely health.
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = (code, message) => { throw new WorkspacePolicyError(code, message); };
const same = (a, b) => isDeepStrictEqual(a, b);

function ownedDirectory(dir) {
  if (!path.isAbsolute(dir) || fs.realpathSync.native(dir) !== dir) {
    fail("UNSAFE_CONFIG_PATH", "Use a canonical, existing local directory");
  }
  const info = fs.lstatSync(dir);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o022)) {
    fail("UNSAFE_CONFIG_PATH", "Configuration directory ownership or permissions are unsafe");
  }
}

function readOwnedFile(file) {
  ownedDirectory(path.dirname(file));
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() ||
        (stat.mode & 0o022) || stat.size > 4 * 1024 * 1024) {
      fail("UNSAFE_CONFIG_FILE", "Configuration must be a single owner-controlled regular file");
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (bytes.length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) {
      fail("CONFIG_CHANGED", "Configuration changed while being read");
    }
    return { bytes, digest: hash(bytes), mode: stat.mode & 0o777, dev: stat.dev, ino: stat.ino };
  } finally { fs.closeSync(descriptor); }
}

function sameFile(a, b) {
  return a.digest === b.digest && a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
}

function syncDirectory(dir) {
  const descriptor = fs.openSync(dir, fs.constants.O_RDONLY);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function createDurable(file, data, mode = 0o600) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, mode);
  try { fs.fchmodSync(fd, mode); fs.writeFileSync(fd, data); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

function replaceIfCurrent(file, expected, bytes, mode) {
  const parent = path.dirname(file);
  const temp = path.join(parent, `.codas-roots-${randomUUID()}.tmp`);
  let renamed = false;
  try {
    createDurable(temp, bytes, mode);
    if (!sameFile(readOwnedFile(file), expected)) fail("CONFIG_CHANGED", "Configuration changed; refusing to overwrite it");
    fs.renameSync(temp, file);
    renamed = true;
    syncDirectory(parent);
  } finally { if (!renamed && fs.existsSync(temp)) fs.unlinkSync(temp); }
}

function roots(config) { return config?.workspaces?.allowedRoots; }

export function inspectLocalRootConfig(configFile, codec) {
  const current = readOwnedFile(configFile);
  const list = roots(codec.decode(current.bytes.toString("utf8")));
  if (!Array.isArray(list) || !list.length || list.some((item) => typeof item !== "string" || !item.trim())) {
    fail("EXPLICIT_ROOTS_REQUIRED", "An explicit non-empty DevSpace root list is required");
  }
  return { roots: [...list], digest: current.digest };
}

/** Adapter for the same JSONC parser used by DevSpace. Preserves comments and
 * unrelated settings, and refuses invalid or ambiguous input. */
export function makeJSONCRootCodec({ parse, parseTree, modify, applyEdits }) {
  const decode = (text) => {
    const errors = [];
    const tree = parseTree(text, errors, { allowTrailingComma: true });
    const uniqueKeys = (node) => {
      if (node?.type === "object") {
        const keys = new Set();
        for (const property of node.children || []) {
          const key = property.children?.[0]?.value;
          if (typeof key !== "string" || key === "__proto__" || keys.has(key) || !uniqueKeys(property.children?.[1])) return false;
          keys.add(key);
        }
      } else if (node?.type === "array") {
        return (node.children || []).every(uniqueKeys);
      }
      return !!node;
    };
    if (errors.length || tree?.type !== "object" || !uniqueKeys(tree)) {
      fail("INVALID_CONFIG", "DevSpace configuration contains invalid or duplicate properties");
    }
    const result = parse(text, errors, { allowTrailingComma: true });
    if (errors.length || !result || typeof result !== "object" || Array.isArray(result)) {
      fail("INVALID_CONFIG", "DevSpace configuration is not valid JSONC");
    }
    return result;
  };
  return {
    decode,
    replaceRoots(text, next) {
      decode(text);
      return applyEdits(text, modify(text, ["workspaces", "allowedRoots"], next, {
        formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" }
      }));
    }
  };
}

/**
 * Single-process, local approval controller. A plan ID is issued only here;
 * callers cannot supply a new root list to apply(). Restart/verification is
 * intentionally injected until the native host is wired and audited.
 * This is not protection against a malicious same-account process or an OS
 * crash between a path check and rename. Incomplete journals block new work.
 */
export class LocalRootTransaction {
  #file; #storage; #codec; #policy; #service; #plans = new Map(); #applying = false;

  constructor({ configFile, journalDirectory, codec, service, home, protectedRoots = [] }) {
    if (process.platform === "win32" || typeof process.getuid !== "function") {
      fail("UNSUPPORTED_PLATFORM", "The POSIX transaction adapter is not available here");
    }
    this.#file = configFile;
    this.#storage = journalDirectory;
    this.#codec = codec;
    this.#service = service;
    this.#policy = { home, protectedRoots: [...protectedRoots, path.dirname(configFile), journalDirectory] };
    if (!path.isAbsolute(configFile) || !path.isAbsolute(journalDirectory)) fail("UNSAFE_CONFIG_PATH", "Local absolute paths are required");
    ownedDirectory(path.dirname(configFile));
    ownedDirectory(journalDirectory);
    if (fs.lstatSync(journalDirectory).mode & 0o077) fail("UNSAFE_JOURNAL", "Transaction storage must be private (0700)");
  }

  #lockPath() { return path.join(this.#storage, "active"); }

  #assertAvailable() {
    ownedDirectory(this.#storage);
    if (fs.lstatSync(this.#storage).mode & 0o077) fail("UNSAFE_JOURNAL", "Transaction storage must remain private (0700)");
    if (this.#applying || fs.existsSync(this.#lockPath())) fail("TRANSACTION_PENDING", "Resolve the outstanding transaction first");
  }

  preview(action) {
    this.#assertAvailable();
    const current = readOwnedFile(this.#file);
    const decoded = this.#codec.decode(current.bytes.toString("utf8"));
    const plan = planDevSpaceRootChange({ allowedRoots: roots(decoded), action, ...this.#policy });
    const id = randomUUID();
    // Keep one current review. Nothing containing full config bytes leaves the controller.
    this.#plans.clear();
    this.#plans.set(id, { plan, current });
    return { id, ...structuredClone(plan), digest: current.digest };
  }

  async apply(id) {
    this.#assertAvailable();
    const approved = this.#plans.get(id);
    if (!approved) fail("UNKNOWN_APPROVAL", "Review the current change before applying it");
    this.#plans.clear();
    const { plan, current } = approved;
    const originalText = current.bytes.toString("utf8");
    const original = this.#codec.decode(originalText);
    const expected = structuredClone(original);
    expected.workspaces.allowedRoots = [...plan.after];
    const next = Buffer.from(this.#codec.replaceRoots(originalText, plan.after), "utf8");
    if (!same(this.#codec.decode(next.toString("utf8")), expected)) fail("UNRELATED_CONFIG_CHANGE", "The editor changed unrelated settings");
    const readAndCheck = () => {
      const latest = readOwnedFile(this.#file);
      if (!sameFile(latest, current)) fail("CONFIG_CHANGED", "Configuration changed after review");
      revalidateDevSpaceRootPlan({ plan, allowedRoots: roots(this.#codec.decode(latest.bytes.toString("utf8"))), ...this.#policy });
    };
    readAndCheck();
    if (await this.#service.canQuiesce() !== true) fail("SERVICE_NOT_MANAGED", "The local backend cannot be safely stopped and verified");
    this.#assertAvailable();
    this.#applying = true;
    const lock = this.#lockPath();
    const backup = path.join(this.#storage, `transaction-${randomUUID()}`);
    let locked = false, serviceTouched = false, installed = false, candidate = null, phase = "prepared";
    const journal = path.join(backup, "journal.json");
    const record = (state) => {
      const bytes = Buffer.from(JSON.stringify({ version: 1, phase: state, before: current.digest, after: hash(next) }) + "\n");
      if (fs.existsSync(journal)) replaceIfCurrent(journal, readOwnedFile(journal), bytes, 0o600);
      else createDurable(journal, bytes);
      syncDirectory(backup);
      phase = state;
    };
    const verify = async (list, operation) => {
      // The adapter must prove policy activation, not just process liveness.
      const proof = await this.#service.startAndVerify({ roots: [...list], operation });
      return proof?.effectivePolicyVerified === true && same(proof.roots, list);
    };
    try {
      createDurable(lock, Buffer.from(path.basename(backup) + "\n")); locked = true;
      syncDirectory(this.#storage);
      fs.mkdirSync(backup, { mode: 0o700 });
      createDurable(path.join(backup, "before.jsonc"), current.bytes);
      record("prepared");
      readAndCheck();
      serviceTouched = true;
      record("quiescing");
      if (await this.#service.quiesce() !== true) fail("QUIESCE_FAILED", "The managed backend did not confirm quiescence");
      readAndCheck();
      record("writing");
      replaceIfCurrent(this.#file, current, next, current.mode);
      installed = true;
      candidate = readOwnedFile(this.#file);
      if (candidate.digest !== hash(next)) fail("CONFIG_CHANGED", "The written candidate was replaced");
      record("verifying");
      if (!await verify(plan.after, plan.operation)) fail("ACTIVATION_FAILED", "The new policy was not verified by the backend");
      if (!sameFile(readOwnedFile(this.#file), candidate)) fail("CONFIG_CHANGED", "Configuration changed during verification");
      record("committed");
      fs.unlinkSync(lock); locked = false; syncDirectory(this.#storage);
      return { status: "committed", roots: [...plan.after], backup };
    } catch (error) {
      if (!locked) throw error;
      if (phase === "committed") fail("RECOVERY_REQUIRED", "Commit finalization needs local review; transaction evidence retained");
      try {
        const latest = readOwnedFile(this.#file);
        if (installed || (phase === "writing" && latest.digest === hash(next))) {
          if (!candidate || !sameFile(latest, candidate)) fail("CONFIG_CHANGED", "Candidate identity is uncertain; manual recovery required");
          if (await this.#service.quiesce() !== true) fail("QUIESCE_FAILED", "Cannot safely roll back a running service");
          const saved = readOwnedFile(path.join(backup, "before.jsonc"));
          if (saved.digest !== current.digest) fail("BACKUP_CHANGED", "Backup no longer matches reviewed configuration");
          record("rolling_back");
          replaceIfCurrent(this.#file, candidate, saved.bytes, current.mode);
        } else if (!sameFile(latest, current)) {
          fail("CONFIG_CHANGED", "External edit detected; do not overwrite it");
        }
        if (serviceTouched && !await verify(plan.before, { type: "rollback" })) fail("ROLLBACK_FAILED", "Previous policy could not be verified");
        if (readOwnedFile(this.#file).digest !== current.digest) fail("CONFIG_CHANGED", "Configuration changed during rollback");
        if (fs.existsSync(backup)) record("rolled_back");
        fs.unlinkSync(lock); locked = false; syncDirectory(this.#storage);
      } catch {
        // Preserve lock, backup and journal for deliberate local recovery.
        fail("RECOVERY_REQUIRED", "Automatic recovery was not verified; review the retained transaction before proceeding");
      }
      return { status: "rolled_back", reason: error?.code || "TRANSACTION_FAILED", backup };
    } finally { this.#applying = false; }
  }
}
