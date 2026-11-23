import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { enrollAgent, runAgent } from "../src/agent.js";
import { AgentHub } from "../src/agent-hub.js";
import { consumeAgentEvents } from "../src/agent-sse.js";
import { createRouterRuntime } from "../src/runtime.js";
import { createRouterServer } from "../src/server.js";

async function mock(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function until(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "condition timed out");
    await delay(5);
  }
}

function config(routerUrl, baseUrl, oauth) {
  return {
    load: async () => ({
      routerUrl, agentToken: "test-token", device: { roots: [], capabilities: [] },
      devspace: {
        baseUrl, ownerTokenPath: "C:/nonexistent-codassol-resilience-test/auth.json",
        oauth: oauth ?? { accessToken: "test-local", accessExpiresAt: Date.now() + 3_600_000 }
      }
    }),
    save: async () => {}
  };
}

function ready(res) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write('event: ready\ndata: {"deviceId":"test"}\n\n');
}

function job(res, id, path, expiresAt = Date.now() + 5_000) {
  res.write(`event: job\ndata: ${JSON.stringify({ job: {
    id, expiresAt, payload: { type: "devspace-http", request: { path, method: "POST" } }
  } })}\n\n`);
}

function readResult(req, res, results, status = 200, code) {
  let body = "";
  req.on("data", chunk => { body += chunk; });
  req.on("end", () => {
    results.push(JSON.parse(body));
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(code ? { error: code } : { ok: true }));
  });
}

test("SSE hung HTTP body retains heartbeats, times out and executes the next job once", async t => {
  const executions = [];
  let beats = 0;
  const results = [];
  const backend = await mock(t, (req, res) => {
    executions.push(req.url);
    if (req.url === "/hung") { res.writeHead(200); res.write("partial"); }
    else res.end("next-ok");
  });
  const router = await mock(t, (req, res) => {
    if (req.url.endsWith("/events")) {
      ready(res); job(res, "hung", "/hung"); job(res, "next", "/next");
    } else if (req.url.endsWith("/heartbeat")) { beats++; res.end("{}"); }
    else readResult(req, res, results);
  });
  const stop = new AbortController();
  const running = runAgent({ configStore: config(router, backend), signal: stop.signal,
    heartbeatIntervalMs: 20, jobTimeoutMs: 180 });
  try {
    await until(() => results.length === 2);
    assert.ok(beats >= 3, `expected independent heartbeats, observed ${beats}`);
    assert.equal(results[0].ok, false);
    assert.equal(results[1].ok, true);
    assert.deepEqual(executions, ["/hung", "/next"]);
  } finally { stop.abort(); await running; }
});

test("job expiry bounds the HTTP body and skips an expired job already buffered on SSE", async t => {
  const executions = [], results = [];
  const backend = await mock(t, (req, res) => {
    executions.push(req.url);
    if (req.url === "/hung") { res.writeHead(200); res.write("partial"); }
    else res.end("ok");
  });
  const router = await mock(t, (req, res) => {
    if (req.url.endsWith("/events")) {
      ready(res);
      job(res, "hung", "/hung", Date.now() + 150);
      job(res, "expired", "/must-not-run", Date.now() + 75);
      job(res, "next", "/next");
    } else if (req.url.endsWith("/heartbeat")) res.end("{}");
    else readResult(req, res, results);
  });
  const stop = new AbortController();
  const running = runAgent({ configStore: config(router, backend), signal: stop.signal, jobTimeoutMs: 2_000 });
  try {
    await until(() => results.some(result => result.jobId === "next"), 1_000);
    assert.deepEqual(executions, ["/hung", "/next"]);
    assert.deepEqual(results.map(result => result.jobId), ["next"]);
  } finally { stop.abort(); await running; }
});

