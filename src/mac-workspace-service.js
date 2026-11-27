import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { DevSpaceLocalOAuth } from "./devspace-local-auth.js";
import { parseMcpResponseBody } from "./mcp-routing.js";
import { WorkspacePolicyError } from "./local-workspace-policy.js";

const fail = (code, message) => { throw new WorkspacePolicyError(code, message); };
const contained = (root, child) => {
  const relative = path.relative(root, child);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep));
};
const canonical = (value, home) => fs.realpathSync.native(value === "~" ? home : value.startsWith("~/") ? path.join(home, value.slice(2)) : value);

// Only the positively identified, same-user, managed launchd service can be
// stopped. No generic process kill, installer, or remote command interface.
export function createMacManagedDevSpace({ home = os.homedir(), cli, run = systemRun, delay = sleep } = {}) {
  const label = "com.codassol.devspace.mac";
  const domain = `gui/${process.getuid()}`;
  const target = `${domain}/${label}`;
  const plist = path.join(home, "Library/LaunchAgents", `${label}.plist`);
  // The 2026-11-27 production service was promoted by the stable Mac runtime
  // installer, not the older menu-app cutover utility. Keep an explicit
  // allowlist of known same-user, exact-path managed launcher contracts.
  const supportedRunners = [
    path.join(home, "Library/Application Support/CodasSol/production/bin/devspace-runner.zsh"),
    path.join(home, "Library/Application Support/CodasSol-mac/devspace-runner.zsh")
  ];
  let stoppedByUs = false;
  let launchedByUs = false;
  let stopping = false;
  function checkContract() {
    const info = fs.lstatSync(plist);
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o022)) return false;
    const result = run("/usr/bin/plutil", ["-convert", "json", "-o", "-", plist]);
    if (result.code !== 0) return false;
    const p = JSON.parse(result.stdout);
    const recognizedArgs = supportedRunners.some((runner) =>
      JSON.stringify(p.ProgramArguments) === JSON.stringify(["/bin/zsh", runner, "--serve"]));
    if (p.Label !== label || !recognizedArgs || p.WorkingDirectory !== home) return false;
    // Custom configuration/runtime environment needs a separately verified adapter.
    if (Object.keys(p.EnvironmentVariables || {}).some((key) => key !== "PATH")) return false;
    return true;
  }
  function loaded() { return run("/bin/launchctl", ["print", target]); }
  function listeners() {
    const result = run("/usr/sbin/lsof", ["-nP", "-t", "-iTCP:7676", "-sTCP:LISTEN"]);
    if (result.code === 1 && !result.stdout.trim() && !result.stderr.trim()) return [];
    if (result.code !== 0 || !/^\s*\d+(?:\s+\d+)*\s*$/.test(result.stdout)) fail("LISTENER_UNKNOWN", "Cannot verify the DevSpace listener");
    return [...new Set(result.stdout.trim().split(/\s+/).map(Number))];
  }
  function owned() {
    if (!checkContract()) return false;
    const job = loaded();
    if (job.code !== 0) return false;
    const pids = [...job.stdout.matchAll(/^\s*pid = (\d+)\s*$/gm)].map((match) => Number(match[1]));
    const actual = listeners();
    if (pids.length !== 1 || actual.length !== 1 || pids[0] !== actual[0]) return false;
    const uid = run("/bin/ps", ["-p", String(actual[0]), "-o", "uid="]);
    const command = run("/bin/ps", ["-p", String(actual[0]), "-o", "command="]);
    return uid.code === 0 && Number(uid.stdout.trim()) === process.getuid() && command.code === 0 &&
      command.stdout.trim().endsWith(`${cli} serve`);
  }
  return {
    async canQuiesce() { try { return owned(); } catch { return false; } },
    async quiesce() {
      if (stopping || !checkContract()) return false;
      const job = loaded();
      // Only accept an already stopped instance if this controller stopped it.
      if (stoppedByUs && job.code !== 0 && listeners().length === 0) return true;
      const knownFailedStart = launchedByUs && job.code === 0 && listeners().length === 0 &&
        job.stdout.split("\n").some((line) => line.trim() === `path = ${plist}`);
      if (!owned() && !knownFailedStart) return false;
      stopping = true;
      try {
        if (run("/bin/launchctl", ["bootout", target]).code !== 0) return false;
        for (let i = 0; i < 50; i++) {
          if (loaded().code !== 0 && listeners().length === 0) { stoppedByUs = true; launchedByUs = false; return true; }
          await delay(200);
        }
        return false;
      } finally { stopping = false; }
    },
    async start() {
      if (!checkContract()) return false;
      if (owned()) { stoppedByUs = false; return true; }
      if (!stoppedByUs || loaded().code === 0 || listeners().length !== 0) return false;
      let launched = false;
      for (let i = 0; i < 8; i++) {
        if (loaded().code === 0 || listeners().length !== 0 || !checkContract()) break;
        if (run("/bin/launchctl", ["bootstrap", domain, plist]).code === 0) { launched = true; launchedByUs = true; break; }
        await delay(400);
      }
      if (!launched) return false;
      for (let i = 0; i < 60; i++) {
        if (owned()) { stoppedByUs = false; return true; }
        await delay(250);
      }
      return false;
    }
  };
}

