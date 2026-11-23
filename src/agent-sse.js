// Minimal authenticated SSE client; avoids a mandatory WebSocket dependency.
// Only an explicit "job" event may cause execution. Keepalive/ready events
// never authorize work and never indicate successful execution.

export class SseUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.code = "SSE_UNAVAILABLE";
  }
}

export class SseConsumerActiveError extends Error {
  constructor() {
    super("SSE task consumer is still active; waiting for it to close");
    this.status = 409;
    this.code = "AGENT_CONSUMER_ACTIVE";
  }
}

async function consumerActiveResponse(response, timeoutMs) {
  if (!response.body ||
      !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return false;
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0, timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    reader.cancel().catch(() => {});
  }, Math.min(timeoutMs, 5_000));
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 4_096) return false;
      chunks.push(Buffer.from(value));
    }
    if (timedOut) return false;
    const code = JSON.parse(Buffer.concat(chunks).toString("utf8"))?.error;
    // Never print or trust arbitrary response text. Only this established
    // single-consumer conflict permits a retry; identity collisions do not.
    return code === "AGENT_CONSUMER_ACTIVE" || code === "agent_consumer_active";
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function reconnectDelayMs(attempt, random = Math.random) {
  const base = Math.min(15 * 60_000, 1_000 * 2 ** Math.min(attempt, 10));
  return Math.round(base * (0.75 + 0.5 * random()));
}

// A proxy may close otherwise healthy SSE streams every few minutes. Count
// short-lived failures towards backoff, but do not let successful, sustained
// authenticated sessions accumulate into a 15-minute offline delay.
export function nextSseFailureCount(previousFailures, {
  readyAt = null, disconnectedAt = Date.now(), stableMs = 60_000
} = {}) {
  return readyAt !== null && disconnectedAt - readyAt >= stableMs
    ? 1
    : previousFailures + 1;
}

export async function consumeAgentEvents({
  url, token, signal, onJob, onReady = () => {}, fetchImpl = fetch,
  connectTimeoutMs = 30_000, idleTimeoutMs = 75_000
}) {
  for (const value of [connectTimeoutMs, idleTimeoutMs]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 3_600_000) {
      throw new RangeError("SSE deadlines must be 1ms–1 hour");
    }
  }
  const watchdog = new AbortController();
  const boundedSignal = signal ? AbortSignal.any([signal, watchdog.signal]) : watchdog.signal;
  const timeout = (code, message) => watchdog.abort(Object.assign(new Error(message), { code }));
  const connectTimer = setTimeout(() => timeout("SSE_CONNECT_TIMEOUT", "SSE connection timed out"), connectTimeoutMs);
  let idleTimer;
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "text/event-stream",
        "cache-control": "no-cache"
      },
      signal: boundedSignal
    });
    clearTimeout(connectTimer);
    if ([404, 405, 406, 501].includes(response.status)) {
      await response.body?.cancel();
      throw new SseUnavailableError(`Router does not support SSE (HTTP ${response.status})`);
    }
    if (!response.ok) {
      if (response.status === 409 && await consumerActiveResponse(response, connectTimeoutMs)) {
        throw new SseConsumerActiveError();
      }
      await response.body?.cancel();
      const error = new Error(`SSE connection rejected (HTTP ${response.status})`);
      error.status = response.status;
      throw error;
    }
    if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream") ||
        !response.body) {
      await response.body?.cancel();
      throw new SseUnavailableError("Router returned no SSE event stream");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let eventType = "";
    let eventData = [];
    const processLine = async (line) => {
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") {
        const data = eventData.join("\n");
        const type = eventType;
        eventData = [];
        eventType = "";
        if (type === "ready") onReady(JSON.parse(data));
        if (type === "job") {
          const parsed = JSON.parse(data);
          if (!parsed?.job?.id || !parsed.job.payload) {
            throw new Error("Invalid SSE job envelope");
          }
          await onJob(parsed.job);
        }
      } else if (line.startsWith("event:")) {
        eventType = line.slice(6).trimStart();
      } else if (line.startsWith("data:")) {
        eventData.push(line.slice(5).trimStart());
      }
      // All other fields, including SSE comments, are intentionally ignored.
    };

    try {
      while (!boundedSignal.aborted) {
        // The Router sends keepalive bytes every 20 seconds. Bound a silent
        // half-open stream without adding requests during healthy idle time.
        // Pause this watchdog while processing a job; HTTP jobs have their own
        // total deadline, and durable replica commits retain their contract.
        idleTimer = setTimeout(() => timeout("SSE_IDLE_TIMEOUT", "SSE stream became idle"), idleTimeoutMs);
        let chunk;
        try { chunk = await reader.read(); } finally { clearTimeout(idleTimer); }
        const { done, value } = chunk;
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        if (pending.length > 1_048_576) throw new Error("SSE event exceeds 1 MiB");
        let newline;
        while ((newline = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          await processLine(line);
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (!boundedSignal.aborted) throw new Error("SSE stream closed");
    if (watchdog.signal.aborted && !signal?.aborted) throw watchdog.signal.reason;
  } catch (error) {
    if (watchdog.signal.aborted && !signal?.aborted) throw watchdog.signal.reason;
    throw error;
  } finally {
    clearTimeout(connectTimer);
    clearTimeout(idleTimer);
  }
}