test("the job deadline also covers a hanging OAuth refresh body", async t => {
  const paths = [], results = [];
  const backend = await mock(t, (req, res) => {
    paths.push(req.url);
    res.writeHead(200, { "content-type": "application/json" }); res.write("{");
  });
  const router = await mock(t, (req, res) => {
    if (req.url.endsWith("/events")) { ready(res); job(res, "oauth", "/must-not-run"); }
    else if (req.url.endsWith("/heartbeat")) res.end("{}");
    else readResult(req, res, results);
  });
  const stop = new AbortController();
  const running = runAgent({ configStore: config(router, backend, {
    clientId: "test-client", refreshToken: "test-refresh", resource: `${backend}/mcp`
  }), signal: stop.signal, jobTimeoutMs: 120 });
  try {
    await until(() => results.length === 1);
    assert.equal(results[0].ok, false);
    assert.deepEqual(paths, ["/token"]);
  } finally { stop.abort(); await running; }
});

test("explicit poll keeps a serial heartbeat lane while poll and body are blocked", async t => {
  let beats = 0, beatActive = 0, maxBeats = 0, polls = 0;
  const results = [];
  const backend = await mock(t, (_req, res) => { res.writeHead(200); res.write("partial"); });
  const router = await mock(t, (req, res) => {
    if (req.url.endsWith("/heartbeat")) {
      beats++; beatActive++; maxBeats = Math.max(maxBeats, beatActive);
      res.once("close", () => { beatActive--; });
      setTimeout(() => res.end("{}"), 30);
    } else if (req.url.endsWith("/poll")) {
      polls++;
      if (polls === 1) setTimeout(() => res.end(JSON.stringify({ job: {
        id: "poll-hung", payload: { type: "devspace-http" }
      } })), 120);
    } else readResult(req, res, results);
  });
  const stop = new AbortController();
  const running = runAgent({ configStore: config(router, backend), signal: stop.signal,
    transport: "poll", heartbeatIntervalMs: 10, jobTimeoutMs: 160 });
  try {
    await until(() => results.length === 1 && polls === 2);
    assert.ok(beats >= 4);
    assert.equal(maxBeats, 1);
    assert.equal(results[0].ok, false);
  } finally { stop.abort(); await running; }
});

test("poll cancellation releases its waiter while overlapping consumers remain rejected", async () => {
  const hub = new AgentHub();
  const stop = new AbortController();
  const pending = hub.poll("test", { signal: stop.signal });
  await assert.rejects(hub.poll("test"), { code: "AGENT_CONSUMER_ACTIVE" });
  assert.throws(() => hub.subscribe("test", () => true), { code: "AGENT_CONSUMER_ACTIVE" });
  stop.abort();
  assert.equal(await pending, null);
  const completion = hub.enqueue("test", { test: true });
  const received = await hub.poll("test");
  assert.equal(hub.complete("test", received.id, "ok"), true);
  assert.equal(await completion, "ok");
});

test("stale result 409 continues the stream without replay or authentication failure", async t => {
  let executions = 0, events = 0;
  const results = [];
  const backend = await mock(t, (_req, res) => { executions++; res.end("ok"); });
  const router = await mock(t, (req, res) => {
    if (req.url.endsWith("/events")) {
      events++; ready(res); job(res, "stale", "/one"); job(res, "next", "/two");
    } else if (req.url.endsWith("/heartbeat")) res.end("{}");
    else readResult(req, res, results, results.length ? 200 : 409, results.length ? undefined : "unknown_or_mismatched_job");
  });
  const stop = new AbortController();
  const running = runAgent({ configStore: config(router, backend), signal: stop.signal });
  try {
    await until(() => results.length === 2);
    assert.equal(executions, 2);
    assert.equal(events, 1);
  } finally { stop.abort(); await running; }
});

