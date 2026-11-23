# Fresh Windows identity: encrypted qualification handoff

Engineering helper only, retained on a separate qualification branch and **not shipped in the Windows package**. The helper has not been run against either machine. Review the paths and the existing router identity before executing anything below.

This procedure enrolls one new, clearly named Windows test agent. It preserves the current SEANSWPC enrollment and the existing Mac router. The test agent may access only its installer’s one dedicated, initially empty proof folder. Agent authentication identifies that agent; the isolated DevSpace `allowedRoots` setting enforces the folder boundary.

## Source contract verified

The frozen transport exposes admin-authenticated `GET /_codassol/devices` and pairing-authenticated `POST /_codassol/agent/enroll`. An enrollment request can explicitly supply the device ID, label, `win32` platform, roots, and `devspace-http` capability. Its response contains a new per-agent credential. Re-enrolling an existing agent ID rotates that credential, so this helper refuses any ID already present in either the private state or the device catalog.

The router pairing token is reusable and has no TTL in this transport revision. The helper reads it only from an explicitly named Mac `router.json`, keeps it in memory, and sends it only to the literal `http://127.0.0.1:<port>` enrollment endpoint. It does not print the token, import `RouterPrivateState`, initialize global state, run token-printing CLI commands, edit the router state directly, or restart the router.

There is no exposed agent revoke/delete API in this revision. The agreed cleanup is to stop the new test installation, persist its disabled intent, verify the test device becomes offline, and retain its uniquely named identity. Do not edit the live router state or re-enroll another ID as cleanup.

## 1. Prepare on Windows

Use the dedicated qualification installation, **not the existing production installation**. Stop it through its verified `STOP.cmd` first. The helper requires `enabled.json` to contain `enabled:false`, any existing supervisor receipt to show a clean stop, `agent.json` to be absent, and exactly one allowed root. That root must be an empty directory before preparation.

Use an already verified Node 22 executable. Substitute the inspected paths and current public HTTPS router origin:

```powershell
& 'C:\absolute\verified\node.exe' 'C:\absolute\fresh-identity-handoff.mjs' prepare `
  --install-root 'C:\absolute\qualification-install' `
  --workspace 'C:\absolute\qualification-proof' `
  --ingress 'https://actual-router-origin.example' `
  --run-id 'windows-rc5-20261123'
```

The helper creates:

- A tiny `codas-proof-<run-id>.txt` file containing the new device ID, local hostname, and a random marker.
- `state\qualification-handoff\request.json`, containing public identity/scope/proof metadata and an ephemeral RSA public key.
- `state\qualification-handoff\ephemeral-private.pem`, retained **only on this Windows installation**.

The command prints only public paths and metadata. Transfer **only `request.json`** to the Mac. Whitespace and line-ending changes do not affect request binding because the helper uses canonical JSON. Do not transfer the private key, local `auth.json`, or a pre-existing `agent.json`.

## 2. Enroll once on the Mac and seal the credential

Inspect and supply the exact production `router.json`, literal loopback listener, existing local router device ID, and public HTTPS origin. The output directory must already exist, and the output file and its `.attempt.json` companion must not exist.

```bash
/absolute/verified/node /absolute/fresh-identity-handoff.mjs enroll \
  --request-file /absolute/public-request.json \
  --state-file /absolute/existing-production-state/router.json \
  --loopback http://127.0.0.1:17676 \
  --expected-router-id ACTUAL_MAC_ROUTER_DEVICE_ID \
  --public-origin https://actual-router-origin.example \
  --output /absolute/qualification-envelope.json
```

This command reads the existing private state, confirms the target router through the authenticated device catalog, checks that the new UUID is absent, and performs exactly one enrollment POST. It writes a permanent public attempt marker before the POST and never retries enrollment automatically. After a timeout or uncertain response, retain the marker and inspect the catalog; do not rerun with another output filename to bypass it.

