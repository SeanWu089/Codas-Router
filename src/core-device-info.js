import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { normalizeCoreDevice } from "./device-display.js";

const runFile = promisify(execFile);
let localFormFactorPromise;

export function macFormFactor(data) {
  const model = data?.SPHardwareDataType?.[0]?.machine_name;
  if (typeof model !== "string") return "unknown";
  if (/^MacBook(?: Air| Pro)?$/i.test(model.trim())) return "laptop";
  if (/^(?:Mac mini|Mac Studio|Mac Pro|iMac(?: Pro)?)$/i.test(model.trim())) return "desktop";
  return "unknown";
}

export function windowsFormFactor(data) {
  const types = Array.isArray(data) ? data : [data];
  if (!types.length || !types.every(Number.isInteger)) return "unknown";
  const kinds = new Set();
  for (const type of types) {
    if ([8, 9, 10, 14, 31, 32].includes(type)) kinds.add("laptop");
    else if ([3, 4, 5, 6, 7, 13, 15, 35, 36].includes(type)) kinds.add("desktop");
    else if (type === 30) kinds.add("tablet");
  }
  return kinds.size === 1 ? [...kinds][0] : "unknown";
}

// Bounded, read-only hardware inspection. No serial, UUID, paths, or raw
// hardware output are retained or sent over the wire. Failure is display-only.
export async function detectLocalFormFactor(platform = process.platform, run = runFile) {
  try {
    const options = { timeout: 3000, maxBuffer: 256 * 1024, windowsHide: true, encoding: "utf8" };
    if (platform === "darwin") {
      const { stdout } = await run("/usr/sbin/system_profiler", ["SPHardwareDataType", "-json"], options);
      return macFormFactor(JSON.parse(stdout));
    }
    if (platform === "win32") {
      const executable = path.win32.join(process.env.SystemRoot || "C:\\Windows",
        "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const { stdout } = await run(executable, ["-NoProfile", "-NonInteractive", "-Command",
        "Get-CimInstance -ClassName Win32_SystemEnclosure | ForEach-Object { $_.ChassisTypes } | ConvertTo-Json -Compress"], options);
      return windowsFormFactor(JSON.parse(stdout));
    }
  } catch { /* Unsupported or unavailable hardware inspection is normal. */ }
  return "unknown";
}

export function localHardwareFormFactor() {
  localFormFactorPromise ??= detectLocalFormFactor();
  return localFormFactorPromise;
}

export function coreDeviceInfo(runtime) {
  const id = runtime?.localDeviceId;
  const local = runtime?.devices?.get?.(id);
  const catalog = runtime?.catalog?.get?.(id);
  const candidatePlatform = local?.platform ?? process.platform;
  const platform = ["darwin", "win32", "linux", "android", "ios"].includes(candidatePlatform)
    ? candidatePlatform : "unknown";
  const formFactor = ["desktop", "laptop", "phone", "tablet"].includes(runtime?.localFormFactor)
    ? runtime.localFormFactor : "unknown";
  for (const name of [catalog?.name, local?.label, "Core"]) {
    const info = normalizeCoreDevice({ version: 1, name, platform, formFactor });
    if (info) return info;
  }
  return { version: 1, name: "Core", platform: "unknown", formFactor: "unknown" };
}