test("HTTP authentication errors retain status and stop rather than retry", async t => {
  for (const status of [401, 403, 409]) {
    let attempts = 0;
    const router = await mock(t, (req, res) => {
      attempts++;
      res.writeHead(status, { "content-type": "text/plain" });
      res.end("denied");
    });
    await assert.rejects(runAgent({ configStore: config(router, router), transport: "poll" }), { status });
    assert.ok(attempts <= 2, `one heartbeat and one poll maximum; observed ${attempts}`);
  }
});

test("a rejected SSE heartbeat aborts a hanging job and terminates with HTTP status", async t => {
  let executing = false;
  const backend = await mock(t, (_req, res) => { executing = true; res.writeHead(200); res.write("partial"); });
  const router = await mock(t, (req, res) => {
    if (req.url.endsWith("/events")) { ready(res); job(res, "hung", "/hung"); }
    else { res.writeHead(401); res.end('{"error":"invalid_agent_token"}'); }
  });
  await assert.rejects(runAgent({ configStore: config(router, backend), heartbeatIntervalMs: 40 }), { status: 401 });
  assert.equal(executing, true);
});

test("lifetime cancellation interrupts a hanging HTTP body and a long reconnect sleep", async t => {
  for (const mode of ["body", "sleep"]) {
    let reached = false;
    const backend = await mock(t, (_req, res) => {
      reached = true; res.writeHead(200); res.write("partial");
    });
    const router = await mock(t, (req, res) => {
      if (mode === "sleep") { reached = true; req.socket.destroy(); }
      else { ready(res); job(res, "hung", "/hung"); }
    });
    const stop = new AbortController();
    const running = runAgent({ configStore: config(router, backend), signal: stop.signal });
    await until(() => reached);
    if (mode === "sleep") await delay(30);
    const start = Date.now();
    stop.abort();
    await running;
    assert.ok(Date.now() - start < 500, "stop must not wait for HTTP deadline or reconnect delay");
  }
});

test("SSE establishment and idle read have bounded deadlines and release sockets", async t => {
  for (const mode of ["headers", "idle"]) {
    let active = 0;
    const router = await mock(t, (_req, res) => {
      active++;
      res.once("close", () => { active--; });
      if (mode === "idle") ready(res);
    });
    await assert.rejects(consumeAgentEvents({
      url: router, token: "test", onJob: async () => {}, connectTimeoutMs: 100, idleTimeoutMs: 100
    }), { code: mode === "headers" ? "SSE_CONNECT_TIMEOUT" : "SSE_IDLE_TIMEOUT" });
    await until(() => active === 0);
  }
});

test("SSE keepalive bytes prevent false idle timeout and external abort clears watchdogs", async t => {
  let active = 0;
  const router = await mock(t, (_req, res) => {
    active++; ready(res);
    const timer = setInterval(() => res.write(": keepalive\n\n"), 20);
    res.once("close", () => { active--; clearInterval(timer); });
  });
  const stop = new AbortController();
  const running = consumeAgentEvents({ url: router, token: "test", signal: stop.signal,
    onJob: async () => {}, connectTimeoutMs: 100, idleTimeoutMs: 100 });
  const aborted = assert.rejects(running, { name: "AbortError" });
  await delay(250);
  assert.equal(active, 1);
  stop.abort();
  await aborted;
  await until(() => active === 0);
});

test("SSE idle watchdog pauses during a bounded slow job", async t => {
  let completed = false;
  const router = await mock(t, (_req, res) => {
    ready(res); job(res, "slow", "/slow");
  });
  const stop = new AbortController();
  const running = consumeAgentEvents({ url: router, token: "test", signal: stop.signal,
    onJob: async () => { await delay(150); completed = true; stop.abort(); },
    connectTimeoutMs: 100, idleTimeoutMs: 50 });
  await running;
  assert.equal(completed, true);
});

