import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'dart:math' as math;

import 'device_painter.dart' as art;

import 'main.dart' as shared;
import 'agent_network.dart';
import 'core_device_info.dart';

class AgentModel extends ChangeNotifier {
  AgentModel({bool loadLocalProfile = true}) {
    if (loadLocalProfile) unawaited(_loadProfile());
  }

  String phase = 'off';
  String error = '';
  String endpoint = '';
  String workspace = '';
  String publicStatus = 'unchecked';
  String backendStatus = 'unchecked';
  String proxyStatus = 'unchecked';
  bool paired = false;
  bool disposed = false;
  Map<String, dynamic>? approval;
  CoreDisplayDevice? _coreDevice;
  CoreDisplayDevice? get coreDevice => connected ? _coreDevice : null;
  Process? _worker;
  int _generation = 0;
  bool _starting = false;

  bool get enabled => _starting || _worker != null;
  bool get connected => phase == 'connected' && enabled;

  void changed() {
    if (!disposed) notifyListeners();
  }

  Future<void> _loadProfile() async {
    if (!Platform.isWindows) return;
    final base = Platform.environment['LOCALAPPDATA'];
    if (base == null) return;
    try {
      final profile = jsonDecode(
        await File('$base\\CodasWindowsAgent\\state-v3\\profile.json')
            .readAsString(),
      );
      if (disposed || enabled || profile is! Map) return;
      if (profile['paired'] == true &&
          profile['endpoint'] is String &&
          profile['workspace'] is String) {
        endpoint = validateCoordinatorOrigin(profile['endpoint'] as String);
        paired = true;
        workspace = profile['workspace'] as String;
        changed();
      }
    } catch (_) {
      // An absent profile is not a paired device.
    }
  }

  Future<void> start({
    required String origin,
    required String root,
    required String pairing,
  }) async {
    if (enabled || disposed) return;
    final generation = ++_generation;
    _starting = true;
    phase = 'connecting';
    _coreDevice = null;
    error = '';
    publicStatus = 'unchecked';
    backendStatus = 'unchecked';
    proxyStatus = 'checking';
    approval = null;
    changed();
    try {
      if (!Platform.isWindows) throw StateError('WINDOWS_REQUIRED');
      origin = validateCoordinatorOrigin(origin);
      if (paired && endpoint != origin) {
        throw StateError('PAIRING_PROFILE_MISMATCH');
      }
      endpoint = origin;
      final app = File(Platform.resolvedExecutable).parent.path;
      final runtime = '$app\\runtime';
      final node = '$runtime\\node.exe';
      final script = '$runtime\\desktop-worker.mjs';
      if (!await File(node).exists() || !await File(script).exists()) {
        throw StateError('RUNTIME_UNAVAILABLE');
      }
      final proxy = await resolveAgentProxy(
        environment: Platform.environment,
        systemProxy: () => windowsSystemProxy(origin),
      );
      if (disposed || generation != _generation) return;
      proxyStatus = proxy.source;
      changed();
      final worker = await Process.start(
        node,
        ['--use-env-proxy', script],
        workingDirectory: runtime,
        environment: proxy.environment,
        runInShell: false,
      );
      if (disposed || generation != _generation) {
        unawaited(worker.stdin.close().then<void>((_) {}));
        worker.kill();
        return;
      }
      _worker = worker;
      _starting = false;
      worker.stdout
          .transform(utf8.decoder)
          .transform(const LineSplitter())
          .listen(
            (line) {
              if (generation == _generation && !disposed) {
                try {
                  final data = jsonDecode(line);
                  if (data is Map<String, dynamic>) receive(data);
                } catch (_) {}
              }
            },
            onError: (Object _) {
              if (generation == _generation) {
                error = 'RUNTIME_CHANNEL_FAILED';
                unawaited(stop());
              }
            },
          );
      // Consume diagnostics without copying potentially sensitive backend logs.
      worker.stderr.listen((_) {}, onError: (Object _) {});
      unawaited(
        worker.exitCode.then((code) {
          if (generation == _generation && _worker == worker) {
            _worker = null;
            _starting = false;
            approval = null;
            _coreDevice = null;
            phase = 'off';
            if (code != 0 && error.isEmpty) error = 'RUNTIME_STOPPED';
            changed();
          }
        }),
      );
      _send({
        'type': 'start',
        'endpoint': origin,
        'workspace': root,
        'pairing': pairing,
        'localConsent': true,
        'authorizationMode': 'session-v1',
      });
    } catch (e) {
      if (generation == _generation) {
        _starting = false;
        phase = 'off';
        error = e is StateError ? e.message.toString() : 'RUNTIME_UNAVAILABLE';
        if (proxyStatus == 'checking') proxyStatus = 'unchecked';
        if (error == 'SYSTEM_PROXY_UNVERIFIED') proxyStatus = 'unverified';
        changed();
      }
    }
  }

