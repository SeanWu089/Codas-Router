import os from "node:os";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { AgentConfigStore } from "./agent-config.js";
import { DevSpaceLocalOAuth } from "./devspace-local-auth.js";
import { consumeAgentEvents, nextSseFailureCount, reconnectDelayMs, SseUnavailableError, SseConsumerActiveError } from "./agent-sse.js";
import { AGENT_SSE_HEARTBEAT_INTERVAL_MS } from "./agent-timing.js";

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
    if (signal?.aborted) finish();
  });
}

function cleanRouterUrl(value) {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url.href.replace(/\/$/, "");
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      options[key] = true;
    } else {
      options[key] = value;
      index += 1;
    }
  }
  return { command, options };
}

function splitRoots(value) {
  if (!value) return [];
  return String(value)
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function routerJson(url, { token, method = "POST", body, timeoutMs = 35_000, signal } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    });
    const text = await response.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : {}; } catch {
      if (response.ok) throw new Error("Router returned invalid JSON");
      parsed = {};
    }
    if (!response.ok) {
      throw Object.assign(new Error(parsed.message || parsed.error || `HTTP ${response.status}`), {
        status: response.status,
        code: parsed.error
      });
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

export async function enrollAgent({
  routerUrl,
  pairingToken,
  deviceId = os.hostname(),
  installationId,
  label = os.hostname(),
  roots = [],
  devspaceBaseUrl = "http://127.0.0.1:7676",
  configStore = new AgentConfigStore()
}) {
  const base = cleanRouterUrl(routerUrl);
  const result = await routerJson(`${base}/_codassol/agent/enroll`, {
    token: pairingToken,
    body: {
      id: deviceId,
      ...(installationId ? { installationId } : {}),
      label,
      platform: process.platform,
      roots,
      capabilities: ["devspace-http"]
    }
  });
  if (typeof result.agentToken !== "string") {
    throw new Error("Router enrollment returned no Agent token");
  }
  return configStore.save({
    routerUrl: base,
    device: {
      id: deviceId,
      label,
      platform: process.platform,
      roots,
      capabilities: ["devspace-http"]
    },
    agentToken: result.agentToken,
    devspace: {
      baseUrl: devspaceBaseUrl,
      oauth: {}
    }
  });
}

function forwardedHeaders(headers = {}) {
  const result = {};
  const blocked = new Set([
    "authorization",
    "host",
    "connection",
    "content-length",
    "transfer-encoding"
  ]);
  for (const [key, value] of Object.entries(headers)) {
    if (!blocked.has(key.toLowerCase()) && value !== undefined) {
      result[key] = String(value);
    }
  }
  return result;
}

async function executeHttpJob(configStore, config, payload, signal) {
  if (payload?.type !== "devspace-http") {
    throw Object.assign(new Error("Unsupported Agent job type"), {
      code: "UNSUPPORTED_JOB_TYPE"
    });
  }
  const oauth = new DevSpaceLocalOAuth({
    baseUrl: config.devspace.baseUrl,
    ownerTokenPath: config.devspace.ownerTokenPath,
    // The same deadline covers OAuth discovery/refresh and the entire body,
    // not just the initial arrival of response headers.
    fetchFn: (url, options = {}) => fetch(url, { ...options, signal }),
    oauthState: config.devspace.oauth || {},
    saveOAuthState: async (oauthState) => {
      config.devspace.oauth = oauthState;
      await configStore.save(config);
    }
  });
  const request = payload.request || {};
  const response = await oauth.authorizedFetch(request.path || "/mcp", {
    method: request.method || "POST",
    headers: forwardedHeaders(request.headers),
    body: request.bodyBase64
      ? Buffer.from(request.bodyBase64, "base64")
      : undefined
  });
  const body = Buffer.from(await response.arrayBuffer());
  return {
    statusCode: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    bodyBase64: body.toString("base64")
  };
}

export function isExpiredAgentJob(job, now = Date.now()) {
  // Legacy v0.1/v0.2 Routers did not send a deadline. Retain compatibility
  // during rolling upgrades; new Routers always attach expiresAt.
  return job && Object.hasOwn(job, "expiresAt") &&
    (!Number.isSafeInteger(job.expiresAt) || now >= job.expiresAt);
}

export async function runAgent({
  configStore = new AgentConfigStore(),
  stopSignal = () => false,
  replicaReceiver = null,
  sleepFn = sleep,
  transport = process.env.CODASSOL_AGENT_TRANSPORT === "poll" ? "poll" : "sse",
  signal,
  jobTimeoutMs = 55_000,
  requestTimeoutMs = 10_000,
  pollTimeoutMs = 32_000,
  sseConnectTimeoutMs = 30_000,
  sseIdleTimeoutMs = 75_000,
  heartbeatIntervalMs = transport === "poll" ? 10_000 : AGENT_SSE_HEARTBEAT_INTERVAL_MS
} = {}) {
  for (const [name, value] of Object.entries({ jobTimeoutMs, requestTimeoutMs, pollTimeoutMs, heartbeatIntervalMs,
    sseConnectTimeoutMs, sseIdleTimeoutMs })) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 3_600_000) {
      throw new RangeError(`${name} must be 1ms–1 hour`);
    }
  }
  if (signal?.aborted || stopSignal()) return;
  const config = await configStore.load();
  const lifetime = new AbortController();
  const stop = () => lifetime.abort();
  const stopped = () => lifetime.signal.aborted || stopSignal();
  const isTerminal = (error) => [401, 403, 409].includes(error?.status);
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) stop();
  const lifetimeTimer = setInterval(() => { if (stopSignal()) stop(); }, 1_000);
  lifetimeTimer.unref?.();
  const heartbeat = (requestSignal = lifetime.signal) => routerJson(`${config.routerUrl}/_codassol/agent/heartbeat`, {
    token: config.agentToken,
    body: {
      roots: config.device.roots,
      capabilities: config.device.capabilities
    },
    timeoutMs: requestTimeoutMs,
    signal: requestSignal
  });
  const reportJob = async (job) => {
    if (stopped() || isExpiredAgentJob(job)) {
      // The Router has already rejected the caller's request, so there is
      // nothing to acknowledge. Never run a late file mutation or command.
      if (!stopped()) process.stderr.write("CodasSol Agent discarded expired job before execution\n");
      return;
    }
    let body;
    let jobTimer;
    try {
      let result;
      if (job.payload?.type === "auth-replica-checkpoint" ||
          job.payload?.type === "auth-replica-commit") {
        const commit = job.payload.type === "auth-replica-commit";
        const handler = commit ? replicaReceiver?.commit : replicaReceiver?.receive;
        if (typeof handler !== "function") {
          throw Object.assign(new Error("Replica receiver not configured"), {
            code: "AUTH_REPLICA_DISABLED"
          });
        }
        // Replica jobs can never be forwarded to the local DevSpace. The
        // receiver pins signer, recipient, installation and ordered state.
        result = await handler.call(replicaReceiver,
          commit ? job.payload.certificate : job.payload.checkpoint);
      } else {
        const jobController = new AbortController();
        const remainingMs = Object.hasOwn(job, "expiresAt")
          ? Math.min(jobTimeoutMs, Math.max(0, job.expiresAt - Date.now()))
          : jobTimeoutMs;
        const deadlineError = Object.assign(new Error("Agent HTTP job deadline exceeded"), {
          code: "AGENT_JOB_TIMEOUT"
        });
        if (remainingMs === 0) jobController.abort(deadlineError);
        else jobTimer = setTimeout(() => jobController.abort(deadlineError), remainingMs);
        result = await executeHttpJob(configStore, config, job.payload,
          AbortSignal.any([lifetime.signal, jobController.signal]));
      }
      body = { jobId: job.id, ok: true, result };
    } catch (error) {
      body = {
        jobId: job.id,
        ok: false,
        error: {
          code: error?.code || "AGENT_JOB_FAILED",
          message: error instanceof Error ? error.message : String(error)
        }
      };
    } finally {
      clearTimeout(jobTimer);
    }
    if (stopped() || isExpiredAgentJob(job)) return;
    try {
      // Delivery failure never authorizes replay or a contradictory outcome.
      await routerJson(`${config.routerUrl}/_codassol/agent/result`, {
        token: config.agentToken, body, timeoutMs: requestTimeoutMs, signal: lifetime.signal
      });
    } catch (error) {
      // A caller deadline may expire while this result is in flight. This
      // specific 409 is a stale acknowledgement, not device authentication.
      if (error.status === 409 && error.code === "unknown_or_mismatched_job") return;
      throw error;
    }
    // An authenticated result POST already refreshes Router presence.
    heartbeatAt = Date.now() + heartbeatIntervalMs;
    sseFailures = 0;
    connectionFailures = 0;
  };
  const logError = (error) => !stopped() && process.stderr.write(
    `CodasSol Agent connection error: ${error instanceof Error ? error.message : String(error)}\n`
  );
  // 60-second HTTP heartbeats would cost 43,200 requests per 30-day month
  // PER device. Keep one-way SSE framing cheap and positively confirm
  // Agent liveness at a quota-friendly interval instead.
  const positiveHeartbeatIntervalMs = heartbeatIntervalMs;
  let heartbeatAt = 0;
  let sseFailures = 0;
  const sseUnavailable = transport === "poll";
  let connectionFailures = 0;

  // Legacy polling has a separate serial heartbeat lane: neither a 25-second
  // poll nor a hung backend may suppress its 10-second liveness reports.
  const pollHeartbeat = sseUnavailable ? (async () => {
    let failures = 0;
    while (!stopped()) {
      let delay = heartbeatIntervalMs;
      try {
        await heartbeat();
        failures = 0;
      } catch (error) {
        if (isTerminal(error)) { lifetime.abort(error); break; }
        logError(error);
        delay = reconnectDelayMs(++failures);
      }
      if (!stopped()) await sleepFn(delay, lifetime.signal);
    }
  })() : Promise.resolve();

  try {
    while (!stopped()) {
      try {
        if (!sseUnavailable) {
          const controller = new AbortController();
          const streamSignal = AbortSignal.any([lifetime.signal, controller.signal]);
          let heartbeatInFlight = false;
          let heartbeatPending = Promise.resolve();
          let readyAt = null;
          const heartbeatTimer = setInterval(() => {
            if (readyAt === null || stopped() || heartbeatInFlight || Date.now() < heartbeatAt) return;
            heartbeatInFlight = true;
            heartbeatPending = (async () => {
              try {
                await heartbeat(streamSignal);
                sseFailures = 0;
                connectionFailures = 0;
                heartbeatAt = Date.now() + positiveHeartbeatIntervalMs;
              } catch (error) {
                if (isTerminal(error)) {
                  lifetime.abort(error);
                  return;
                }
                if (!streamSignal.aborted) {
                  heartbeatAt = Date.now() + 5 * 60_000;
                  logError(error);
                }
              } finally {
                heartbeatInFlight = false;
              }
            })();
          }, Math.min(5_000, heartbeatIntervalMs));
          heartbeatTimer.unref?.();
          try {
            await consumeAgentEvents({
              url: `${config.routerUrl}/_codassol/agent/events`,
              token: config.agentToken,
              signal: streamSignal,
              connectTimeoutMs: sseConnectTimeoutMs,
              idleTimeoutMs: sseIdleTimeoutMs,
              onReady: () => {
                readyAt = Date.now();
                heartbeatAt = Date.now() + positiveHeartbeatIntervalMs;
                connectionFailures = 0;
              },
              onJob: reportJob
            });
            if (stopped()) break;
            throw new Error("SSE connection ended unexpectedly");
          } catch (error) {
            if (stopped()) break;
            if (error instanceof SseUnavailableError) {
              // An unsupported endpoint must not silently become paid polling.
              throw error;
            } else {
              // A timed-out proxy request can reach the Router before its
              // abandoned predecessor closes. Wait without replacing that
              // consumer; every other authorization/identity conflict stops.
              if (isTerminal(error) && !(error instanceof SseConsumerActiveError)) throw error;
              logError(error);
              sseFailures = nextSseFailureCount(sseFailures, {
                readyAt, disconnectedAt: Date.now()
              });
              // Repeated stream failures back off; never add a polling request.
              // Stop stream-owned timers before waiting to reconnect.
              controller.abort();
              clearInterval(heartbeatTimer);
              await heartbeatPending;
              await sleepFn(reconnectDelayMs(sseFailures), lifetime.signal);
            }
            continue;
          } finally {
            controller.abort();
            clearInterval(heartbeatTimer);
            await heartbeatPending;
          }
        }

        const polled = await routerJson(`${config.routerUrl}/_codassol/agent/poll`, {
          token: config.agentToken,
          body: {},
          timeoutMs: pollTimeoutMs,
          signal: lifetime.signal
        });
        if (polled.job) await reportJob(polled.job);
        connectionFailures = 0;
      } catch (error) {
        if (stopped()) break;
        if (error instanceof SseUnavailableError || [401, 403, 409].includes(error.status)) throw error;
        logError(error);
        await sleepFn(reconnectDelayMs(++connectionFailures), lifetime.signal);
      }
    }
    if (isTerminal(lifetime.signal.reason)) throw lifetime.signal.reason;
  } finally {
    stop();
    clearInterval(lifetimeTimer);
    await pollHeartbeat;
    signal?.removeEventListener("abort", stop);
  }
}

function usage() {
  return [
    "CodasSol Agent",
    "",
    "Enroll:",
    "  node src/agent.js enroll --router <url> --pairing-token <token> [--device-id <id>] [--label <label>] [--roots <root1|root2>]",
    "",
    "Run:",
    "  node src/agent.js run"
  ].join("\n");
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === "enroll") {
    if (!options.router || !options["pairing-token"]) {
      throw new Error(usage());
    }
    await enrollAgent({
      routerUrl: options.router,
      pairingToken: options["pairing-token"],
      deviceId: options["device-id"] || os.hostname(),
      label: options.label || os.hostname(),
      roots: splitRoots(options.roots),
      devspaceBaseUrl: options["devspace-url"] || "http://127.0.0.1:7676"
    });
    console.log("CodasSol Agent enrolled. Pairing token was not stored.");
  } else if (command === "run") {
    await runAgent();
  } else {
    console.log(usage());
  }
}

