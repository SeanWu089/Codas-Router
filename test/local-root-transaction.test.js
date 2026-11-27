import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { LocalRootTransaction, makeJSONCRootCodec } from "../src/local-root-transaction.js";

const posix = process.platform !== "win32";
const errorCode = (code) => (error) => error?.code === code;
const codec = {
  decode: JSON.parse,
  replaceRoots(text, next) {
    const config = JSON.parse(text);
    config.workspaces.allowedRoots = next;
    return JSON.stringify(config, null, 2) + "\n";
  }
};

function fixture(t, hooks = {}, overrideCodec = codec) {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "codas-root-tx-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const configDir = path.join(home, "Config"), storage = path.join(home, "Journal");
  const old = path.join(home, "Projects"), added = path.join(home, "NewProjects");
  for (const dir of [configDir, storage, old, added]) fs.mkdirSync(dir, { mode: 0o700 });
  const file = path.join(configDir, "config.jsonc");
  const config = { workspaces: { allowedRoots: [old], other: true }, server: { port: 12345 }, metadata: { note: "synthetic fixture" } };
  const original = JSON.stringify(config, null, 4) + "\n";
  fs.writeFileSync(file, original, { mode: 0o600 });
  const events = [];
  const service = {
    async canQuiesce() { events.push("preflight"); return hooks.canQuiesce ? hooks.canQuiesce() : true; },
    async quiesce() { events.push("quiesce"); return hooks.quiesce ? hooks.quiesce() : true; },
    async startAndVerify(request) {
      events.push(request.operation.type);
      return hooks.startAndVerify ? hooks.startAndVerify(request, file) : { roots: JSON.parse(fs.readFileSync(file, "utf8")).workspaces.allowedRoots, effectivePolicyVerified: true };
    }
  };
  const options = { configFile: file, journalDirectory: storage, codec: overrideCodec, service, home };
  const tx = new LocalRootTransaction(options);
  const review = () => tx.preview({ type: "add", path: added });
  return { home, old, added, config, file, storage, original, events, tx, review, options };
}

test("preview is read-only; approved change preserves unrelated settings and verified backup", { skip: !posix }, async (t) => {
  const f = fixture(t);
  const plan = f.review();
  assert.equal(fs.readFileSync(f.file, "utf8"), f.original);
  assert.deepEqual(f.events, []);
  assert.deepEqual(fs.readdirSync(f.storage), []);
  const result = await f.tx.apply(plan.id);
  assert.equal(result.status, "committed");
  assert.deepEqual(f.events, ["preflight", "quiesce", "add"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, "utf8")), { ...f.config, workspaces: { ...f.config.workspaces, allowedRoots: [f.old, f.added] } });
  assert.equal(fs.readFileSync(path.join(result.backup, "before.jsonc"), "utf8"), f.original);
  assert.equal(fs.statSync(path.join(result.backup, "before.jsonc")).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.backup, "journal.json"), "utf8")).phase, "committed");
  assert.equal(fs.existsSync(path.join(f.storage, "active")), false);
  await assert.rejects(f.tx.apply(plan.id), errorCode("UNKNOWN_APPROVAL"));
});

test("forged approval and stale plan never write configuration or restart service", { skip: !posix }, async (t) => {
  const f = fixture(t);
  const first = f.review();
  const fresh = f.review();
  await assert.rejects(f.tx.apply(first.id), errorCode("UNKNOWN_APPROVAL"));
  await assert.rejects(f.tx.apply("forged"), errorCode("UNKNOWN_APPROVAL"));
  fs.appendFileSync(f.file, "\n");
  await assert.rejects(f.tx.apply(fresh.id), errorCode("CONFIG_CHANGED"));
  assert.deepEqual(f.events, []);
  assert.equal(fs.readFileSync(f.file, "utf8"), f.original + "\n");
});

test("configuration editor that changes unrelated settings is rejected", { skip: !posix }, async (t) => {
  const f = fixture(t, {}, { ...codec, replaceRoots(text, next) {
    const value = JSON.parse(codec.replaceRoots(text, next));
    value.server.port = 1;
    return JSON.stringify(value);
  } });
  await assert.rejects(f.tx.apply(f.review().id), errorCode("UNRELATED_CONFIG_CHANGE"));
  assert.deepEqual(f.events, []);
  assert.equal(fs.readFileSync(f.file, "utf8"), f.original);
});

test("unmanaged backend is never stopped or edited", { skip: !posix }, async (t) => {
  const f = fixture(t, { canQuiesce: () => false });
  await assert.rejects(f.tx.apply(f.review().id), errorCode("SERVICE_NOT_MANAGED"));
  assert.deepEqual(f.events, ["preflight"]);
  assert.equal(fs.readFileSync(f.file, "utf8"), f.original);
});

