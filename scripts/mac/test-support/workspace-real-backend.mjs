// Isolated integration against an explicitly supplied test DevSpace package.
// No real Mac configuration, credentials, launchd jobs or service ports.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const packageRoot = process.env.CODAS_DEVSPACE_FIXTURE_PACKAGE;
if (!packageRoot || !path.isAbsolute(packageRoot)) throw Error("Supply the absolute isolated fixture package path");
const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "codas-real-devspace-fixture-")));
process.env.HOME = home;
process.env.DEVSPACE_CONFIG_DIR = path.join(home, ".devspace");
process.env.XDG_CONFIG_HOME = path.join(home, ".config");
process.env.XDG_DATA_HOME = path.join(home, ".local/share");
delete process.env.DEVSPACE_OAUTH_OWNER_TOKEN;
const { createServer } = await import(pathToFileURL(path.join(packageRoot, "dist/server.js")));
const { loadConfig } = await import(pathToFileURL(path.join(packageRoot, "dist/config.js")));
const { createRouterServer } = await import("../../../src/server.js");
const { DeviceRegistry } = await import("../../../src/device-registry.js");
const { RoutingPolicy } = await import("../../../src/routing-policy.js");
const { WorkspaceBindingStore } = await import("../../../src/workspace-bindings.js");
const { LocalRootTransaction, inspectLocalRootConfig, makeJSONCRootCodec } = await import("../../../src/local-root-transaction.js");
const { createLocalWorkspaceProbe, createVerifiedRootService } = await import("../../../src/mac-workspace-service.js");
const codec = makeJSONCRootCodec(createRequire(path.join(packageRoot, "package.json"))("jsonc-parser"));
const old = path.join(home, "Existing"), added = path.join(home, "New");
const configDir = process.env.DEVSPACE_CONFIG_DIR;
const configFile = path.join(configDir, "config.jsonc"), journalDirectory = path.join(configDir, "journal");
for (const dir of [old, added, configDir, journalDirectory]) fs.mkdirSync(dir, { mode: 0o700 });
const listen = (server, port = 0) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => resolve(server.address().port)); });
const close = (server) => new Promise((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections?.(); });
const reserve = net.createServer();
const backendPort = await listen(reserve);
await close(reserve);
fs.writeFileSync(configFile, JSON.stringify({ configVersion: 1, server: { host: "127.0.0.1", port: backendPort, publicBaseUrl: `http://127.0.0.1:${backendPort}` }, workspaces: { allowedRoots: [old], worktreeRoot: path.join(home, "Worktrees") }, storage: { stateDir: path.join(home, "State") }, skills: { enabled: false, agentDir: path.join(home, "Agents") }, subagents: { enabled: false, providers: [] }, logging: { requests: false, toolCalls: false, shellCommands: false } }, null, 2), { mode: 0o600 });
fs.writeFileSync(path.join(configDir, "auth.json"), JSON.stringify({ ownerToken: randomBytes(32).toString("hex") }), { mode: 0o600 });
let service, listener, router, probe;
async function startBackend() {
  service = createServer(loadConfig(process.env));
  listener = await new Promise((resolve, reject) => { const server = service.app.listen(backendPort, "127.0.0.1", () => resolve(server)); server.once("error", reject); });
}
async function stopBackend() {
  if (listener) { const server = listener; listener = null; await close(server); }
  if (service) { const instance = service; service = null; await instance.close(); }
}
try {
  await startBackend();
  const devices = new DeviceRegistry();
  devices.register({ id: "fixture-mac", label: "Fixture", platform: "darwin", presence: "static", roots: [home] });
  const bindings = await new WorkspaceBindingStore().load();
  const runtime = { localDeviceId: "fixture-mac", devices, bindings, routing: new RoutingPolicy({ devices, bindings }), catalog: { list: () => [{ id: "fixture-mac", name: "Fixture", platform: "darwin", kind: "router" }] } };
  router = createRouterServer({ backendHost: "127.0.0.1", backendPort, backendTimeoutMs: 15000 }, runtime);
  const routerPort = await listen(router);
  probe = createLocalWorkspaceProbe({ home, backendOrigin: `http://127.0.0.1:${backendPort}`, routerOrigin: `http://127.0.0.1:${routerPort}` });
  assert.equal(await probe.covers([old, added]), true);
  assert.equal(await probe.verify([old]), true);
  assert.equal(await probe.verify([old, added]), false);
  const inspect = () => inspectLocalRootConfig(configFile, codec);
  const managed = { async canQuiesce() { return !!listener; }, async quiesce() { await stopBackend(); return true; }, async start() { await startBackend(); return true; } };
  const controller = new LocalRootTransaction({ configFile, journalDirectory, codec, home, service: createVerifiedRootService({ managed, probe, before: [old], after: [old, added], inspect }) });
  const plan = controller.preview({ type: "add", path: added });
  const result = await controller.apply(plan.id);
  assert.equal(result.status, "committed");
  assert.deepEqual(inspect().roots, [old, added]);
  assert.equal(await probe.verify([old, added]), true);
  assert.equal(await probe.close(), true);
  probe = null;
  console.log("PASS: real isolated DevSpace + Codas Router OAuth/MCP, denied before grant, actual service recreation, new root admission, negative probe, temporary token revocation");
} finally {
  if (probe) await probe.close();
  if (router) await close(router);
  await stopBackend();
  fs.rmSync(home, { recursive: true, force: true });
}
