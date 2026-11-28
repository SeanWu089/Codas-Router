Codas for Windows 0.2.0-rc.8 — standalone candidate

Install the x64 EXE on your own or explicitly authorized Windows PC.
No separately installed Node, DevSpace, Git or npm is needed. The installer
bundles the existing Flutter UI, Node, SSE core, and pinned DevSpace runtime.

Enter your own trusted HTTPS Core address, select a dedicated workspace, supply its first-time pairing code and enable access.
The bundled backend initializes its own private local state, listens only on
127.0.0.1:29676, and runs only while the access worker is active. Existing
external DevSpace configuration and services are not modified or adopted.
No coordinator address is built into the installer. A saved pairing stays bound to its original Core. A fresh local enable action explicitly grants the six existing workspace
tools for this access session without per-task prompts. The access switch
defaults off. Scripts run with the current Windows account permissions; the
workspace is not an OS sandbox. Closing Codas stops
new tasks and requests shutdown of its own backend.

The candidate intentionally uses a new state-v3 identity, so a previous rc.2
installation requires fresh pairing; its original state is preserved. No global
security changes, alternate ingress, repair downloads, auto-start or private
credentials are included. This build requires clean Windows and actual remote
acceptance before stable publication.

Runtime profile: Codas Workspace Lite (Windows x64). Source maps, debug symbols, non-target prebuilds and bundled Claude CLI omitted. Subagents remain disabled.

UI candidate: closing or hiding the panel keeps the explicitly enabled current access session active. Use the access switch or Exit Codas from the tray to stop it. Exit Codas explicitly before upgrading/uninstalling. Startup remains off.