test("failed activation or merely healthy process restores exact original bytes", { skip: !posix }, async (t) => {
  const f = fixture(t, { startAndVerify: ({ roots, operation }) => ({ roots, effectivePolicyVerified: operation.type === "rollback", healthy: true }) });
  const result = await f.tx.apply(f.review().id);
  assert.equal(result.status, "rolled_back");
  assert.equal(result.reason, "ACTIVATION_FAILED");
  assert.equal(fs.readFileSync(f.file, "utf8"), f.original);
  assert.deepEqual(f.events, ["preflight", "quiesce", "add", "quiesce", "rollback"]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.backup, "journal.json"), "utf8")).phase, "rolled_back");
  assert.equal(fs.existsSync(path.join(f.storage, "active")), false);
});

test("restart exception restores the original configuration and verifies rollback", { skip: !posix }, async (t) => {
  const f = fixture(t, { startAndVerify: ({ roots, operation }) => {
    if (operation.type !== "rollback") throw Error("injected restart failure");
    return { roots, effectivePolicyVerified: true };
  } });
  const result = await f.tx.apply(f.review().id);
  assert.equal(result.status, "rolled_back");
  assert.equal(fs.readFileSync(f.file, "utf8"), f.original);
});

test("failure to quiesce does not write the candidate", { skip: !posix }, async (t) => {
  const f = fixture(t, { quiesce: () => false });
  const result = await f.tx.apply(f.review().id);
  assert.equal(result.status, "rolled_back");
  assert.equal(result.reason, "QUIESCE_FAILED");
  assert.equal(fs.readFileSync(f.file, "utf8"), f.original);
  assert.deepEqual(f.events, ["preflight", "quiesce", "rollback"]);
});

test("rollback verification failure keeps journal and blocks all new transactions", { skip: !posix }, async (t) => {
  const f = fixture(t, { startAndVerify: ({ roots }) => ({ roots, effectivePolicyVerified: false }) });
  await assert.rejects(f.tx.apply(f.review().id), errorCode("RECOVERY_REQUIRED"));
  assert.equal(fs.readFileSync(f.file, "utf8"), f.original);
  assert.equal(fs.existsSync(path.join(f.storage, "active")), true);
  assert.throws(() => f.review(), errorCode("TRANSACTION_PENDING"));
  const restarted = new LocalRootTransaction(f.options);
  assert.throws(() => restarted.preview({ type: "add", path: f.added }), errorCode("TRANSACTION_PENDING"));
});

test("external config changes while applying are never overwritten by rollback", { skip: !posix }, async (t) => {
  const f = fixture(t, { startAndVerify: ({ roots }, file) => {
    fs.writeFileSync(file, '{"externalEdit":true}\n');
    return { roots, effectivePolicyVerified: false };
  } });
  await assert.rejects(f.tx.apply(f.review().id), errorCode("RECOVERY_REQUIRED"));
  assert.equal(fs.readFileSync(f.file, "utf8"), '{"externalEdit":true}\n');
  assert.equal(fs.existsSync(path.join(f.storage, "active")), true);
});

test("config modification during quiesce aborts instead of writing stale content", { skip: !posix }, async (t) => {
  const f = fixture(t, { quiesce: () => { fs.appendFileSync(f.file, "\n"); return true; } });
  await assert.rejects(f.tx.apply(f.review().id), errorCode("RECOVERY_REQUIRED"));
  assert.equal(fs.readFileSync(f.file, "utf8"), f.original + "\n");
  assert.deepEqual(f.events, ["preflight", "quiesce"]);
});

test("symlink, hardlink and writable config files fail closed", { skip: !posix }, (t) => {
  const f = fixture(t);
  const real = path.join(path.dirname(f.file), "original.jsonc");
  fs.renameSync(f.file, real);
  fs.symlinkSync(real, f.file);
  assert.throws(() => f.review());
  fs.unlinkSync(f.file);
  fs.linkSync(real, f.file);
  assert.throws(() => f.review(), errorCode("UNSAFE_CONFIG_FILE"));
  fs.unlinkSync(f.file);
  fs.renameSync(real, f.file);
  fs.chmodSync(f.file, 0o666);
  assert.throws(() => f.review(), errorCode("UNSAFE_CONFIG_FILE"));
});

