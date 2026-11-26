import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { normalizeCoreDevice } from "../src/device-display.js";
import { coreDeviceInfo, detectLocalFormFactor, macFormFactor, windowsFormFactor } from "../src/core-device-info.js";
import { createRouterRuntime } from "../src/runtime.js";
import { createRouterServer } from "../src/server.js";

test("display metadata selects only the versioned, bounded display fields", () => {
  const raw = { version: 1, name: " Fixture Core ", platform: "darwin", formFactor: "laptop", token: "ignored" };
  assert.deepEqual(normalizeCoreDevice(raw), {
    version: 1, name: "Fixture Core", platform: "darwin", formFactor: "laptop"
  });
  assert.deepEqual(normalizeCoreDevice({ version: 1, name: "Core", platform: "win32" }),
    { version: 1, name: "Core", platform: "win32", formFactor: "unknown" });
  for (const bad of [null, [], {}, { ...raw, version: 2 }, { ...raw, name: "\nInjected" },
    { ...raw, name: "a".repeat(65) }, { ...raw, platform: "anything" }, { ...raw, formFactor: {} }]) {
    assert.equal(normalizeCoreDevice(bad), null);
  }
});

test("hardware shape is derived from hardware, never a registry label", async () => {
  assert.equal(macFormFactor({ SPHardwareDataType: [{ machine_name: "MacBook Air" }] }), "laptop");
  assert.equal(macFormFactor({ SPHardwareDataType: [{ machine_name: "Mac mini" }] }), "desktop");
  assert.equal(macFormFactor({ SPHardwareDataType: [{ machine_name: "Other" }] }), "unknown");
  assert.equal(windowsFormFactor([3]), "desktop");
  assert.equal(windowsFormFactor([9, 10]), "laptop");
  assert.equal(windowsFormFactor([3, 9]), "unknown");
  assert.equal(windowsFormFactor([0]), "unknown");
  assert.equal(await detectLocalFormFactor("darwin", async () => ({
    stdout: JSON.stringify({ SPHardwareDataType: [{ machine_name: "MacBook Pro", serial_number: "ignored" }] })
  })), "laptop");
  assert.equal(await detectLocalFormFactor("win32", async () => ({ stdout: "[6,7]" })), "desktop");
  assert.equal(await detectLocalFormFactor("darwin", async () => { throw Error("not available"); }), "unknown");
});

test("core display uses the coordinator's own local catalog, not enrolled agent metadata", () => {
  const runtime = {
    localDeviceId: "fixture-core", localFormFactor: "desktop",
    catalog: new Map([["fixture-core", { name: "Fixture Core" }], ["agent", { name: "Agent" }]]),
    devices: new Map([["fixture-core", { label: "Fallback", platform: "win32", roots: ["private"] }]])
  };
  assert.deepEqual(coreDeviceInfo(runtime), { version: 1, name: "Fixture Core", platform: "win32", formFactor: "desktop" });
  runtime.catalog.set("fixture-core", { name: "\u202eInvalid" });
  assert.equal(coreDeviceInfo(runtime).name, "Fallback");
  runtime.localFormFactor = undefined;
  assert.equal(coreDeviceInfo(runtime).formFactor, "unknown");
});

test("authenticated legacy and leased SSE ready retain v1 identity and add only optional Core display info", async (t) => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "codas-core-display-"));
  const config = { stateDir, localDeviceId: "fixture-core", localDeviceLabel: "Fixture Core",
    localRoots: [stateDir], backendHost: "127.0.0.1", backendPort: 1 };
  const runtime = await createRouterRuntime(config);
  runtime.localFormFactor = "desktop";
  const server = createRouterServer(config, runtime);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    runtime.agentHub.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(stateDir, { recursive: true, force: true });
  });
  const base = "http://127.0.0.1:" + server.address().port + "/_codassol/agent";
  const denied = await fetch(base + "/events");
  assert.equal(denied.status, 401);
  assert.equal((await denied.text()).includes("coreDevice"), false);
  for (const leased of [false, true]) {
    const id = leased ? "fixture-leased" : "fixture-legacy";
    const enrolled = await fetch(base + "/enroll", {
      method: "POST",
      headers: { authorization: "Bearer " + runtime.privateState.pairingToken, "content-type": "application/json" },
      body: JSON.stringify({ id, label: "Fixture Agent", platform: "android", roots: [stateDir] }),
      signal: AbortSignal.timeout(5000)
    });
    assert.equal(enrolled.status, 201);
    const { agentToken } = await enrolled.json();
    const response = await fetch(base + "/events", {
      headers: { authorization: "Bearer " + agentToken, ...(leased ? { "x-codas-stream-lease": "1" } : {}) },
      signal: AbortSignal.timeout(5000)
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    try {
      let text = "";
      const decoder = new TextDecoder();
      while (!text.includes("\n\n")) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        text += decoder.decode(chunk.value, { stream: true });
      }
      assert.match(text, /^event: ready\n/);
      const ready = JSON.parse(text.split("\n").find(line => line.startsWith("data: ")).slice(6));
      assert.equal(ready.deviceId, id);
      assert.equal(ready.protocol, 1);
      assert.deepEqual(ready.coreDevice, {
        version: 1, name: "Fixture Core", platform: process.platform, formFactor: "desktop"
      });
      if (leased) {
        assert.equal(ready.leaseMs, 90_000);
        assert.equal(typeof ready.streamId, "string");
      } else {
        assert.equal(ready.streamId, undefined);
      }
    } finally { await reader.cancel(); }
  }
});
