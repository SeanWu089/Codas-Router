import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMacManagedDevSpace, createLocalWorkspaceProbe, createVerifiedRootService, restrictLocalFetch } from "../src/mac-workspace-service.js";

const posix = process.platform !== "win32";
const result = (stdout = "", code = 0, stderr = "") => ({ stdout, code, stderr });
function serviceFixture(t) {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "codas-service-fixture-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const label = "com.codassol.devspace.mac";
  const plist = path.join(home, "Library/LaunchAgents", label + ".plist");
  const runner = path.join(home, "Library/Application Support/CodasSol-mac/devspace-runner.zsh");
  const cli = path.join(home, "fixture-devspace/dist/cli.js");
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(plist, "fixture", { mode: 0o600 });
  const contract = { Label: label, ProgramArguments: ["/bin/zsh", runner, "--serve"], WorkingDirectory: home, EnvironmentVariables: { PATH: "/usr/bin:/bin" } };
  const state = { loaded: true, listener: 41, pid: 41, failStart: false, foreign: false, bootouts: 0, bootstraps: 0 };
  const run = (command, args) => {
    if (command === "/usr/bin/plutil") return result(JSON.stringify(contract));
    if (command === "/usr/sbin/lsof") return state.listener ? result(String(state.listener) + "\n") : result("", 1);
    if (command === "/bin/ps") return result(args.at(-1) === "uid=" ? String(process.getuid()) : state.foreign ? "unrelated process" : `/usr/local/bin/node ${cli} serve`);
    if (command === "/bin/launchctl") {
      if (args[0] === "print") return state.loaded ? result(`path = ${plist}\n${state.pid ? `pid = ${state.pid}\n` : ""}`) : result("", 1);
      if (args[0] === "bootout") { state.bootouts++; state.loaded = false; state.listener = null; state.pid = null; return result(); }
      if (args[0] === "bootstrap") { state.bootstraps++; state.loaded = true; state.pid = state.failStart ? null : 55; state.listener = state.pid; return result(); }
    }
    throw Error("Unexpected fixture command");
  };
  return { state, contract, managed: createMacManagedDevSpace({ home, cli, run, delay: async () => {} }) };
}

test("managed macOS adapter only stops its positively identified listener and restarts the same job", { skip: !posix }, async (t) => {
  const f = serviceFixture(t);
  assert.equal(await f.managed.canQuiesce(), true);
  assert.equal(await f.managed.quiesce(), true);
  assert.equal(await f.managed.quiesce(), true);
  assert.equal(f.state.bootouts, 1);
  assert.equal(await f.managed.start(), true);
  assert.equal(f.state.bootstraps, 1);
  assert.equal(f.state.listener, 55);
});

test("foreign listener, unrecognized command and custom config environment cannot be stopped", { skip: !posix }, async (t) => {
  const f = serviceFixture(t);
  f.state.listener = 999;
  assert.equal(await f.managed.canQuiesce(), false);
  assert.equal(await f.managed.quiesce(), false);
  f.state.listener = 41; f.state.foreign = true;
  assert.equal(await f.managed.canQuiesce(), false);
  f.state.foreign = false; f.contract.EnvironmentVariables.DEVSPACE_CONFIG_DIR = "/fixture/other";
  assert.equal(await f.managed.canQuiesce(), false);
  assert.equal(f.state.bootouts, 0);
});

test("a failed newly launched job can be stopped for restoration, not an unrelated job", { skip: !posix }, async (t) => {
  const f = serviceFixture(t);
  assert.equal(await f.managed.quiesce(), true);
  f.state.failStart = true;
  assert.equal(await f.managed.start(), false);
  assert.equal(await f.managed.quiesce(), true);
  assert.equal(f.state.bootouts, 2);
  f.state.failStart = false;
  assert.equal(await f.managed.start(), true);
});

test("local probe rejects non-loopback requests and never follows redirects", async () => {
  let called = false;
  const fetch = restrictLocalFetch(async (url, options) => {
    called = true; assert.equal(url.origin, "http://127.0.0.1:7676"); assert.equal(options.redirect, "manual"); return new Response(null, { status: 302 });
  });
  assert.throws(() => fetch("https://example.com/mcp"), (error) => error.code === "NONLOCAL_PROBE");
  assert.equal(called, false);
  await fetch("http://127.0.0.1:7676/mcp", { redirect: "follow" });
  assert.equal(called, true);
});

