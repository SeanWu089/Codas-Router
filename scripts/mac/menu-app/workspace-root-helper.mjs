// Bundled local administration helper. Not a Router endpoint or MCP tool.
// Requests contain only configuration roots and a reviewed local addition.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { inspectLocalRootConfig, makeJSONCRootCodec, LocalRootTransaction } from "./local-root-transaction.js";
import { planDevSpaceRootChange, revalidateDevSpaceRootPlan, WorkspacePolicyError } from "./local-workspace-policy.js";
import { createMacManagedDevSpace, createLocalWorkspaceProbe, createVerifiedRootService } from "./mac-workspace-service.js";

const fail = (code, message) => { throw new WorkspacePolicyError(code, message); };
const home = fs.realpathSync.native(os.homedir());
const configFile = path.join(home, ".devspace/config.jsonc");
const journalDirectory = path.join(home, ".devspace/codas-root-transactions");
const protectedRoots = [".devspace", ".codassol", ".ssh", ".gnupg", ".aws", ".kube", ".config", ".codex", ".cursor", ".agents", ".local", "Library", "Applications"].map((item) => path.join(home, item));
const packageRoot = process.argv[2];
const cli = path.join(packageRoot || "", "dist/cli.js");
const here = path.dirname(fileURLToPath(import.meta.url));
const ownerApproval = path.join(here, "../../Helpers/CodasWorkspaceApproval");
const output = (result) => process.stdout.write(JSON.stringify(result) + "\n");

function requireSupportedFile() {
  // This first macOS adapter deliberately refuses to rewrite native ACLs or
  // extended attributes rather than silently dropping them during rename.
  const attrs = execFileSync("/usr/bin/xattr", [configFile], { encoding: "utf8", timeout: 4000 });
  const permissions = execFileSync("/bin/ls", ["-lde", configFile], { encoding: "utf8", timeout: 4000 });
  if (attrs.trim() || permissions.trim().split("\n").length !== 1) fail("CONFIG_METADATA_UNSUPPORTED", "This configuration has extended attributes or ACLs; local review is required");
}

function requireOwnedSelection(selection) {
  if (selection.path.length > 1024 || /[\x00-\x1f\x7f]/.test(selection.path)) fail("INVALID_PATH", "Select a directory with a printable path");
  const relative = path.relative(home, selection.path);
  // First release: explicit, owner-controlled directories within this Mac's
  // home, not system folders or other users' locations. External disks later.
  if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(".." + path.sep) || relative.split(path.sep).some((item) => item.startsWith("."))) {
    fail("ROOT_SCOPE_UNSUPPORTED", "Choose an ordinary project folder inside your home directory");
  }
  const info = fs.lstatSync(selection.path);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o022)) fail("UNSAFE_SELECTED_ROOT", "Choose a directory owned and controlled by your account");
}

async function run() {
  if (process.platform !== "darwin" || process.getuid() === 0) fail("UNSUPPORTED_HOST", "Run from a normal macOS user account");
  if (!packageRoot || !path.isAbsolute(packageRoot)) fail("BACKEND_UNAVAILABLE", "DevSpace package could not be resolved");
  const localRequire = createRequire(path.join(packageRoot, "package.json"));
  const codec = makeJSONCRootCodec(localRequire("jsonc-parser"));
  const inspect = () => inspectLocalRootConfig(configFile, codec);
  const request = JSON.parse(fs.readFileSync(0, "utf8"));
  const managed = createMacManagedDevSpace({ home, cli });
  const pending = () => fs.existsSync(path.join(journalDirectory, "active"));
  const current = inspect();
  if (request.command === "list") {
    output({ ok: true, roots: current.roots, managed: await managed.canQuiesce(), recoveryPending: pending() });
    return;
  }
  if (pending()) fail("RECOVERY_REQUIRED", "An earlier directory change needs local recovery review");
  if (request.command === "review") {
    const plan = planDevSpaceRootChange({ allowedRoots: current.roots, action: { type: "add", path: request.path }, home, protectedRoots });
    requireOwnedSelection(plan.selection);
    requireSupportedFile();
    if (!await managed.canQuiesce()) fail("SERVICE_NOT_MANAGED", "The managed DevSpace service cannot be safely restarted");
    output({ ok: true, review: { ...plan, digest: current.digest } });
    return;
  }
  if (request.command !== "apply" || request.review?.operation?.type !== "add") fail("UNSUPPORTED_ACTION", "Only reviewed local additions are supported");
  const reviewed = request.review;
  if (reviewed.digest !== current.digest) fail("CONFIG_CHANGED", "Configuration changed after review");
  const preflight = revalidateDevSpaceRootPlan({ plan: reviewed, allowedRoots: current.roots, home, protectedRoots });
  requireOwnedSelection(preflight.selection);
  requireSupportedFile();
  // Always request OS-mediated local owner authentication. No headless
  // approval flag, credential output, or remotely callable permission API.
  try { execFileSync(ownerApproval, [preflight.selection.path], { timeout: 100000, stdio: ["ignore", "ignore", "ignore"] }); }
  catch { fail("OWNER_APPROVAL_REQUIRED", "Local owner authentication was cancelled or unavailable"); }
  const latest = inspect();
  if (latest.digest !== reviewed.digest) fail("CONFIG_CHANGED", "Configuration changed during owner approval");
  requireSupportedFile();
  const finalPlan = revalidateDevSpaceRootPlan({ plan: reviewed, allowedRoots: latest.roots, home, protectedRoots });
  requireOwnedSelection(finalPlan.selection);
  if (!fs.existsSync(journalDirectory)) fs.mkdirSync(journalDirectory, { mode: 0o700 });
  const probe = createLocalWorkspaceProbe({ home });
  const service = createVerifiedRootService({ managed, probe, before: finalPlan.before, after: finalPlan.after, inspect });
  const transaction = new LocalRootTransaction({ configFile, journalDirectory, codec, service, home, protectedRoots });
  const fresh = transaction.preview(finalPlan.operation);
  if (fresh.digest !== reviewed.digest || !isDeepStrictEqual(fresh.before, reviewed.before) || !isDeepStrictEqual(fresh.after, reviewed.after) || !isDeepStrictEqual(fresh.selection, reviewed.selection)) {
    fail("CONFIG_CHANGED", "The reviewed change no longer matches the selected directory");
  }
  let result, probeRevoked;
  try { result = await transaction.apply(fresh.id); }
  finally { probeRevoked = await probe.close(); }
  // Do not expose backup file contents, credentials or raw MCP replies.
  output({ ok: true, status: result.status, roots: result.status === "committed" ? result.roots : finalPlan.before, reason: result.reason || null, probeRevoked });
}

try { await run(); }
catch (error) {
  output({ ok: false, code: error instanceof WorkspacePolicyError ? error.code : "LOCAL_OPERATION_FAILED", message: error instanceof WorkspacePolicyError ? error.message : "Local configuration or verification failed. No unchecked success is reported." });
}
