#ifndef RUNNER_FLUTTER_WINDOW_H_
#define RUNNER_FLUTTER_WINDOW_H_

#include <flutter/dart_project.h>
#include <flutter/flutter_view_controller.h>
#include <flutter/method_channel.h>
#include <flutter/standard_method_codec.h>
#include <shellapi.h>
#include <memory>
#include "win32_window.h"

// Public message only reopens the existing UI; it cannot grant access.
constexpr UINT kCodasActivateExisting = WM_APP + 0x52;

class FlutterWindow : public Win32Window {
 public:
  explicit FlutterWindow(const flutter::DartProject& project);
  virtual ~FlutterWindow();
 protected:
  bool OnCreate() override;
  void OnDestroy() override;
  LRESULT MessageHandler(HWND window, UINT const message, WPARAM const wparam,
                         LPARAM const lparam) noexcept override;
 private:
  void ConfigureCompactWindow();
  void ShowPanel();
  void HidePanel();
  bool InstallTray();
  void RemoveTray();
  void UpdateTray();
  void ShowTrayMenu();
  void RequestExit();
  flutter::DartProject project_;
  std::unique_ptr<flutter::FlutterViewController> flutter_controller_;
  std::unique_ptr<flutter::MethodChannel<flutter::EncodableValue>> tray_channel_;
  HWND tray_hwnd_ = nullptr;
  UINT taskbar_created_ = 0;
  HICON tray_icon_ = nullptr;  // shared resource, not owned
  bool tray_added_ = false;
  bool channel_ready_ = false;
  bool enabled_ = false;
  bool connected_ = false;
  bool pending_ = false;
  bool attention_ = false;
  bool exit_approved_ = false;
};
#endif
