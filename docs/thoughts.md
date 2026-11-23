# Thoughts

- 2026-11-23 Windows release contract: after Windows login and enabling Codas, authenticated Codas plugins on other devices can work with explicitly allowed local folders through the existing HTTPS ingress. Decentralized/core takeover is deferred. Keep runtime dependencies self-contained in a durable user installation and identity, authorization and session-generation state outside immutable version directories.
- 2026-11-23 latest release policy: fixed 24h/8h testing is not required by the user. Prefer directly observed daily-use acceptance of the actual package—fresh install, remote workspace execution, recovery, missing-file detection/repair and rollback. Keep long-duration, wake and full-reboot observations truthful and supplementary; never turn an unobserved scenario into a passed test.

- 2026-10-13 confirmed constraint: treat the existing ngrok Free plan as the only available plan. Do not propose paid upgrades as the fix for wasteful background traffic. Prefer one authenticated SSE channel, changes/results on demand, budgeted positive heartbeats and bounded reconnects. Confirmed Windows development location is `C:\Users\ASUS\Desktop\PROJECTS\CodasSol-Router`.

- Position CodasSol as a **transparent workspace router**, not as another general remote desktop or all-in-one AI runtime.
- Product headline: **Route the Project, Not Devices.** The user/agent addresses the project or workspace; the Router resolves the physical machine.
- Keep DevSpace as the execution layer; keep CodasSol focused on discovery, routing, workspace affinity, credentials, and policy.
- Security directions: per-action approvals, capability-scoped tokens, audit trails, token rotation/revocation, signed updates, protocol compatibility and least-privilege OS accounts. 2026-10-13: user reaffirmed no Tailscale in CodasSol; use the agreed outbound authenticated SSE transport and keep public ingress failover separate.
- Routing directions: aliases/tags, capability routing (`gpu`, `cuda`, `macos`, `office`, `home`), load awareness, wake/sleep state, and explicit overrides.
- Consumer workflows: retrieve/send a file from any device, start a download/render at home, run a long task on a powerful desktop from a phone, collect files across machines, and operate home-lab devices without learning SSH.
- UI directions: small device dashboard, mobile command surface, approval notifications, activity timeline, and optional GUI/computer-use capabilities.
- Avoid growing into an all-in-one chat/model/orchestration platform until the routing layer itself is mature.
