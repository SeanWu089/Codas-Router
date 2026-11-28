# Codas for Windows — Desktop Preview 02

This independent preview reuses the Android Flutter interface and branding. It is a **read-only local status client**, not a replacement or new package for the existing Codas execution service. No remote command execution, enrollment, credentials, background startup, privilege escalation, or security-policy changes are included.

Build on an authorized Windows x64 development machine with Flutter 3.47.5, Visual Studio with Desktop development with C++, and Inno Setup 6. From the Flutter project directory:

```powershell
.\windows\packaging\build-preview.ps1
```

Outputs: dist/Codas-Desktop-Preview-0.1.1-x64-Setup.exe and its SHA-256 sidecar. The Windows app requires the supported Microsoft Visual C++ runtime. Use a trusted code-signing certificate for distribution; the preview build is unsigned unless the publisher signs it separately.

Install per user, run on demand and uninstall independently. Test on a personal or otherwise authorized Windows device. The status panel checks only the documented loopback health endpoint. A healthy result does not certify remote connectivity. If security software blocks an application, do not bypass that decision.

Acceptance:
- DP-01: clean install and open the preview, confirm Codas icon and UI.
- DP-02: absent local service displays optional local diagnostics only; a healthy local service reports local health, not remote readiness.
- DP-03: refresh switch affects only monitoring; existing services and credentials remain untouched.
- DP-04: uninstall removes only this preview. Existing Codas remains unchanged.

External SSE state remains explicitly unverified until an authorized status-only integration exists. Do not infer remote disconnection from loopback health.