test("removal requires effective denial proof through the service adapter", { skip: !posix }, async (t) => {
  const f = fixture(t, { startAndVerify: ({ roots, operation }) => ({ roots, effectivePolicyVerified: operation.type === "rollback" }) });
  const config = structuredClone(f.config);
  config.workspaces.allowedRoots.push(f.added);
  fs.writeFileSync(f.file, JSON.stringify(config));
  const original = fs.readFileSync(f.file, "utf8");
  const plan = f.tx.preview({ type: "remove", index: 1, expectedPath: f.added });
  const result = await f.tx.apply(plan.id);
  assert.equal(result.status, "rolled_back");
  assert.equal(fs.readFileSync(f.file, "utf8"), original);
  assert.deepEqual(f.events, ["preflight", "quiesce", "remove", "quiesce", "rollback"]);
});

test("a second controller cannot edit while a transaction is active", { skip: !posix }, async (t) => {
  let unblock, entered;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const release = new Promise((resolve) => { unblock = resolve; });
  const f = fixture(t, { quiesce: async () => { entered(); await release; return true; } });
  const other = new LocalRootTransaction(f.options);
  const otherPlan = other.preview({ type: "add", path: f.added });
  const active = f.tx.apply(f.review().id);
  await waiting;
  try {
    await assert.rejects(other.apply(otherPlan.id), errorCode("TRANSACTION_PENDING"));
    assert.throws(() => other.preview({ type: "add", path: f.added }), errorCode("TRANSACTION_PENDING"));
  } finally { unblock(); }
  assert.equal((await active).status, "committed");
});

test("changed journal permissions prevent a configuration edit", { skip: !posix }, async (t) => {
  const f = fixture(t);
  const plan = f.review();
  fs.chmodSync(f.storage, 0o755);
  await assert.rejects(f.tx.apply(plan.id), errorCode("UNSAFE_JOURNAL"));
  assert.deepEqual(f.events, []);
  assert.equal(fs.readFileSync(f.file, "utf8"), f.original);
});

// The core package has no dependency on DevSpace's installation. Exercise
// the exact parser adapter when an independently installed fixture module
// is supplied by the Mac build/test controller. No production config is read.
const jsoncModule = process.env.CODAS_JSONC_FIXTURE_MODULE;
test("real JSONC codec retains comments, trailing commas and unrelated settings", { skip: !jsoncModule }, () => {
  const parser = createRequire(import.meta.url)(jsoncModule);
  const adapter = makeJSONCRootCodec(parser);
  const text = '{\n  // Existing service settings\n  "server": {"port": 12345},\n  "workspaces": {\n    // Owner-approved roots\n    "allowedRoots": ["/fixture/old"],\n    "other": true,\n  },\n}\n';
  const updated = adapter.replaceRoots(text, ["/fixture/old", "/fixture/new"]);
  assert.match(updated, /\/\/ Existing service settings/);
  assert.match(updated, /\/\/ Owner-approved roots/);
  assert.deepEqual(adapter.decode(updated), { server: { port: 12345 }, workspaces: { allowedRoots: ["/fixture/old", "/fixture/new"], other: true } });
});

test("real JSONC codec rejects malformed, duplicate and prototype-mutating properties", { skip: !jsoncModule }, () => {
  const adapter = makeJSONCRootCodec(createRequire(import.meta.url)(jsoncModule));
  for (const invalid of ['{"workspaces":', '{"workspaces":{},"workspaces":{}}', '{"workspaces":{"allowedRoots":[],"allowedRoots":["/fixture"]}}', '{"__proto__":{"workspaces":{}}}']) {
    assert.throws(() => adapter.decode(invalid), errorCode("INVALID_CONFIG"));
  }
});

test("full transaction with actual JSONC preserves comments and exact rollback bytes", { skip: !posix || !jsoncModule }, async (t) => {
  const adapter = makeJSONCRootCodec(createRequire(import.meta.url)(jsoncModule));
  const f = fixture(t, { startAndVerify: (request, file) => ({
    roots: adapter.decode(fs.readFileSync(file, "utf8")).workspaces.allowedRoots,
    effectivePolicyVerified: request.operation.type === "rollback"
  }) }, adapter);
  const original = '{\n  // Keep this comment\n  "workspaces": {"allowedRoots": [' + JSON.stringify(f.old) + '],},\n  "server": {"port": 12345},\n}\n';
  fs.writeFileSync(f.file, original);
  const result = await f.tx.apply(f.review().id);
  assert.equal(result.status, "rolled_back");
  assert.equal(fs.readFileSync(f.file, "utf8"), original);
  assert.equal(fs.readFileSync(path.join(result.backup, "before.jsonc"), "utf8"), original);
});