function probeFixture(t) {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "codas-probe-fixture-")));
  const old = path.join(home, "Old"), added = path.join(home, "Added");
  fs.mkdirSync(old); fs.mkdirSync(added);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const state = { roots: [old], routingRoots: [home], failure: null, revoked: 0, requests: [] };
  const auth = { oauthState: { clientId: "fixture-client", accessToken: "fixture-access", refreshToken: "fixture-refresh" }, async accessToken() { return "fixture-access"; } };
  const fetchFn = async (url, options) => {
    assert.equal(options.redirect, "manual");
    if (url.pathname === "/revoke") { state.revoked++; return new Response(null, { status: 200 }); }
    assert.equal(url.origin, "http://127.0.0.1:17676");
    const message = JSON.parse(options.body);
    const { name, arguments: args } = message.params;
    state.requests.push(name);
    let payload;
    if (name === "codassol_list_devices") payload = { structuredContent: { localDeviceId: "fixture-mac", devices: [{ id: "fixture-mac", platform: "darwin", isThisDevice: true, authorizedRoots: state.routingRoots }] } };
    else {
      assert.equal(args.device_id, "fixture-mac");
      if (state.roots.includes(args.path)) payload = { structuredContent: { workspace_id: "ws_fixture", root: args.path, mode: "checkout" } };
      else if (state.failure === "auth") return new Response(null, { status: 401 });
      else if (state.failure === "transport") return new Response(null, { status: 502 });
      else if (state.failure === "unexpected-allow") payload = { structuredContent: { workspace_id: "ws_fixture", root: args.path } };
      else payload = { isError: true, content: [{ type: "text", text: "Path is outside allowed roots" }] };
    }
    const data = { jsonrpc: "2.0", id: message.id, result: payload };
    // Match the streamed MCP path, including an unrelated notification.
    return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" })}\n\nevent: message\ndata: ${JSON.stringify(data)}\n\n`, { headers: { "content-type": "text/event-stream" } });
  };
  return { home, old, added, state, auth, probe: createLocalWorkspaceProbe({ home, oauth: auth, fetchFn }) };
}

test("actual probe contract requires explicit local routing, real positive result and explicit denial", async (t) => {
  const f = probeFixture(t);
  assert.equal(await f.probe.covers([f.old, f.added]), true);
  assert.equal(await f.probe.verify([f.old]), true);
  assert.equal(await f.probe.verify([f.old, f.added]), false);
  f.state.roots.push(f.added);
  assert.equal(await f.probe.verify([f.old, f.added]), true);
  assert.deepEqual(fs.readdirSync(f.home).sort(), ["Added", "Old"]);
  f.state.routingRoots = [f.old];
  assert.equal(await f.probe.covers([f.old, f.added]), false);
  assert.equal(await f.probe.close(), true);
  assert.equal(f.state.revoked, 2);
  assert.equal(f.auth.oauthState.accessToken, null);
});

test("authentication failure, transport failure and unexpected positive result are not authorization denials", async (t) => {
  const f = probeFixture(t);
  for (const failure of ["auth", "transport", "unexpected-allow"]) {
    f.state.failure = failure;
    assert.equal(await f.probe.verify([f.old]), false, failure);
  }
});

test("verification adapter rejects a config-only or route-only success", async (t) => {
  const f = probeFixture(t);
  let disk = [f.old];
  const managed = { async canQuiesce() { return true; }, async quiesce() { return true; }, async start() { return true; } };
  const service = createVerifiedRootService({ managed, probe: f.probe, before: [f.old], after: [f.old, f.added], inspect: () => ({ roots: disk }) });
  assert.equal(await service.canQuiesce(), true);
  assert.equal((await service.startAndVerify({ roots: [f.old, f.added] })).effectivePolicyVerified, false);
  disk = [f.old, f.added];
  assert.equal((await service.startAndVerify({ roots: disk })).effectivePolicyVerified, false);
  f.state.roots = disk;
  assert.equal((await service.startAndVerify({ roots: disk })).effectivePolicyVerified, true);
});