function systemRun(file, args) {
  try { return { code: 0, stdout: execFileSync(file, args, { encoding: "utf8", timeout: 6000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }), stderr: "" }; }
  catch (error) { return { code: Number.isInteger(error.status) ? error.status : -1, stdout: String(error.stdout || ""), stderr: String(error.stderr || "") }; }
}

const backend = "http://127.0.0.1:7676";
const router = "http://127.0.0.1:17676";

export function restrictLocalFetch(fetchFn = fetch, origins = [backend, router]) {
  return (url, options = {}) => {
    const target = new URL(url);
    if (!origins.includes(target.origin) || target.username || target.password) fail("NONLOCAL_PROBE", "Verification is restricted to the local Codas services");
    return fetchFn(target, { ...options, redirect: "manual", signal: AbortSignal.timeout(8000) });
  };
}

// The local verification client is created only after the native owner's
// explicit approval. It uses the already-supported local OAuth flow; it never
// prints tokens, full MCP responses, or reads project file contents.
export function createLocalWorkspaceProbe({ home = os.homedir(), fetchFn = fetch, oauth = null, backendOrigin = backend, routerOrigin = router } = {}) {
  const localFetch = restrictLocalFetch(fetchFn, [backendOrigin, routerOrigin]);
  const auth = oauth || new DevSpaceLocalOAuth({ baseUrl: backendOrigin, ownerTokenPath: path.join(home, ".devspace/auth.json"), fetchFn: localFetch });
  async function invoke(origin, name, args) {
    const id = randomUUID();
    const send = async () => localFetch(`${origin}/mcp`, {
      method: "POST", headers: { authorization: `Bearer ${await auth.accessToken()}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-03-26", "mcp-method": "tools/call", "mcp-name": name },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })
    });
    let response = await send();
    if (response.status === 401 && auth.oauthState) {
      auth.oauthState.accessToken = null; auth.oauthState.accessExpiresAt = 0;
      response = await send();
    }
    if (response.status !== 200) return { denied: false, error: true };
    const parsed = parseMcpResponseBody(response.headers.get("content-type"), await response.text());
    const matches = (Array.isArray(parsed) ? parsed : [parsed]).filter((message) => message?.id === id);
    if (matches.length !== 1) return { error: true };
    const message = matches[0];
    if (message?.id !== id) return { error: true };
    const result = message.result;
    if (result?.isError || message.error) {
      const content = (result?.content || []).filter((item) => item.type === "text").map((item) => item.text).join(" ");
      const reason = `${content} ${message.error?.message || ""}`;
      return { error: true, denied: /path is outside allowed roots|workspace_denied/i.test(reason) };
    }
    return { result: result?.structuredContent, error: false };
  }
  async function localDevice() {
    const reply = await invoke(routerOrigin, "codassol_list_devices", {});
    const list = reply.result;
    const device = list?.devices?.find((item) => item.id === list.localDeviceId && item.isThisDevice === true);
    if (reply.error || !device || device.platform !== "darwin" || !Array.isArray(device.authorizedRoots)) fail("ROUTER_UNVERIFIED", "The local Router could not be verified");
    return device;
  }
  async function check(device, selected, allowed) {
    const args = { path: selected, device_id: device.id };
    const answer = await invoke(routerOrigin, "open_workspace", args);
    if (!allowed) return answer.denied === true;
    const info = answer.result;
    try { return !answer.error && typeof info?.workspace_id === "string" && canonical(info.root, home) === canonical(selected, home); }
    catch { return false; }
  }
  return {
    async covers(roots) {
      const device = await localDevice();
      return roots.every((root) => {
        const selected = canonical(root, home);
        return device.authorizedRoots.some((entry) => { try { return contained(canonical(entry, home), selected); } catch { return false; } });
      });
    },
    async verify(roots) {
      const device = await localDevice();
      for (const root of roots) if (!await check(device, root, true)) return false;
      const negative = fs.mkdtempSync(path.join(home, ".codas-denied-probe-"));
      try {
        if (roots.some((root) => contained(canonical(root, home), canonical(negative, home)))) return false;
        // An explicit policy denial, not an auth failure or outage, is required.
        return await check(device, negative, false);
      } finally { fs.rmdirSync(negative); }
    },
    async close() {
      // The temporary client never writes its tokens to disk. Explicitly
      // revoke both issued tokens when the installed provider supports it.
      const state = auth.oauthState;
      if (!state?.clientId) return true;
      let revoked = true;
      for (const token of [state.refreshToken, state.accessToken]) {
        if (!token) continue;
        try {
          const response = await localFetch(`${backendOrigin}/revoke`, {
            method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ token, client_id: state.clientId })
          });
          revoked = response.ok && revoked;
        } catch { revoked = false; }
      }
      state.accessToken = null; state.refreshToken = null;
      return revoked;
    }
  };
}

export function createVerifiedRootService({ managed, probe, before, after, inspect }) {
  return {
    async canQuiesce() {
      // Fail closed when the Router would need a separate routing change.
      return await managed.canQuiesce() && await probe.covers(after) && await probe.verify(before);
    },
    async quiesce() { return await managed.quiesce(); },
    async startAndVerify({ roots }) {
      if (!await managed.start()) return { effectivePolicyVerified: false };
      const disk = inspect();
      if (JSON.stringify(disk.roots) !== JSON.stringify(roots)) return { effectivePolicyVerified: false };
      return { roots: [...roots], effectivePolicyVerified: await probe.covers(roots) && await probe.verify(roots) };
    }
  };
}