  void receive(Map<String, dynamic> message) {
    switch (message['type']) {
      case 'state':
        final value = message['value'];
        if ([
          'connecting',
          'reconnecting',
          'connected',
          'stopped',
        ].contains(value)) {
          phase = value == 'stopped' ? 'off' : value as String;
          if (phase != 'connected') approval = null;
          _coreDevice = connected
              ? CoreDisplayDevice.parse(message['coreDevice'])
              : null;
        }
        break;
      case 'paired':
        if (message['endpoint'] == endpoint && endpoint.isNotEmpty &&
            message['workspace'] is String) {
          paired = true;
          endpoint = message['endpoint'] as String;
          workspace = message['workspace'] as String;
        }
        break;
      case 'diagnostic':
        final value = message['value'];
        if (value is String &&
            message['layer'] == 'public' &&
            [
              'checking',
              'reachable',
              'rejected',
              'http_error',
              'invalid_response',
              'unreachable',
            ].contains(value)) {
          publicStatus = value;
        }
        if (value is String &&
            message['layer'] == 'backend' &&
            [
              'checking',
              'reachable',
              'scope_mismatch',
              'config_required',
              'unavailable',
            ].contains(value)) {
          backendStatus = value;
        }
        break;
      case 'confirmation':
        if (connected &&
            message['id'] is String &&
            message['description'] is String &&
            message['name'] is String) {
          approval = message;
        }
        break;
      case 'confirmationClosed':
        if (approval?['id'] == message['id']) approval = null;
        break;
      case 'error':
        _coreDevice = null;
        error = message['code'] is String
            ? message['code'] as String
            : 'CONNECTION_OR_PAIRING_FAILED';
        approval = null;
        break;
    }
    changed();
  }

  void _send(Map<String, dynamic> value) {
    try {
      _worker?.stdin.writeln(jsonEncode(value));
    } catch (_) {
      error = 'RUNTIME_CHANNEL_FAILED';
      unawaited(stop());
    }
  }

  void decide(bool allow) {
    final current = approval;
    if (current == null || !connected) return;
    approval = null;
    _send({'type': 'approve', 'id': current['id'], 'allow': allow});
    changed();
  }

  Future<void> stop() async {
    if (!enabled) return;
    ++_generation;
    _starting = false;
    final worker = _worker;
    phase = 'stopping';
    _coreDevice = null;
    approval = null;
    changed();
    if (worker != null) {
      try {
        worker.stdin.writeln(jsonEncode({'type': 'stop'}));
        await worker.stdin.flush().timeout(const Duration(seconds: 1));
        await worker.stdin.close().timeout(const Duration(seconds: 1));
      } catch (_) {}
      try {
        await worker.exitCode.timeout(const Duration(seconds: 3));
      } catch (_) {
        worker.kill();
        try {
          await worker.exitCode.timeout(const Duration(seconds: 3));
        } catch (_) {
          // Retain the owned process handle and do not assert that it stopped.
          error = 'STOP_NOT_VERIFIED';
          phase = 'stop_failed';
          changed();
          return;
        }
      }
    }
    _worker = null;
    phase = 'off';
    changed();
  }

  @override
  void dispose() {
    disposed = true;
    ++_generation;
    final worker = _worker;
    _worker = null;
    if (worker != null) {
      try {
        worker.stdin.writeln('{"type":"stop"}');
      } catch (_) {}
      unawaited(
        worker.stdin.close().then<void>((_) {}).catchError((Object _) {}),
      );
      // Stop only the child process launched by this application.
      worker.kill();
    }
    super.dispose();
  }
}

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const AgentDesktop());
}

