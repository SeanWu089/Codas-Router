#include "flutter_window.h"
#include <algorithm>
#include <cwchar>
#include <flutter_windows.h>
#include <optional>
#include <variant>
#include <windowsx.h>
#include "flutter/generated_plugin_registrant.h"
#include "resource.h"

namespace {
constexpr UINT kTrayCallback = WM_APP + 0x51;
constexpr UINT kExitApproved = WM_APP + 0x53;
constexpr UINT kTrayId = 1;
constexpr UINT kOpen = 1;
constexpr UINT kHide = 2;
constexpr UINT kExit = 3;

bool ReadBool(const flutter::EncodableMap& map, const char* key, bool* value) {
  const auto it = map.find(flutter::EncodableValue(key));
  if (it == map.end()) return false;
  const auto* field = std::get_if<bool>(&it->second);
  if (!field) return false;
  *value = *field;
  return true;
}

NOTIFYICONDATAW TrayData(HWND hwnd) {
  NOTIFYICONDATAW data{};
  data.cbSize = static_cast<DWORD>(sizeof(data));
  data.hWnd = hwnd;
  data.uID = kTrayId;
  return data;
}
}  // namespace

FlutterWindow::FlutterWindow(const flutter::DartProject& project)
    : project_(project) {}
FlutterWindow::~FlutterWindow() {}

