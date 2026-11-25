import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

const bg = Color(0xfff6f6f2);
const ink = Color(0xff1b1c1a);
const soft = Color(0xffebebe6);
const muted = Color(0xff81847e);
const red = Color(0xffd9342b);

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
  runApp(const CodasPreview());
}

class CodasPreview extends StatelessWidget {
  const CodasPreview({super.key});
  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'Codas',
    debugShowCheckedModeBanner: false,
    theme: ThemeData(
      useMaterial3: true,
      brightness: Brightness.light,
      scaffoldBackgroundColor: bg,
      colorScheme: ColorScheme.fromSeed(seedColor: ink, surface: bg),
      textTheme: ThemeData.light().textTheme.apply(
        bodyColor: ink,
        displayColor: ink,
      ),
      splashFactory: NoSplash.splashFactory,
    ),
    home: const PreviewPage(),
  );
}

enum LinkPhase { off, connecting, connected }

class PreviewPage extends StatefulWidget {
  const PreviewPage({super.key});
  @override
  State<PreviewPage> createState() => _PreviewPageState();
}

class _PreviewPageState extends State<PreviewPage>
    with SingleTickerProviderStateMixin, WidgetsBindingObserver {
  LinkPhase phase = LinkPhase.off;
  static const native = MethodChannel('codas/native');
  Timer? pending;
  late final AnimationController motion;
  final ValueNotifier<int> updates = ValueNotifier(0);
  Map<String, dynamic> state = {};
  bool loaded = false;
  bool available = false;
  bool busy = false;
  bool polling = false;
  bool resumed = true;
  int revision = 0;
  String previewEndpoint = '';
  String previewPairing = '';
  bool endpointEdited = false;

  bool get enabled => state['enabled'] == true;
  bool get paired => state['paired'] == true;
  String get device => state['device'] as String? ?? 'Android';
  String get version => state['version'] as String? ?? '';
  String get nativeStatus => state['status'] as String? ?? '';
  bool get recovering =>
      nativeStatus.contains('重连') ||
      nativeStatus.contains('恢复') ||
      nativeStatus.contains('中断');
  String get status {
    if (!loaded) return '正在读取状态';
    if (!available) return '状态不可用';
    return switch (phase) {
      LinkPhase.off => '未连接',
      LinkPhase.connecting => recovering ? '正在重连' : '连接中',
      LinkPhase.connected => '已连接',
    };
  }

  String get subtitle {
    if (!available) return '正在读取设备真实状态';
    if (phase == LinkPhase.connecting) {
      return recovering ? '正在恢复安全连接…' : '正在建立安全连接…';
    }
    if (nativeStatus.startsWith('无法开启') || nativeStatus.startsWith('连接停止')) {
      return nativeStatus;
    }
    return '$device · Codas 网络';
  }

  String get description => !available
      ? '正在同步设备状态'
      : switch (phase) {
          LinkPhase.off => '开启后连接 AI 助手',
          LinkPhase.connecting => '正在连接 Codas 网络',
          LinkPhase.connected => 'AI 助手可操作此设备',
        };
  Map<String, dynamic> get task =>
      Map<String, dynamic>.from(state['task'] as Map? ?? {});
  String get taskCode => task['status'] as String? ?? 'idle';
  String get taskLabel => !available
      ? '正在读取任务状态'
      : switch (taskCode) {
          'idle' => '暂无待安装应用',
          'downloading' => '正在下载安装包',
          'ready_to_install' => '已下载 · 等待安装',
          'installing' => '正在准备系统安装',
          'awaiting_confirmation' => '等待系统安装确认',
          'installed' => '安装完成',
          'cancelled' => '已取消',
          'failed' => '安装失败',
          'installation_reported_success_verify_launch' => '安装已报告成功 · 请核验',
          _ => taskCode,
        };

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    motion = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 30),
    );
    pending = Timer.periodic(const Duration(seconds: 1), (_) => poll());
    unawaited(poll());
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState next) {
    resumed = next == AppLifecycleState.resumed;
    if (resumed) unawaited(poll());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    pending?.cancel();
    updates.dispose();
    motion.dispose();
    super.dispose();
  }

  void applySnapshot(Map<dynamic, dynamic>? result) {
    if (!mounted || result == null) return;
    final value = Map<String, dynamic>.from(result);
    final next = value['enabled'] == true
        ? (value['connected'] == true
              ? LinkPhase.connected
              : LinkPhase.connecting)
        : LinkPhase.off;
    final oldPhase = phase;
    setState(() {
      state = value;
      loaded = true;
      available = true;
      phase = next;
      if (!endpointEdited) previewEndpoint = value['endpoint'] as String? ?? '';
    });
    if (oldPhase != next) {
      if (next == LinkPhase.off) {
        motion.stop();
        motion.reset();
      } else if (!motion.isAnimating) {
        motion.repeat();
      }
    }
    updates.value++;
  }

  Future<void> poll() async {
    if (!mounted || !resumed || polling || busy) return;
    polling = true;
    final captured = revision;
    try {
      final result = await native.invokeMapMethod<dynamic, dynamic>('snapshot');
      if (captured == revision) applySnapshot(result);
    } on PlatformException {
      if (mounted && captured == revision) {
        setState(() {
          loaded = true;
          available = false;
        });
        updates.value++;
      }
    } on MissingPluginException {
      if (mounted && captured == revision) {
        setState(() {
          loaded = true;
          available = false;
        });
        updates.value++;
      }
    } finally {
      polling = false;
    }
  }

  String friendly(String code) => switch (code) {
    'HTTPS_ORIGIN_REQUIRED' => '请填写有效的 HTTPS Codas 入口',
    'PAIRING_REQUIRED' => '请填写首次配对码',
    'WAIT_FOR_SERVICE_STOP' => '正在关闭连接，请稍后重试',
    'APK_HASH_MISMATCH' => '安装包校验不一致，请重新发送',
    'ALLOW_INSTALLATION_ON_PHONE' => '请先允许安装测试应用',
    _ => code,
  };

  void notifyError(String code) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(friendly(code))));
  }

  Future<void> toggle() async {
    if (busy || !available) return;
    final desired = !enabled;
    if (desired && previewEndpoint.trim().isEmpty) {
      notifyError('HTTPS_ORIGIN_REQUIRED');
      return;
    }
    setState(() {
      busy = true;
      revision++;
    });
    try {
      final result = await native.invokeMapMethod<dynamic, dynamic>(
        'setAccess',
        {
          'enabled': desired,
          'endpoint': previewEndpoint,
          'pairing': previewPairing,
        },
      );
      if (!mounted) return;
      if (desired) {
        endpointEdited = false;
        previewPairing = '';
      }
      applySnapshot(result);
      // Foreground-service startup is asynchronous. Read its actual state;
      // never synthesize a successful connection with a timer.
      if (desired && !enabled) {
        for (var i = 0; i < 8 && mounted && !enabled; i++) {
          await Future<void>.delayed(const Duration(milliseconds: 250));
          if (!mounted) return;
          applySnapshot(
            await native.invokeMapMethod<dynamic, dynamic>('snapshot'),
          );
        }
      }
    } on PlatformException catch (e) {
      notifyError(e.code);
    } finally {
      if (mounted) {
        setState(() => busy = false);
        unawaited(poll());
      }
    }
  }

  Future<void> permissionSettings(String kind) async {
    try {
      await native.invokeMethod<void>('openPermission', {'kind': kind});
    } on PlatformException catch (e) {
      notifyError(e.code);
    }
  }

  Future<void> installTask() async {
    if (busy ||
        !available ||
        !enabled ||
        !['ready_to_install', 'awaiting_confirmation'].contains(taskCode)) {
      return;
    }
    setState(() {
      busy = true;
      revision++;
    });
    updates.value++;
    try {
      applySnapshot(await native.invokeMapMethod<dynamic, dynamic>('install'));
    } on PlatformException catch (e) {
      notifyError(e.code);
    } finally {
      if (mounted) {
        setState(() => busy = false);
        updates.value++;
        unawaited(poll());
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final overlay = SystemUiOverlayStyle.dark.copyWith(
      statusBarColor: Colors.transparent,
      systemNavigationBarColor: Colors.transparent,
      systemNavigationBarIconBrightness: Brightness.dark,
    );
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: overlay,
      child: Scaffold(
        backgroundColor: bg,
        body: SafeArea(
          child: LayoutBuilder(
            builder: (context, limits) {
              final h = limits.maxHeight;
              final w = math.min(limits.maxWidth - 40, 520.0);
              final artHeight = w * 165 / 230;
              final cardHeight = (h * .139).clamp(108.0, 136.0).toDouble();
              const gap = 18.0;
              final textScale = MediaQuery.textScalerOf(context).scale(1.0);
              final extra = math.max(
                0.0,
                h -
                    (20 +
                        44 +
                        26 +
                        artHeight +
                        16 +
                        82 * textScale +
                        28 +
                        cardHeight * 2 +
                        gap +
                        26),
              );
              return SingleChildScrollView(
                child: Center(
                  child: SizedBox(
                    width: w,
                    child: Padding(
                      padding: const EdgeInsets.only(top: 20, bottom: 26),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          _header(),
                          SizedBox(height: 26 + extra * .38),
                          SizedBox(
                            key: const ValueKey('hero-art'),
                            width: w,
                            height: artHeight,
                            child: CustomPaint(
                              painter: ConnectionPainter(
                                phase,
                                motion,
                                MediaQuery.disableAnimationsOf(context),
                              ),
                            ),
                          ),
                          SizedBox(height: 16 + extra * .12),
                          Semantics(
                            liveRegion: true,
                            child: Text(
                              status,
                              textAlign: TextAlign.center,
                              style: const TextStyle(
                                fontSize: 38,
                                fontWeight: FontWeight.w800,
                                height: 1.18,
                                letterSpacing: -1.5,
                              ),
                            ),
                          ),
                          const SizedBox(height: 9),
                          Text(
                            subtitle,
                            textAlign: TextAlign.center,
                            style: const TextStyle(
                              fontSize: 14,
                              color: muted,
                              height: 1.35,
                            ),
                          ),
                          SizedBox(height: 28 + extra * .42),
                          _accessCard(cardHeight),
                          const SizedBox(height: gap),
                          _taskCard(cardHeight),
                          SizedBox(height: extra * .08),
                        ],
                      ),
                    ),
                  ),
                ),
              );
            },
          ),
        ),
      ),
    );
  }

  Widget _header() => SizedBox(
    height: 44,
    child: Row(
      children: [
        const Text.rich(
          TextSpan(
            text: 'codas',
            style: TextStyle(
              fontSize: 29,
              fontWeight: FontWeight.w900,
              letterSpacing: -1.6,
              color: ink,
            ),
            children: [
              TextSpan(
                text: '.',
                style: TextStyle(color: red),
              ),
            ],
          ),
        ),
        const Spacer(),
        Semantics(
          button: true,
          label: '设置',
          child: GestureDetector(
            onTap: showSettings,
            child: Container(
              width: 44,
              height: 44,
              decoration: const BoxDecoration(
                color: Color(0xffe9e9e5),
                shape: BoxShape.circle,
              ),
              child: const Center(
                child: CustomPaint(
                  size: Size(23, 23),
                  painter: SettingsPainter(),
                ),
              ),
            ),
          ),
        ),
      ],
    ),
  );

  Widget _accessCard(double height) => Container(
    key: const ValueKey('access-card'),
    constraints: BoxConstraints(minHeight: height),
    padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 24),
    decoration: BoxDecoration(
      color: const Color(0xff20211e),
      borderRadius: BorderRadius.circular(23),
    ),
    child: Row(
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              const Text(
                '允许访问',
                style: TextStyle(
                  fontSize: 19,
                  fontWeight: FontWeight.w700,
                  color: Colors.white,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                description,
                style: const TextStyle(
                  fontSize: 13,
                  height: 1.45,
                  color: Color(0xffb3b4ad),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(width: 12),
        Semantics(
          label: '允许 Codas 访问手机',
          toggled: enabled,
          onTap: toggle,
          child: GestureDetector(
            excludeFromSemantics: true,
            onTap: toggle,
            child: SizedBox(
              width: 64,
              height: 48,
              child: Center(
                child: AnimatedContainer(
                  duration: const Duration(milliseconds: 300),
                  width: 61,
                  height: 35,
                  padding: const EdgeInsets.all(4),
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(30),
                    color: enabled ? bg : const Color(0xff50514b),
                  ),
                  child: AnimatedAlign(
                    duration: const Duration(milliseconds: 350),
                    curve: Curves.easeOutBack,
                    alignment: enabled
                        ? Alignment.centerRight
                        : Alignment.centerLeft,
                    child: Container(
                      width: 27,
                      height: 27,
                      decoration: BoxDecoration(
                        color: enabled ? const Color(0xff20211e) : bg,
                        shape: BoxShape.circle,
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ],
    ),
  );

  Widget _taskCard(double height) => Semantics(
    button: true,
    label: '测试应用',
    child: GestureDetector(
      onTap: showTasks,
      child: Container(
        key: const ValueKey('task-card'),
        constraints: BoxConstraints(minHeight: height),
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 24),
        decoration: BoxDecoration(
          color: soft,
          borderRadius: BorderRadius.circular(23),
        ),
        child: Row(
          children: [
            const CustomPaint(size: Size(36, 36), painter: PackagePainter()),
            const SizedBox(width: 16),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Text(
                    '测试应用',
                    style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700),
                  ),
                  const SizedBox(height: 7),
                  Text(
                    taskLabel,
                    style: const TextStyle(fontSize: 13, color: muted),
                  ),
                ],
              ),
            ),
            const Icon(Icons.chevron_right, color: muted, size: 24),
          ],
        ),
      ),
    ),
  );

  Future<void> showSettings() {
    bool expanded = false;
    String? openHelp;
    return _sheet('设置', [
      ValueListenableBuilder<int>(
        valueListenable: updates,
        builder: (context, _, child) => StatefulBuilder(
          builder: (context, refresh) {
            Widget permission(String id, String label, String help) {
              final enabled = state[id] == true;
              final showHelp = openHelp == id;
              return Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 16,
                      vertical: 10,
                    ),
                    child: Row(
                      children: [
                        Expanded(
                          child: Text(
                            label,
                            style: const TextStyle(
                              fontSize: 15,
                              fontWeight: FontWeight.w500,
                            ),
                          ),
                        ),
                        IconButton(
                          key: ValueKey('help-$id'),
                          tooltip: '$label说明',
                          onPressed: () =>
                              refresh(() => openHelp = showHelp ? null : id),
                          icon: Icon(
                            Icons.help_outline,
                            size: 19,
                            color: showHelp ? ink : muted,
                          ),
                        ),
                        Semantics(
                          label: label,
                          toggled: enabled,
                          child: Switch(
                            key: ValueKey('permission-$id'),
                            value: enabled,
                            onChanged: available
                                ? (_) => permissionSettings(id)
                                : null,
                            activeThumbColor: bg,
                            activeTrackColor: ink,
                            inactiveThumbColor: Colors.white,
                            inactiveTrackColor: const Color(0xffc7c8c1),
                            trackOutlineColor: WidgetStateProperty.all(
                              Colors.transparent,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                  AnimatedSize(
                    duration: const Duration(milliseconds: 220),
                    curve: Curves.easeOutCubic,
                    child: showHelp
                        ? Container(
                            width: double.infinity,
                            margin: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                            padding: const EdgeInsets.all(13),
                            decoration: BoxDecoration(
                              color: const Color(0xffe3e4de),
                              borderRadius: BorderRadius.circular(12),
                            ),
                            child: Text(
                              help,
                              style: const TextStyle(
                                fontSize: 13,
                                color: ink,
                                height: 1.6,
                              ),
                            ),
                          )
                        : const SizedBox(width: double.infinity, height: 0),
                  ),
                ],
              );
            }

            return Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                _row('当前设备', device),
                _row('网络连接', status),
                const SizedBox(height: 18),
                Container(
                  decoration: BoxDecoration(
                    color: soft,
                    borderRadius: BorderRadius.circular(20),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      InkWell(
                        key: const ValueKey('connection-config'),
                        borderRadius: BorderRadius.circular(20),
                        onTap: () => refresh(() => expanded = !expanded),
                        child: Padding(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 16,
                            vertical: 17,
                          ),
                          child: Row(
                            children: [
                              const Expanded(
                                child: Text(
                                  '连接配置',
                                  style: TextStyle(
                                    fontSize: 16,
                                    fontWeight: FontWeight.w700,
                                  ),
                                ),
                              ),
                              Text(
                                paired && !endpointEdited ? '已配对' : '待配对',
                                style: const TextStyle(
                                  fontSize: 13,
                                  color: muted,
                                ),
                              ),
                              const SizedBox(width: 10),
                              AnimatedRotation(
                                turns: expanded ? .25 : 0,
                                duration: const Duration(milliseconds: 180),
                                child: const Icon(
                                  Icons.chevron_right,
                                  color: muted,
                                  size: 22,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                      AnimatedSize(
                        duration: const Duration(milliseconds: 250),
                        curve: Curves.easeOutCubic,
                        child: expanded
                            ? Padding(
                                padding: const EdgeInsets.fromLTRB(
                                  16,
                                  0,
                                  16,
                                  18,
                                ),
                                child: Column(
                                  crossAxisAlignment:
                                      CrossAxisAlignment.stretch,
                                  children: [
                                    const Divider(
                                      height: 14,
                                      color: Color(0xffd9dad3),
                                    ),
                                    const SizedBox(height: 8),
                                    const Text(
                                      'Codas 入口',
                                      style: TextStyle(
                                        fontSize: 13,
                                        color: muted,
                                      ),
                                    ),
                                    const SizedBox(height: 8),
                                    TextFormField(
                                      key: const ValueKey('router-input'),
                                      initialValue: previewEndpoint,
                                      enabled: !enabled && available,
                                      onChanged: (value) {
                                        previewEndpoint = value;
                                        endpointEdited = true;
                                      },
                                      keyboardType: TextInputType.url,
                                      autocorrect: false,
                                      decoration: previewField(
                                        'https://router.example.com',
                                      ),
                                    ),
                                    const SizedBox(height: 16),
                                    const Text(
                                      '首次配对码',
                                      style: TextStyle(
                                        fontSize: 13,
                                        color: muted,
                                      ),
                                    ),
                                    const SizedBox(height: 8),
                                    TextFormField(
                                      key: const ValueKey('pairing-input'),
                                      initialValue: previewPairing,
                                      enabled: !enabled && available,
                                      onChanged: (value) =>
                                          previewPairing = value,
                                      obscureText: true,
                                      enableSuggestions: false,
                                      autocorrect: false,
                                      decoration: previewField('已配对可留空'),
                                    ),
                                  ],
                                ),
                              )
                            : const SizedBox(width: double.infinity, height: 0),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 24),
                const Padding(
                  padding: EdgeInsets.only(left: 4, bottom: 10),
                  child: Text(
                    '权限管理',
                    style: TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                      color: muted,
                    ),
                  ),
                ),
                Container(
                  decoration: BoxDecoration(
                    color: soft,
                    borderRadius: BorderRadius.circular(20),
                  ),
                  child: Column(
                    children: [
                      permission(
                        'control',
                        '截图与测试控制',
                        '允许 AI 助手在访问开关开启时截图、启动和操作测试应用。点击开关前往 Android 系统设置授权或关闭。',
                      ),
                      const Divider(
                        height: 1,
                        indent: 16,
                        endIndent: 16,
                        color: Color(0xffd9dad3),
                      ),
                      permission(
                        'install',
                        '安装测试应用',
                        '允许接收测试安装包。每次实际安装都必须由你在 Android 系统界面确认。',
                      ),
                      const Divider(
                        height: 1,
                        indent: 16,
                        endIndent: 16,
                        color: Color(0xffd9dad3),
                      ),
                      permission(
                        'background',
                        '后台连接',
                        '允许 Codas 在锁屏或切到其他应用时维持连接，可能增加耗电。点击开关在 Android 系统设置中调整。',
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 18),
                _row('关于 Codas', version),
                const SizedBox(height: 12),
                ExpansionTile(
                  title: const Text('高级信息', style: TextStyle(fontSize: 14)),
                  tilePadding: EdgeInsets.zero,
                  children: [
                    SelectableText(
                      '手机标识：${state['deviceId'] ?? ''}',
                      style: const TextStyle(fontSize: 12, color: muted),
                    ),
                    SelectableText(
                      nativeStatus,
                      style: const TextStyle(fontSize: 12, color: muted),
                    ),
                    SelectableText(
                      '最近操作：${state['lastAction'] ?? ''}',
                      style: const TextStyle(fontSize: 12, color: muted),
                    ),
                  ],
                ),
              ],
            );
          },
        ),
      ),
    ]);
  }

  InputDecoration previewField(String hint) => InputDecoration(
    hintText: hint,
    hintStyle: const TextStyle(color: muted, fontSize: 13),
    isDense: true,
    filled: true,
    fillColor: bg,
    contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
    border: OutlineInputBorder(
      borderRadius: BorderRadius.circular(12),
      borderSide: BorderSide.none,
    ),
    focusedBorder: OutlineInputBorder(
      borderRadius: BorderRadius.circular(12),
      borderSide: const BorderSide(color: ink),
    ),
  );

  Future<void> showTasks() => _sheet('测试应用', [
    const SizedBox(height: 15),
    Center(
      child: Container(
        width: 64,
        height: 64,
        decoration: BoxDecoration(
          color: const Color(0xffe9e9e3),
          borderRadius: BorderRadius.circular(20),
        ),
        child: const Center(
          child: CustomPaint(size: Size(35, 35), painter: PackagePainter()),
        ),
      ),
    ),
    const SizedBox(height: 17),
    ValueListenableBuilder<int>(
      valueListenable: updates,
      builder: (context, _, child) {
        final empty = taskCode == 'idle';
        final details = [
          task['package'],
          task['version'],
          task['installed_version'],
          friendly(task['error'] as String? ?? ''),
        ].whereType<String>().where((s) => s.isNotEmpty).join('\n');
        final actionable = [
          'ready_to_install',
          'awaiting_confirmation',
        ].contains(taskCode);
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              taskLabel,
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 19, fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 9),
            Text(
              empty ? 'AI 助手发送测试安装包后，\n你可以在这里查看并安装。' : details,
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 14, color: muted, height: 1.7),
            ),
            if (taskCode == 'downloading' || taskCode == 'installing') ...[
              const SizedBox(height: 18),
              const LinearProgressIndicator(color: red, backgroundColor: soft),
            ],
            if (actionable) ...[
              const SizedBox(height: 18),
              FilledButton(
                onPressed: enabled && available && !busy ? installTask : null,
                style: FilledButton.styleFrom(
                  backgroundColor: ink,
                  foregroundColor: bg,
                  minimumSize: const Size.fromHeight(50),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(14),
                  ),
                ),
                child: Text(
                  taskCode == 'awaiting_confirmation' ? '继续系统安装确认' : '安装收到的测试包',
                ),
              ),
            ],
          ],
        );
      },
    ),
    const SizedBox(height: 20),
  ]);

  Widget _row(String label, String value) => Container(
    padding: const EdgeInsets.symmetric(vertical: 17),
    decoration: const BoxDecoration(
      border: Border(bottom: BorderSide(color: Color(0xffdedfd8))),
    ),
    child: Row(
      children: [
        Expanded(child: Text(label, style: const TextStyle(fontSize: 15))),
        Text(value, style: const TextStyle(fontSize: 13, color: muted)),
      ],
    ),
  );

  Future<void> _sheet(String title, List<Widget> children) =>
      showModalBottomSheet<void>(
        context: context,
        backgroundColor: bg,
        barrierColor: Colors.black.withValues(alpha: .4),
        isScrollControlled: true,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(28)),
        ),
        builder: (context) => SafeArea(
          top: false,
          child: ConstrainedBox(
            constraints: BoxConstraints(
              maxHeight: MediaQuery.sizeOf(context).height * .86,
            ),
            child: SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(22, 13, 22, 25),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Center(
                    child: Container(
                      width: 32,
                      height: 4,
                      decoration: BoxDecoration(
                        color: const Color(0xffc8c9c3),
                        borderRadius: BorderRadius.circular(4),
                      ),
                    ),
                  ),
                  const SizedBox(height: 20),
                  Row(
                    children: [
                      Text(
                        title,
                        style: const TextStyle(
                          fontSize: 23,
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                      const Spacer(),
                      IconButton(
                        onPressed: () => Navigator.pop(context),
                        tooltip: '关闭',
                        style: IconButton.styleFrom(
                          backgroundColor: const Color(0xffe7e7e1),
                        ),
                        icon: const Icon(Icons.close, size: 21),
                      ),
                    ],
                  ),
                  const SizedBox(height: 16),
                  ...children,
                ],
              ),
            ),
          ),
        ),
      );
}

class ConnectionPainter extends CustomPainter {
  final LinkPhase phase;
  final AnimationController motion;
  final bool reduceMotion;
  ConnectionPainter(this.phase, this.motion, this.reduceMotion)
    : super(repaint: motion);

  final Paint paintStyle = Paint()..isAntiAlias = true;
  void fill(
    Canvas canvas,
    double x,
    double y,
    double w,
    double h,
    double r,
    Color color,
  ) {
    paintStyle
      ..color = color
      ..style = PaintingStyle.fill
      ..shader = null;
    canvas.drawRRect(
      RRect.fromRectAndRadius(Rect.fromLTWH(x, y, w, h), Radius.circular(r)),
      paintStyle,
    );
  }

  void dots(
    Canvas c,
    Rect rect,
    double radius,
    Color color, {
    double corner = 0,
  }) {
    c.save();
    c.clipRRect(RRect.fromRectAndRadius(rect, Radius.circular(corner)));
    paintStyle
      ..color = color
      ..style = PaintingStyle.fill
      ..shader = null;
    // Reference SVG's grid is globally aligned in 5-unit cells.
    for (
      double x = (rect.left / 5).floor() * 5 + 2.5;
      x <= rect.right + radius;
      x += 5
    ) {
      for (
        double y = (rect.top / 5).floor() * 5 + 2.5;
        y <= rect.bottom + radius;
        y += 5
      ) {
        c.drawCircle(Offset(x, y), radius, paintStyle);
      }
    }
    c.restore();
  }

  double pulse(double t) => (math.cos(t * 2 * math.pi) + 1) / 2;

  @override
  void paint(Canvas canvas, Size size) {
    canvas.save();
    canvas.scale(size.width / 230, size.height / 165);
    dots(
      canvas,
      const Rect.fromLTWH(0, 0, 230, 165),
      1.05,
      Color.alphaBlend(const Color(0xffcccfc9).withValues(alpha: .65), bg),
    );
    final seconds = reduceMotion
        ? 0.0
        : (motion.lastElapsedDuration?.inMicroseconds ?? 0) / 1000000;
    canvas.save();
    if (phase == LinkPhase.off) canvas.translate(-3, 0);
    fill(canvas, 21, 41, 55, 80, 10, bg);
    dots(canvas, const Rect.fromLTWH(25, 45, 47, 72), 1.85, ink, corner: 8);
    fill(canvas, 32, 52, 33, 53, 3, bg);
    dots(canvas, const Rect.fromLTWH(43, 108, 12, 4), 1.85, ink);
    canvas.restore();

    canvas.save();
    if (phase == LinkPhase.off) canvas.translate(5, 0);
    final opacity = switch (phase) {
      LinkPhase.off => .36,
      LinkPhase.connecting =>
        reduceMotion ? .8 : .4 + .6 * pulse(seconds / 1.25),
      LinkPhase.connected => 1.0,
    };
    canvas.saveLayer(
      const Rect.fromLTWH(150, 43, 73, 72),
      Paint()..color = Colors.white.withValues(alpha: opacity),
    );
    fill(canvas, 154, 46, 62, 63, 5, bg);
    dots(canvas, const Rect.fromLTWH(155, 50, 60, 45), 1.85, ink, corner: 5);
    fill(canvas, 162, 57, 46, 30, 1, bg);
    dots(canvas, const Rect.fromLTWH(179, 95, 12, 13), 1.85, ink);
    dots(canvas, const Rect.fromLTWH(170, 105, 30, 7), 1.85, ink, corner: 2);
    canvas.restore();
    canvas.restore();

    for (int i = 0; i < 7; i++) {
      final x = 84.0 + 10 * i;
      final radius = i == 3 ? 3.1 : 2.5;
      final search = pulse((seconds - i * .13) / 1.25);
      final flow = pulse((seconds - i * .16) / 2.2);
      final color = switch (phase) {
        LinkPhase.off => const Color(0xffbec1ba),
        LinkPhase.connecting => Color.lerp(
          const Color(0xffc9cbc4),
          red,
          search,
        )!,
        LinkPhase.connected => red.withValues(alpha: .6 + .4 * flow),
      };
      paintStyle
        ..color = color
        ..style = PaintingStyle.fill
        ..shader = null;
      canvas.drawCircle(
        Offset(x, 80),
        phase == LinkPhase.connected && !reduceMotion
            ? radius + flow * .9
            : radius,
        paintStyle,
      );
    }
    if (phase == LinkPhase.connected && !reduceMotion) {
      final p = (seconds % 3) / 3;
      paintStyle
        ..color = red.withValues(alpha: .38 * (1 - p))
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1;
      canvas.drawCircle(const Offset(114, 80), 6 + p * 15, paintStyle);
    }
    if (phase == LinkPhase.connecting && !reduceMotion) {
      final p = (seconds % 1.5) / 1.5;
      final x = 40 + 120 * p;
      final rect = Rect.fromLTWH(x, 20, 30, 125);
      paintStyle
        ..style = PaintingStyle.fill
        ..shader = LinearGradient(
          colors: [
            red.withValues(alpha: 0),
            red.withValues(alpha: .22 * math.sin(p * math.pi)),
            red.withValues(alpha: 0),
          ],
        ).createShader(rect);
      canvas.drawRect(rect, paintStyle);
      paintStyle.shader = null;
    }
    canvas.restore();
  }

  @override
  bool shouldRepaint(covariant ConnectionPainter oldDelegate) =>
      oldDelegate.phase != phase || oldDelegate.reduceMotion != reduceMotion;
}

class PackagePainter extends CustomPainter {
  const PackagePainter();
  @override
  void paint(Canvas c, Size size) {
    c.save();
    c.scale(size.width / 32, size.height / 32);
    final p = Paint()
      ..color = const Color(0xff262724)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.5
      ..strokeJoin = StrokeJoin.round
      ..strokeCap = StrokeCap.round;
    final path = Path()
      ..moveTo(5, 10)
      ..lineTo(16, 4)
      ..lineTo(27, 10)
      ..lineTo(27, 23)
      ..lineTo(16, 29)
      ..lineTo(5, 23)
      ..close()
      ..moveTo(5, 10)
      ..lineTo(16, 16)
      ..lineTo(27, 10)
      ..moveTo(16, 16)
      ..lineTo(16, 29)
      ..moveTo(10, 7)
      ..lineTo(21, 13)
      ..lineTo(21, 19);
    c.drawPath(path, p);
    c.restore();
  }

  @override
  bool shouldRepaint(covariant PackagePainter oldDelegate) => false;
}

class SettingsPainter extends CustomPainter {
  const SettingsPainter();
  @override
  void paint(Canvas c, Size size) {
    c.save();
    c.scale(size.width / 24, size.height / 24);
    final p = Paint()
      ..color = const Color(0xff222222)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.6
      ..strokeJoin = StrokeJoin.round;
    final path = Path()
      ..moveTo(10, 2)
      ..lineTo(14, 2)
      ..lineTo(14.6, 4.8)
      ..lineTo(16.7, 6)
      ..lineTo(19.4, 5.1)
      ..lineTo(21.4, 8.6)
      ..lineTo(19.3, 10.5)
      ..lineTo(19.3, 13)
      ..lineTo(21.4, 14.9)
      ..lineTo(19.4, 18.4)
      ..lineTo(16.7, 17.5)
      ..lineTo(14.6, 18.7)
      ..lineTo(14, 21.5)
      ..lineTo(10, 21.5)
      ..lineTo(9.4, 18.7)
      ..lineTo(7.3, 17.5)
      ..lineTo(4.6, 18.4)
      ..lineTo(2.6, 14.9)
      ..lineTo(4.7, 13)
      ..lineTo(4.7, 10.5)
      ..lineTo(2.6, 8.6)
      ..lineTo(4.6, 5.1)
      ..lineTo(7.3, 6)
      ..lineTo(9.4, 4.8)
      ..close();
    c.drawPath(path, p);
    c.drawCircle(const Offset(12, 12), 3, p);
    c.restore();
  }

  @override
  bool shouldRepaint(covariant SettingsPainter oldDelegate) => false;
}