class AgentDesktop extends StatelessWidget {
  const AgentDesktop({super.key, this.model, this.trayChannel});
  final AgentModel? model;
  final MethodChannel? trayChannel;
  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'Codas for Windows',
    debugShowCheckedModeBanner: false,
    theme: ThemeData(
      useMaterial3: true,
      scaffoldBackgroundColor: shared.bg,
      colorScheme: ColorScheme.fromSeed(
        seedColor: shared.ink,
        surface: shared.bg,
      ),
      textTheme: ThemeData.light().textTheme.apply(
        bodyColor: shared.ink,
        displayColor: shared.ink,
      ),
      splashFactory: NoSplash.splashFactory,
    ),
    home: AgentPage(model: model, trayChannel: trayChannel),
  );
}

enum AgentPanelPage {
  home,
  settings,
  config,
  diagnostics,
  authorization,
  about,
}

class AgentPage extends StatefulWidget {
  const AgentPage({super.key, this.model, this.trayChannel});
  final AgentModel? model;
  final MethodChannel? trayChannel;
  @override
  State<AgentPage> createState() => _AgentPageState();
}

class _AgentPageState extends State<AgentPage>
    with SingleTickerProviderStateMixin {
  late final AgentModel model;
  late final AnimationController motion;
  final endpoint = TextEditingController();
  final root = TextEditingController();
  final pairing = TextEditingController();
  AgentPanelPage page = AgentPanelPage.home;
  AgentPanelPage detailParent = AgentPanelPage.settings;
  bool _exitBusy = false;
  bool _toggleBusy = false;
  bool get nativeTray =>
      widget.trayChannel != null ||
      (Platform.isWindows && widget.model == null);
  static const _windowsTray = MethodChannel('codas/windows/tray');
  MethodChannel get tray => widget.trayChannel ?? _windowsTray;
  String get localName {
    try {
      return Platform.localHostname;
    } catch (_) {
      return 'Windows';
    }
  }

  void navigate(AgentPanelPage next) => setState(() {
    if (next != AgentPanelPage.home && next != AgentPanelPage.settings) {
      detailParent = page == AgentPanelPage.home
          ? AgentPanelPage.home
          : AgentPanelPage.settings;
    }
    page = next;
  });
  void back() => setState(() {
    page = page == AgentPanelPage.settings ? AgentPanelPage.home : detailParent;
  });

  Future<void> _syncTray() async {
    if (!nativeTray) return;
    try {
      await tray.invokeMethod<void>('state', {
        'enabled': model.enabled,
        'connected': model.connected,
        'pending': model.approval != null,
        'attention': model.error.isNotEmpty || model.phase == 'reconnecting',
      });
    } on PlatformException {
      // A failed tray update cannot change permissions or session state.
    } on MissingPluginException {
      // The old runner lacks native tray support; do not auto-enable anything.
    }
  }

  Future<dynamic> _handleTray(MethodCall call) async {
    if (call.method == 'requestExit') {
      await _requestExit();
      return null;
    }
    if (call.method == 'openApproval' && mounted && model.approval != null) {
      navigate(AgentPanelPage.authorization);
      return null;
    }
    return null;
  }

  Future<void> _requestExit() async {
    if (_exitBusy || !mounted) return;
    if (_toggleBusy || model.phase == 'stopping') {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('正在处理访问状态，请完成后退出。')));
      return;
    }
    _exitBusy = true;
    try {
      final accepted = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('退出 Codas？'),
          content: const Text('退出将停止接收新任务。仅隐藏窗口不会关闭已授权的访问会话。已运行的操作可能仍在完成。'),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('取消'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('退出并停止访问'),
            ),
          ],
        ),
      );
      if (accepted != true || !mounted) return;
      await model.stop();
      if (!mounted) return;
      if (model.enabled || model.phase == 'stop_failed') {
        navigate(AgentPanelPage.diagnostics);
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('尚未确认访问服务停止，未退出。请重试。')));
        return;
      }
      if (nativeTray) {
        await _syncTray();
        await tray.invokeMethod<void>('exitApproved');
      }
    } on PlatformException {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('无法确认退出，请重试。')));
      }
    } on MissingPluginException {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('当前窗口不支持托盘退出。')));
      }
    } finally {
      _exitBusy = false;
    }
  }

  @override
  void initState() {
    super.initState();
    model = widget.model ?? AgentModel();
    motion = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 30),
    );
    if (nativeTray) {
      tray.setMethodCallHandler(_handleTray);
      // The Windows runner may install its channel after Dart starts.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) unawaited(_syncTray());
      });
    }
    model.addListener(update);
    update();
  }

  void update() {
    if (!mounted) return;
    if (model.paired) {
      if (endpoint.text != model.endpoint) endpoint.text = model.endpoint;
      if (root.text != model.workspace) root.text = model.workspace;
      pairing.clear();
    }
    if (model.enabled && model.phase != 'stopping') {
      if (!motion.isAnimating) motion.repeat();
    } else {
      motion.stop();
      motion.reset();
    }
    setState(() {});
    unawaited(_syncTray());
  }

  @override
  void dispose() {
    if (nativeTray) tray.setMethodCallHandler(null);
    model.removeListener(update);
    if (widget.model == null) model.dispose();
    endpoint.dispose();
    root.dispose();
    pairing.dispose();
    motion.dispose();
    super.dispose();
  }

  Future<void> toggle(bool desired) async {
    if (_toggleBusy || _exitBusy || model.phase == 'stopping') return;
    _toggleBusy = true;
    try {
      await _toggle(desired);
    } finally {
      _toggleBusy = false;
      if (mounted) setState(() {});
    }
  }

  Future<void> _toggle(bool desired) async {
    if (!desired) {
      await model.stop();
      return;
    }
    String origin;
    try {
      origin = validateCoordinatorOrigin(endpoint.text);
    } on StateError {
      navigate(AgentPanelPage.config);
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('请填写可信的 HTTPS Core 地址')),
      );
      return;
    }
    final workspace = root.text.trim();
    if (origin.isEmpty ||
        workspace.isEmpty ||
        (!model.paired && pairing.text.trim().isEmpty)) {
      navigate(AgentPanelPage.config);
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('请先填写配对与工作目录设置')));
      return;
    }
    final accepted = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('开启本机远程访问？'),
        content: Text(
          '仅限你拥有或获准管理的电脑。\n\n入口：$origin\n工作目录：$workspace\n\n开启后，本次会话内已配对的客户端可执行代码、脚本及文件操作，无需逐次确认。脚本使用当前 Windows 账户权限；工作目录不是操作系统沙箱。隐藏窗口不会关闭本次访问会话。关闭访问或退出 Codas 后停止接收新任务，已经运行的操作可能仍在完成。',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('确认开启'),
          ),
        ],
      ),
    );
    if (accepted == true && mounted) {
      final code = pairing.text;
      pairing.clear();
      await model.start(origin: origin, root: workspace, pairing: code);
    }
  }

  String get title => switch (model.phase) {
    'connected' when model.connected => '已连接',
    'connecting' => '正在连接',
    'reconnecting' => '正在重连',
    'stopping' => '正在关闭',
    'stop_failed' => '关闭未确认',
    _ => '未连接',
  };

  String get friendlyError => switch (model.error) {
    'BUNDLED_BACKEND_MISSING' => '安装包的内置组件缺失，请重新安装已验证的完整安装包。',
    'BUNDLED_BACKEND_UNAVAILABLE' => '内置 DevSpace 未能启动或端口被占用，请关闭访问后重试。',
    'APPROVED_BACKEND_UNAVAILABLE' => '内置 DevSpace 未就绪，请关闭访问后重试。',
    'APPROVED_BACKEND_CONFIG_REQUIRED' => '内置 DevSpace 配置未就绪。',
    'BACKEND_SCOPE_MISMATCH' => 'DevSpace 允许目录必须与当前选定的单一工作目录一致。',
    'PAIRING_PROFILE_MISMATCH' => '配对配置不一致；未覆盖原有设备身份。',
    'LEGACY_INGRESS_RETIRED' => '旧配对入口已停用。未发送凭据或修改原有配对，请先迁移设备配置。',
    'SYSTEM_PROXY_UNVERIFIED' => '无法确认 Windows 系统代理设置，未尝试其他网络路径。',
    'PAIRING_REJECTED' => '入口拒绝配对请求，请检查配对码与入口权限。',
    'PAIRING_FAILED' => '配对未完成，请查看公网入口和代理诊断。',
    'SSE_AUTH_REJECTED' => 'SSE 会话鉴权或入口访问被拒绝。',
    'SSE_UNAVAILABLE' => '公网入口未返回有效 SSE 流；不会切换到其他入口。',
    'SSE_LEASE_CONFLICT' => 'SSE 会话冲突，请检查是否有其他实例正在使用同一配对。',
    'PAIRING_REQUIRED' => '请输入首次配对码。',
    'HTTPS_ORIGIN_REQUIRED' => '请填写可信的 HTTPS 入口域名。',
    'WORKSPACE_REQUIRED' ||
    'WORKSPACE_SCOPE_REQUIRED' => '请选择个人用户目录下已存在的专用项目文件夹。',
    'RUNTIME_UNAVAILABLE' => '运行组件缺失或无法启动。请检查正常安装状态；不会自动恢复组件。',
    'STOP_NOT_VERIFIED' => '尚未确认访问组件退出，请再次关闭或退出应用。',
    _ => '未能完成连接或配对，请检查配置与已授权的本地运行环境。',
  };

  String diagnosticLabel(String value) => switch (value) {
    'checking' => '检查中',
    'reachable' => '已验证可达',
    'rejected' => 'HTTP 访问被拒绝',
    'http_error' => 'HTTP 响应异常',
    'invalid_response' => '响应格式异常',
    'unreachable' => '连接失败或超时',
    'scope_mismatch' => '授权目录不匹配',
    'config_required' => '缺少授权配置',
    'unavailable' => '本地服务不可用',
    'environment' => '环境变量代理',
    'system' => 'Windows 系统代理',
    'direct' => '系统选择直连',
    'unverified' => '无法确认系统代理',
    _ => '尚未验证',
  };

  String get pageTitle => switch (page) {
    AgentPanelPage.home => '',
    AgentPanelPage.settings => '设置',
    AgentPanelPage.config => '连接配置',
    AgentPanelPage.diagnostics => '连接诊断',
    AgentPanelPage.authorization => '会话授权',
    AgentPanelPage.about => '关于 Codas',
  };

  Widget logo() => const Text.rich(
    TextSpan(
      text: 'codas',
      style: TextStyle(
        fontFamily: 'CodasLogo',
        fontSize: 29,
        fontWeight: FontWeight.w900,
        letterSpacing: -1.6,
        color: art.codasInk,
      ),
      children: [
        TextSpan(
          text: '.',
          style: TextStyle(color: art.codasRed),
        ),
      ],
    ),
  );

  Widget header() => SizedBox(
    height: 44,
    child: Row(
      children: [
        if (page == AgentPanelPage.home)
          logo()
        else ...[
          IconButton(
            tooltip: '返回',
            onPressed: back,
            icon: const Icon(Icons.chevron_left_rounded, size: 28),
          ),
          Flexible(
            child: Text(
              pageTitle,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w700),
            ),
          ),
        ],
        const Spacer(),
        const Text(
          'WINDOWS',
          style: TextStyle(
            fontSize: 11,
            color: art.codasMuted,
            fontWeight: FontWeight.w400,
          ),
        ),
        if (page == AgentPanelPage.home) ...[
          const SizedBox(width: 12),
          Material(
            shape: const CircleBorder(),
            color: const Color(0xffe9e9e5),
            child: IconButton(
              tooltip: '设置',
              onPressed: () => navigate(AgentPanelPage.settings),
              icon: const Icon(
                Icons.settings_outlined,
                color: art.codasInk,
                size: 23,
              ),
            ),
          ),
        ],
      ],
    ),
  );

  Widget accessCard() {
    final enabled = model.enabled;
    final canToggle = !_toggleBusy && !_exitBusy && model.phase != 'stopping';
    final description = !enabled
        ? '开启后连接 AI 助手'
        : model.phase == 'stop_failed'
        ? '尚未确认停止，请重试关闭'
        : model.phase == 'stopping'
        ? '正在关闭访问'
        : model.connected
        ? 'AI 助手可操作此设备'
        : model.phase == 'reconnecting'
        ? '正在重连 · 暂不可用'
        : '正在建立连接';
    return Semantics(
      label: '允许访问',
      toggled: enabled,
      button: true,
      child: Material(
        color: const Color(0xff20211e),
        borderRadius: BorderRadius.circular(23),
        child: InkWell(
          key: const ValueKey('allow-access'),
          borderRadius: BorderRadius.circular(23),
          onTap: canToggle ? () => toggle(!enabled) : null,
          child: Container(
            constraints: const BoxConstraints(minHeight: 96),
            padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 12),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text(
                        '允许访问',
                        style: TextStyle(
                          color: Colors.white,
                          fontSize: 19,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      const SizedBox(height: 7),
                      Text(
                        description,
                        style: const TextStyle(
                          color: Color(0xffb3b4ad),
                          fontSize: 13,
                          height: 1.35,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 12),
                AnimatedContainer(
                  duration: const Duration(milliseconds: 300),
                  width: 58,
                  height: 34,
                  padding: const EdgeInsets.all(4),
                  decoration: BoxDecoration(
                    color: enabled ? art.codasBg : const Color(0xff50514b),
                    borderRadius: BorderRadius.circular(30),
                  ),
                  child: AnimatedAlign(
                    duration: const Duration(milliseconds: 350),
                    curve: Curves.easeOutBack,
                    alignment: enabled
                        ? Alignment.centerRight
                        : Alignment.centerLeft,
                    child: Container(
                      width: 26,
                      height: 26,
                      decoration: BoxDecoration(
                        color: enabled ? const Color(0xff20211e) : art.codasBg,
                        shape: BoxShape.circle,
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget notice(String label, AgentPanelPage target) => Material(
    color: art.codasSoft,
    borderRadius: BorderRadius.circular(16),
    child: InkWell(
      onTap: () => navigate(target),
      borderRadius: BorderRadius.circular(16),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
        child: Row(
          children: [
            const CircleAvatar(radius: 3.5, backgroundColor: art.codasRed),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                label,
                style: const TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
            const Icon(Icons.chevron_right, color: art.codasMuted, size: 19),
          ],
        ),
      ),
    ),
  );

  Widget homeBody() {
    final phase = model.connected
        ? art.LinkPhase.connected
        : model.enabled
        ? art.LinkPhase.connecting
        : art.LinkPhase.off;
    return LayoutBuilder(
      builder: (context, box) {
        final artWidth = math.min(
          box.maxWidth,
          math.max(120.0, box.maxHeight * .47 * 230 / 165),
        );
        final compact =
            box.maxHeight < 485 ||
            MediaQuery.textScalerOf(context).scale(1) > 1.2;
        final artwork = Center(
          child: SizedBox(
            width: artWidth,
            child: AspectRatio(
              aspectRatio: 230 / 165,
              child: RepaintBoundary(
                child: CustomPaint(
                  painter: art.DeviceConnectionPainter(
                    local: art.DeviceKind.pc,
                    core: model.coreDevice?.kind ?? art.DeviceKind.unknown,
                    phase: phase,
                    motion: motion,
                    reduceMotion: MediaQuery.disableAnimationsOf(context),
                  ),
                ),
              ),
            ),
          ),
        );
        final children = <Widget>[
          artwork,
          const SizedBox(height: 16),
          Text(
            title,
            textAlign: TextAlign.center,
            style: const TextStyle(
              fontSize: 34,
              fontWeight: FontWeight.w700,
              height: 1.18,
            ),
          ),
          const SizedBox(height: 9),
          Text(
            "$localName · ${model.coreDevice?.name ?? 'Core'}",
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            textAlign: TextAlign.center,
            style: const TextStyle(color: art.codasMuted, fontSize: 14),
          ),
          if (compact) const SizedBox(height: 22) else const Spacer(flex: 2),
          accessCard(),
          if (model.approval != null) ...[
            const SizedBox(height: 10),
            notice('有一项任务待确认', AgentPanelPage.authorization),
          ],
          if (model.error.isNotEmpty || model.phase == 'reconnecting') ...[
            const SizedBox(height: 10),
            notice('连接异常 · 查看诊断', AgentPanelPage.diagnostics),
          ],
        ];
        if (compact || (model.approval != null && model.error.isNotEmpty)) {
          // A scrolling compact surface never hides the access switch.
          return SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: children.where((w) => w is! Spacer).toList(),
            ),
          );
        }
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [const Spacer(flex: 2), ...children, const Spacer(flex: 1)],
        );
      },
    );
  }

  Widget section(String label, List<Widget> rows) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      Text(label, style: const TextStyle(color: art.codasMuted, fontSize: 12)),
      const SizedBox(height: 9),
      Material(
        color: art.codasSoft,
        borderRadius: BorderRadius.circular(20),
        clipBehavior: Clip.antiAlias,
        child: Column(
          children: [
            for (var i = 0; i < rows.length; i++) ...[
              if (i != 0)
                const Divider(
                  height: 1,
                  indent: 16,
                  endIndent: 16,
                  color: Color(0xffdadbd5),
                ),
              rows[i],
            ],
          ],
        ),
      ),
    ],
  );

  Widget info(String label, String value) => Padding(
    padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 15),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(child: Text(label, style: const TextStyle(fontSize: 13))),
        const SizedBox(width: 12),
        Flexible(
          child: Text(
            value,
            textAlign: TextAlign.end,
            style: const TextStyle(fontSize: 12, color: art.codasMuted),
          ),
        ),
      ],
    ),
  );

  Widget setting(
    AgentPanelPage target,
    String label,
    IconData icon,
    String subtitle,
  ) => InkWell(
    onTap: () => navigate(target),
    child: Padding(
      padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 15),
      child: Row(
        children: [
          Icon(icon, color: art.codasInk, size: 20),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  label,
                  style: const TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                if (subtitle.isNotEmpty) ...[
                  const SizedBox(height: 4),
                  Text(
                    subtitle,
                    style: const TextStyle(fontSize: 12, color: art.codasMuted),
                  ),
                ],
              ],
            ),
          ),
          const Icon(Icons.chevron_right, color: art.codasMuted, size: 20),
        ],
      ),
    ),
  );

  Widget pageList(List<Widget> items) => ListView(
    padding: const EdgeInsets.only(top: 24, bottom: 12),
    children: items,
  );

  Widget settingsBody() => pageList([
    const Text('当前设备', style: TextStyle(fontSize: 12, color: art.codasMuted)),
    const SizedBox(height: 7),
    Text(
      localName,
      style: const TextStyle(fontSize: 23, fontWeight: FontWeight.w700),
    ),
    const SizedBox(height: 6),
    Text(title, style: const TextStyle(fontSize: 13, color: art.codasMuted)),
    const SizedBox(height: 24),
    section('连接与访问', [
      setting(
        AgentPanelPage.config,
        '连接配置',
        Icons.hub_outlined,
        model.paired ? '已配对 · 工作目录' : '尚未配对',
      ),
      setting(
        AgentPanelPage.diagnostics,
        '连接诊断',
        Icons.monitor_heart_outlined,
        model.error.isNotEmpty ? '存在连接异常' : '查看连接状态',
      ),
      setting(
        AgentPanelPage.authorization,
        '会话授权',
        Icons.fact_check_outlined,
        model.approval != null
            ? '有请求待确认'
            : model.enabled
            ? '本次访问已授权'
            : '未开启访问',
      ),
    ]),
    const SizedBox(height: 22),
    section('应用', [
      setting(AgentPanelPage.about, '关于 Codas', Icons.info_outline, ''),
    ]),
  ]);

  InputDecoration inputDecoration(String label, {String? hint}) =>
      InputDecoration(
        labelText: label,
        hintText: hint,
        isDense: true,
        filled: true,
        fillColor: art.codasBg,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(10),
          borderSide: BorderSide.none,
        ),
      );

  Widget configBody() => pageList([
    section('设备身份', [
      info(
        '当前 Core',
        model.coreDevice?.name ?? (model.connected ? '型号未由协调端提供' : '尚未连接'),
      ),
      info('配对状态', model.paired ? '已配对' : '未配对'),
    ]),
    const SizedBox(height: 22),
    section('连接配置', [
      Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            TextField(
              key: const ValueKey('endpoint-field'),
              controller: endpoint,
              enabled: !model.enabled && !model.paired,
              keyboardType: TextInputType.url,
              autocorrect: false,
              enableSuggestions: false,
              style: const TextStyle(fontSize: 12),
              decoration: inputDecoration('Core HTTPS 地址', hint: 'https://core.example.com'),
            ),
            const SizedBox(height: 14),
            TextField(
              key: const ValueKey('workspace-field'),
              controller: root,
              enabled: !model.enabled && !model.paired,
              style: const TextStyle(fontSize: 12),
              decoration: inputDecoration(
                '专用工作目录',
                hint: r'C:\Users\you\Documents\CodasWorkspace',
              ),
            ),
            if (!model.paired) ...[
              const SizedBox(height: 14),
              TextField(
                key: const ValueKey('pairing-field'),
                controller: pairing,
                enabled: !model.enabled,
                obscureText: true,
                autocorrect: false,
                enableSuggestions: false,
                decoration: inputDecoration('首次配对码'),
              ),
            ],
            const SizedBox(height: 12),
            Text(
              model.paired
                  ? '已配对 · 地址与设备身份绑定，避免凭据跨服务器使用。'
                  : '输入你信任的 Core 地址及其配对码。仅访问授权工作目录；首次配对成功后保存到本机。',
              style: const TextStyle(
                color: art.codasMuted,
                fontSize: 12,
                height: 1.5,
              ),
            ),
          ],
        ),
      ),
    ]),
    const SizedBox(height: 12),
    if (!model.paired)
      FilledButton(
        onPressed: () {
          FocusScope.of(context).unfocus();
          navigate(AgentPanelPage.home);
        },
        child: const Text('返回主界面'),
      ),
  ]);

  Widget diagnosticsBody() => pageList([
    Text(
      title,
      style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w700),
    ),
    const SizedBox(height: 8),
    if (model.error.isNotEmpty)
      Text(
        friendlyError,
        style: const TextStyle(color: art.codasRed, fontSize: 13, height: 1.5),
      ),
    const SizedBox(height: 22),
    section('连接状态', [
      info('公网入口', diagnosticLabel(model.publicStatus)),
      info('SSE 会话', model.connected ? '已认证' : title),
      info('本机 DevSpace', diagnosticLabel(model.backendStatus)),
      info('网络代理', diagnosticLabel(model.proxyStatus)),
    ]),
    if (model.phase == 'reconnecting') ...[
      const SizedBox(height: 16),
      const Text(
        '正在尝试恢复连接。恢复前不会接收新任务。',
        style: TextStyle(color: art.codasMuted, fontSize: 12, height: 1.5),
      ),
    ],
  ]);

  Widget authorizationBody() {
    final request = model.approval;
    return pageList([
      if (model.connected)
        const Text(
          '已验证的 SSE 会话 · 本次访问已授权',
          style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
        )
      else
        Text(
          title,
          style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700),
        ),
      const SizedBox(height: 14),
      const Text(
        '开启访问后，本次会话内已配对的客户端可以执行已授权的代码、脚本及文件操作，无需逐次确认。关闭访问或退出后停止接收新任务；工作目录不是操作系统沙箱。隐藏面板仍保留已授权的访问会话。',
        style: TextStyle(fontSize: 13, color: art.codasMuted, height: 1.5),
      ),
      if (request != null) ...[
        const SizedBox(height: 22),
        section('任务确认 · ${request['timeoutSeconds']} 秒内', [
          info('操作', request['name'].toString()),
          Padding(
            padding: const EdgeInsets.all(14),
            child: SelectableText(
              request['description'].toString(),
              style: const TextStyle(fontSize: 12, fontFamily: 'monospace'),
            ),
          ),
        ]),
        const SizedBox(height: 14),
        Row(
          children: [
            Expanded(
              child: OutlinedButton(
                onPressed: () => model.decide(false),
                child: const Text('拒绝'),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: FilledButton(
                onPressed: () => model.decide(true),
                child: const Text('允许本次'),
              ),
            ),
          ],
        ),
      ],
    ]);
  }

  Widget aboutBody() => pageList([
    Center(child: logo()),
    const SizedBox(height: 20),
    section('应用信息', [
      info('平台', 'Windows'),
      info('版本', '0.2.0-rc.8 candidate'),
      info('运行方式', '托盘面板'),
    ]),
    const SizedBox(height: 18),
    if (nativeTray)
      OutlinedButton(onPressed: _requestExit, child: const Text('退出 Codas')),
  ]);

  @override
  Widget build(BuildContext context) => Scaffold(
    backgroundColor: art.codasBg,
    body: SafeArea(
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 360, maxHeight: 600),
          child: Padding(
            padding: const EdgeInsets.all(20),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                header(),
                Expanded(
                  child: switch (page) {
                    AgentPanelPage.home => homeBody(),
                    AgentPanelPage.settings => settingsBody(),
                    AgentPanelPage.config => configBody(),
                    AgentPanelPage.diagnostics => diagnosticsBody(),
                    AgentPanelPage.authorization => authorizationBody(),
                    AgentPanelPage.about => aboutBody(),
                  },
                ),
              ],
            ),
          ),
        ),
      ),
    ),
  );
}