void FlutterWindow::ConfigureCompactWindow() {
  const HWND hwnd = GetHandle();
  if (!hwnd) return;
  // Retain an ordinary close affordance; no resize/maximize or auto-start.
  SetWindowLongPtrW(hwnd, GWL_STYLE, WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU);
  SetWindowPos(hwnd, nullptr, 0, 0, 0, 0,
               SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
}

void FlutterWindow::ShowPanel() {
  const HWND hwnd = GetHandle();
  if (!hwnd) return;
  if (!IsWindowVisible(hwnd) || IsIconic(hwnd)) {
    RECT icon_rect{};
    NOTIFYICONIDENTIFIER identifier{};
    identifier.cbSize = static_cast<DWORD>(sizeof(identifier));
    identifier.hWnd = hwnd;
    identifier.uID = kTrayId;
    HMONITOR monitor = nullptr;
    if (tray_added_ && SUCCEEDED(Shell_NotifyIconGetRect(&identifier, &icon_rect))) {
      monitor = MonitorFromRect(&icon_rect, MONITOR_DEFAULTTONEAREST);
    } else {
      POINT cursor{};
      GetCursorPos(&cursor);
      monitor = MonitorFromPoint(cursor, MONITOR_DEFAULTTONEAREST);
    }
    MONITORINFO mi{};
    mi.cbSize = static_cast<DWORD>(sizeof(mi));
    if (monitor && GetMonitorInfoW(monitor, &mi)) {
      const UINT dpi = FlutterDesktopGetDpiForMonitor(monitor);
      RECT frame{0, 0, MulDiv(360, static_cast<int>(dpi), 96),
                      MulDiv(600, static_cast<int>(dpi), 96)};
      const DWORD style = static_cast<DWORD>(GetWindowLongPtrW(hwnd, GWL_STYLE));
      const DWORD ex = static_cast<DWORD>(GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
      AdjustWindowRectExForDpi(&frame, style, FALSE, ex, dpi);
      const LONG margin = MulDiv(10, static_cast<int>(dpi), 96);
      const LONG width = std::min(frame.right - frame.left,
                                  mi.rcWork.right - mi.rcWork.left);
      const LONG height = std::min(frame.bottom - frame.top,
                                   mi.rcWork.bottom - mi.rcWork.top);
      const LONG x = std::max(mi.rcWork.left, mi.rcWork.right - width - margin);
      const LONG y = std::max(mi.rcWork.top, mi.rcWork.bottom - height - margin);
      SetWindowPos(hwnd, HWND_TOP, x, y, width, height, SWP_NOACTIVATE);
    }
    ShowWindow(hwnd, SW_SHOWNORMAL);
  }
  SetForegroundWindow(hwnd);
}

void FlutterWindow::HidePanel() {
  // Never hide the only reachable window if Explorer rejected the tray icon.
  if (tray_added_ && GetHandle()) ShowWindow(GetHandle(), SW_HIDE);
}

bool FlutterWindow::InstallTray() {
  if (tray_added_) return true;
  const HWND hwnd = GetHandle();
  if (!hwnd) return false;
  if (!tray_icon_) tray_icon_ = LoadIconW(GetModuleHandleW(nullptr), MAKEINTRESOURCEW(IDI_APP_ICON));
  if (!tray_icon_) return false;
  auto data = TrayData(hwnd);
  data.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP | NIF_SHOWTIP;
  data.uCallbackMessage = kTrayCallback;
  data.hIcon = tray_icon_;
  wcscpy_s(data.szTip, L"Codas");
  if (!Shell_NotifyIconW(NIM_ADD, &data)) return false;
  tray_hwnd_ = hwnd;
  tray_added_ = true;
  data.uVersion = NOTIFYICON_VERSION_4;
  if (!Shell_NotifyIconW(NIM_SETVERSION, &data)) {
    RemoveTray();
    return false;
  }
  // No independent taskbar entry while the tray icon is available.
  const LONG_PTR ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
  SetWindowLongPtrW(hwnd, GWL_EXSTYLE, (ex | WS_EX_TOOLWINDOW) & ~static_cast<LONG_PTR>(WS_EX_APPWINDOW));
  SetWindowPos(hwnd, nullptr, 0, 0, 0, 0,
               SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
  UpdateTray();
  return tray_added_;
}

void FlutterWindow::RemoveTray() {
  if (tray_added_ && tray_hwnd_) {
    auto data = TrayData(tray_hwnd_);
    Shell_NotifyIconW(NIM_DELETE, &data);
  }
  tray_added_ = false;
  tray_hwnd_ = nullptr;
}

void FlutterWindow::UpdateTray() {
  if (!tray_added_ || !tray_hwnd_) return;
  auto data = TrayData(tray_hwnd_);
  data.uFlags = NIF_TIP | NIF_SHOWTIP;
  const wchar_t* tip = pending_ ? L"Codas - task confirmation required"
      : attention_ ? L"Codas - connection needs attention"
      : connected_ ? L"Codas - connected, access enabled"
      : enabled_ ? L"Codas - access enabled, connecting"
      : L"Codas - access disabled";
  wcscpy_s(data.szTip, tip);
  if (!Shell_NotifyIconW(NIM_MODIFY, &data)) {
    // A lost tray must not leave a hidden, inaccessible application.
    RemoveTray();
    if (GetHandle()) {
      const auto ex = GetWindowLongPtrW(GetHandle(), GWL_EXSTYLE);
      SetWindowLongPtrW(GetHandle(), GWL_EXSTYLE,
                       (ex & ~static_cast<LONG_PTR>(WS_EX_TOOLWINDOW)) | WS_EX_APPWINDOW);
      SetWindowPos(GetHandle(), nullptr, 0, 0, 0, 0,
                   SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
      ShowPanel();
    }
  }
}

void FlutterWindow::ShowTrayMenu() {
  HWND hwnd = GetHandle();
  if (!hwnd || !tray_added_) return;
  HMENU menu = CreatePopupMenu();
  if (!menu) return;
  AppendMenuW(menu, MF_STRING, kOpen, L"Open Codas");
  AppendMenuW(menu, MF_STRING | (IsWindowVisible(hwnd) ? MF_ENABLED : MF_GRAYED),
              kHide, L"Hide panel");
  AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
  AppendMenuW(menu, MF_STRING, kExit, L"Exit Codas");
  POINT p{};
  GetCursorPos(&p);
  SetForegroundWindow(hwnd);
  const UINT selected = static_cast<UINT>(TrackPopupMenu(
      menu, TPM_RETURNCMD | TPM_NONOTIFY | TPM_RIGHTBUTTON, p.x, p.y, 0, hwnd, nullptr));
  DestroyMenu(menu);
  PostMessageW(hwnd, WM_NULL, 0, 0);
  if (selected == kOpen) ShowPanel();
  if (selected == kHide) HidePanel();
  if (selected == kExit) RequestExit();
}

void FlutterWindow::RequestExit() {
  if (exit_approved_) return;
  ShowPanel();
  // Only Dart may approve exit, after the existing model's stop has completed.
  if (channel_ready_ && tray_channel_) {
    tray_channel_->InvokeMethod("requestExit", nullptr);
  }
}

bool FlutterWindow::OnCreate() {
  if (!Win32Window::OnCreate()) return false;
  ConfigureCompactWindow();
  taskbar_created_ = RegisterWindowMessageW(L"TaskbarCreated");
  RECT frame = GetClientArea();
  flutter_controller_ = std::make_unique<flutter::FlutterViewController>(
      frame.right - frame.left, frame.bottom - frame.top, project_);
  if (!flutter_controller_->engine() || !flutter_controller_->view()) return false;
  RegisterPlugins(flutter_controller_->engine());
  SetChildContent(flutter_controller_->view()->GetNativeWindow());
  tray_channel_ = std::make_unique<flutter::MethodChannel<flutter::EncodableValue>>(
      flutter_controller_->engine()->messenger(), "codas/windows/tray",
      &flutter::StandardMethodCodec::GetInstance());
  tray_channel_->SetMethodCallHandler(
      [this](const flutter::MethodCall<flutter::EncodableValue>& call,
             std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result) {
        if (call.method_name() == "state") {
          const auto* args = call.arguments()
              ? std::get_if<flutter::EncodableMap>(call.arguments()) : nullptr;
          bool enabled = false, connected = false, pending = false, attention = false;
          if (!args || !ReadBool(*args, "enabled", &enabled) ||
              !ReadBool(*args, "connected", &connected) ||
              !ReadBool(*args, "pending", &pending) ||
              !ReadBool(*args, "attention", &attention)) {
            result->Error("INVALID_STATE", "Invalid local tray state");
            return;
          }
          const bool new_pending = pending && !pending_;
          enabled_ = enabled;
          connected_ = connected;
          pending_ = pending;
          attention_ = attention;
          channel_ready_ = true;
          if (!tray_added_) InstallTray();
          UpdateTray();
          result->Success();
          if (new_pending) {
            ShowPanel();
            tray_channel_->InvokeMethod("openApproval", nullptr);
          }
          return;
        }
        if (call.method_name() == "exitApproved") {
          if (!channel_ready_ || enabled_ || pending_) {
            result->Error("STOP_NOT_VERIFIED", "Access must be stopped before exit");
            return;
          }
          exit_approved_ = true;
          result->Success();
          PostMessageW(GetHandle(), kExitApproved, 0, 0);
          return;
        }
        result->NotImplemented();
      });
  flutter_controller_->engine()->SetNextFrameCallback([this]() { ShowPanel(); });
  flutter_controller_->ForceRedraw();
  return true;
}

void FlutterWindow::OnDestroy() {
  RemoveTray();
  tray_channel_.reset();
  flutter_controller_.reset();
  Win32Window::OnDestroy();
}

LRESULT FlutterWindow::MessageHandler(HWND hwnd, UINT const message,
                                      WPARAM const wparam,
                                      LPARAM const lparam) noexcept {
  if (taskbar_created_ != 0 && message == taskbar_created_ && channel_ready_) {
    // Explorer was restarted. Re-register; keep the panel reachable on failure.
    tray_added_ = false;
    tray_hwnd_ = nullptr;
    if (!InstallTray()) {
      const auto ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
      SetWindowLongPtrW(hwnd, GWL_EXSTYLE,
                       (ex & ~static_cast<LONG_PTR>(WS_EX_TOOLWINDOW)) | WS_EX_APPWINDOW);
      SetWindowPos(hwnd, nullptr, 0, 0, 0, 0,
                   SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
      ShowPanel();
    }
    return 0;
  }
  switch (message) {
    case kCodasActivateExisting: ShowPanel(); return 0;
    case kTrayCallback: {
      if (!tray_added_) return 0;
      const UINT event = LOWORD(lparam);
      if (event == NIN_SELECT || event == NIN_KEYSELECT) {
        if (IsWindowVisible(hwnd)) HidePanel();
        else ShowPanel();
      } else if (event == WM_CONTEXTMENU) {
        ShowTrayMenu();
      }
      return 0;
    }
    case WM_CLOSE:
      if (!exit_approved_ && channel_ready_) {
        if (tray_added_) HidePanel();
        else RequestExit();
        return 0;
      }
      break;
    case kExitApproved:
      if (exit_approved_ && !enabled_) DestroyWindow(hwnd);
      return 0;
  }
  if (flutter_controller_) {
    std::optional<LRESULT> result =
        flutter_controller_->HandleTopLevelWindowProc(hwnd, message, wparam, lparam);
    if (result) return *result;
    if (message == WM_FONTCHANGE) flutter_controller_->engine()->ReloadSystemFonts();
  }
  return Win32Window::MessageHandler(hwnd, message, wparam, lparam);
}