test("SSE consumer contention retries without eviction and recovers when the old HTTP stream closes", async t => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "codassol-consumer-recovery-"));
  t.after(() => rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  let executions = 0, requests = 0;
  const backend = await mock(t, (_req, res) => { executions++; res.end("executed-once"); });
  const routerConfig = {
    stateDir, backendHost: "127.0.0.1", backendPort: Number(new URL(backend).port),
    localDeviceId: "test-router", localRoots: [stateDir]
  };
  const runtime = await createRouterRuntime(routerConfig);
  const server = createRouterServer(routerConfig, runtime);
  server.on("request", req => { if (req.url.endsWith("/events")) requests++; });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const router = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  let saved;
  const store = { load: async () => saved, save: async value => { saved = value; return value; } };
  await enrollAgent({ routerUrl: router, pairingToken: runtime.privateState.pairingToken,
    deviceId: "test-agent", devspaceBaseUrl: backend, configStore: store });
  saved.devspace.oauth = { accessToken: "test-local", accessExpiresAt: Date.now() + 3_600_000 };
  const oldStop = new AbortController();
  const old = await fetch(`${router}/_codassol/agent/events`, {
    headers: { authorization: `Bearer ${saved.agentToken}` }, signal: oldStop.signal
  });
  assert.equal(old.status, 200);
  const stop = new AbortController();
  const retries = [];
  const running = runAgent({ configStore: store, signal: stop.signal,
    sleepFn: async ms => {
      retries.push(ms);
      // The Router still rejects another consumer: retries did not evict it.
      assert.throws(() => runtime.agentHub.subscribe("test-agent", () => true), { code: "AGENT_CONSUMER_ACTIVE" });
      if (retries.length === 2) oldStop.abort();
      await delay(50);
    }
  });
  try {
    await until(() => retries.length === 2);
    // A stale mutation queued after the old stream closes must expire before
    // the new stream can consume it; a separate valid task must run once.
    await delay(10);
    const expired = runtime.agentHub.enqueue("test-agent", {
      type: "devspace-http", request: { path: "/must-not-run" }
    }, { timeoutMs: 5 });
    await assert.rejects(expired, { code: "AGENT_JOB_TIMEOUT" });
    const result = await runtime.agentHub.enqueue("test-agent", {
      type: "devspace-http", request: { path: "/once" }
    }, { timeoutMs: 2_000 });
    assert.equal(result.statusCode, 200);
    assert.equal(executions, 1);
    assert.equal(requests, 4, "old stream, two rejected attempts, one recovered consumer");
    assert.ok(retries[0] >= 1_500 && retries[0] <= 2_500);
    assert.ok(retries[1] >= 3_000 && retries[1] <= 5_000);
  } finally {
    oldStop.abort(); stop.abort(); await running;
    await old.body.cancel().catch(() => {});
  }
});

test("SSE 409 retries only the explicit consumer conflict, never identity or authorization conflicts", async t => {
  for (const [status, payload] of [
    [409, { error: "device_id_reserved_by_router_node" }],
    [409, { error: "unrecognized-conflict" }],
    [409, null],
    [401, { error: "AGENT_CONSUMER_ACTIVE" }],
    [403, { error: "AGENT_CONSUMER_ACTIVE" }]
  ]) {
    let requests = 0;
    const router = await mock(t, (_req, res) => {
      requests++;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
    await assert.rejects(runAgent({ configStore: config(router, router) }), { status });
    assert.equal(requests, 1);
  }
});

test("SSE conflict error bodies are size and time bounded and do not expose raw text", async t => {
  for (const mode of ["large", "hung"]) {
    const router = await mock(t, (_req, res) => {
      res.writeHead(409, { "content-type": "application/json" });
      res.write(mode === "large" ? '{"error":"' + "sensitive".repeat(1_000) : "{");
    });
    await assert.rejects(consumeAgentEvents({ url: router, token: "test", onJob: async () => {},
      connectTimeoutMs: 100 }), error => {
      assert.equal(error.status, 409);
      assert.equal(error.message, "SSE connection rejected (HTTP 409)");
      return true;
    });
  }
});
