#include <flutter/dart_project.h>
#include <flutter/flutter_view_controller.h>
#include <windows.h>
#include "flutter_window.h"
#include "utils.h"

int APIENTRY wWinMain(_In_ HINSTANCE instance, _In_opt_ HINSTANCE prev,
                      _In_ wchar_t* command_line, _In_ int show_command) {
  // One instance per Windows logon session. A second launch only opens the UI.
  HANDLE mutex = CreateMutexW(nullptr, FALSE, L"Local\\CodasWindowsAgent-UI-v1");
  if (!mutex) return EXIT_FAILURE;
  const DWORD mutex_status = GetLastError();
  if (mutex_status == ERROR_ALREADY_EXISTS) {
    for (int i = 0; i < 20; ++i) {
      HWND existing = FindWindowW(L"CODAS_WINDOWS_AGENT_WINDOW", L"Codas for Windows");
      if (existing) {
        PostMessageW(existing, kCodasActivateExisting, 0, 0);
        break;
      }
      Sleep(100);
    }
    CloseHandle(mutex);
    return EXIT_SUCCESS;
  }
  if (!::AttachConsole(ATTACH_PARENT_PROCESS) && ::IsDebuggerPresent()) CreateAndAttachConsole();
  const HRESULT com = ::CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  int exit_code = EXIT_SUCCESS;
  {
    flutter::DartProject project(L"data");
    project.set_dart_entrypoint_arguments(GetCommandLineArguments());
    FlutterWindow window(project);
    Win32Window::Point origin(10, 10);
    Win32Window::Size size(380, 640);
    if (!window.Create(L"Codas for Windows", origin, size)) {
      exit_code = EXIT_FAILURE;
    } else {
      window.SetQuitOnClose(true);
      MSG msg{};
      BOOL status;
      while ((status = ::GetMessageW(&msg, nullptr, 0, 0)) > 0) {
        ::TranslateMessage(&msg);
        ::DispatchMessageW(&msg);
      }
      if (status == -1) exit_code = EXIT_FAILURE;
    }
  }
  if (SUCCEEDED(com)) ::CoUninitialize();
  CloseHandle(mutex);
  return exit_code;
}