The returned per-agent configuration is encrypted using AES-256-GCM. Its random encryption key is wrapped with the Windows-generated RSA-3072 key using OAEP-SHA256. Authenticated metadata binds the ciphertext to the public request hash, request ID, device ID, and installation UUID. The master pairing/admin/peer credentials are never included in the envelope. After writing the envelope, the helper verifies that every pre-existing agent record and the router’s existing credentials/installation identity remain unchanged; it prints only whether that check succeeded.

Transfer the encrypted `qualification-envelope.json` back to Windows. Keep the public attempt marker as evidence. A failed post-enrollment check can leave a valid envelope saved: inspect the result rather than enrolling again.

## 3. Import only into the same unpaired Windows state

```powershell
& 'C:\absolute\verified\node.exe' 'C:\absolute\fresh-identity-handoff.mjs' import `
  --install-root 'C:\absolute\qualification-install' `
  --envelope 'C:\absolute\qualification-envelope.json'
```

Import rechecks the disabled, cleanly stopped, unpaired installation and its proof file. It decrypts the envelope, verifies the exact HTTPS origin, device and installation IDs, allowed root, backend port, and isolated owner-token path, and exclusively creates `state\agent.json`. It refuses to overwrite any enrollment. It preserves the local owner credential, installation identity, generation ledger, and disabled intent, removes its ephemeral private key after success, and writes a public import receipt. It does not start a task.

If import fails after exclusive credential creation, do not delete `agent.json` and rerun blindly: inspect the public receipt and stopped state. No automatic cleanup/reset is performed.

## 4. Actual other-device Codas qualification

Start the dedicated packaged installation with its verified `START.cmd`. Then use the actual Codas plugin from the other device:

1. List devices and find the exact new `device-<UUID>` with label `Codas qualification <hostname> <run-id>`.
2. Call `open_workspace` with the dedicated Windows folder and explicit `device_id` equal to that UUID.
3. Use the returned `workspace_id` for `read` of the relative proof filename. Compare the returned hostname/device/marker with the local proof and recorded SHA-256.
4. In the same workspace, run `exec_command` with `cmd: "hostname"`. It must return the Windows hostname.
5. Verify the existing production workspace still works through its existing `workspace_id`; record that separately from the new agent’s result.

These calls establish actual routing, authorized folder access, file reading, and command execution from the plugin. Loopback health, enrollment, or an online device listing alone does not prove this scenario. This engineering credential handoff qualifies the packaged agent; it does not claim the interactive product Pair UI was exercised.

While two Windows agents are online, the frozen transport’s implicit rootless `D:`/`E:` fallback is ambiguous and may reject a new unbound request. Continue existing work through its already bound `workspace_id` or explicit production `device_id`; use the new UUID explicitly for qualification. Existing bindings are not changed by enrollment.

## 5. Cleanup and truthful evidence

Run only the qualification installation’s verified `STOP.cmd`. Confirm its supervisor cleanly stops, `enabled.json` remains false, and the uniquely named test device becomes offline in the actual catalog. The server normally reduces presence TTL to 30 seconds after SSE disconnect; wait for the observed offline result rather than reporting it prematurely.

Retain the new test identity, encrypted/public evidence, and its disabled installation. Do not alter the production enrollment or remove records from live router JSON. Report start/remote file access/reconnect/repair/rollback outcomes only when each has actually passed. Full reboot, natural wake, and prolonged soak remain untested unless separate evidence was observed; fixed 24-hour/8-hour runs are not publication prerequisites under the user’s latest instruction.

## Boundaries

- This helper has no remote management, startup-task, publication, or credential-printing commands.
- It accepts no token on the command line or environment.
- It permits Mac enrollment only through literal `127.0.0.1`, without HTTP proxy or redirects.
- It does not change the frozen transport, product pairing implementation, installer, or runtime.
- It does not add a legacy identity migration, decentralization, or core takeover requirement.
