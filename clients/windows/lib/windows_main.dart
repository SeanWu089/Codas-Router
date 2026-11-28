import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';

import 'main.dart' as shared;

enum LocalHealth { checking, unavailable, routerOnly, ready }

Future<LocalHealth> probeLocalHealth() async {
  final client = HttpClient()..connectionTimeout = const Duration(seconds: 2);
  client.findProxy = (_) => 'DIRECT';
  try {
    final request = await client
        .getUrl(Uri.parse('http://127.0.0.1:17676/_codassol/health'))
        .timeout(const Duration(seconds: 2));
    request.followRedirects = false;
    final response = await request.close().timeout(const Duration(seconds: 3));
    if (response.statusCode != 200) return LocalHealth.unavailable;
    final bytes = <int>[];
    await for (final chunk in response.timeout(const Duration(seconds: 2))) {
      if (bytes.length + chunk.length > 4096) return LocalHealth.unavailable;
      bytes.addAll(chunk);
    }
    return parseHealth(utf8.decode(bytes));
  } catch (_) {
    return LocalHealth.unavailable;
  } finally {
    client.close(force: true);
  }
}

LocalHealth parseHealth(String payload) {
  try {
    final result = jsonDecode(payload);
    if (result is! Map || result['ok'] != true) return LocalHealth.unavailable;
    if (result['backendReachable'] == true) return LocalHealth.ready;
    if (result['backendReachable'] == false) return LocalHealth.routerOnly;
  } catch (_) {
    // Unknown or invalid responses must not produce a healthy indicator.
  }
  return LocalHealth.unavailable;
}

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const CodasDesktop());
}

class CodasDesktop extends StatelessWidget {
  const CodasDesktop({super.key, this.probe = probeLocalHealth});
  final Future<LocalHealth> Function() probe;

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'Codas for Windows',
    debugShowCheckedModeBanner: false,
    theme: ThemeData(
      useMaterial3: true,
      colorScheme: ColorScheme.fromSeed(
        seedColor: shared.ink,
        surface: shared.bg,
      ),
      scaffoldBackgroundColor: shared.bg,
      textTheme: ThemeData.light().textTheme.apply(
        bodyColor: shared.ink,
        displayColor: shared.ink,
      ),
    ),
    home: DesktopStatus(probe: probe),
  );
}

class DesktopStatus extends StatefulWidget {
  const DesktopStatus({super.key, required this.probe});
  final Future<LocalHealth> Function() probe;

  @override
  State<DesktopStatus> createState() => _DesktopStatusState();
}

class _DesktopStatusState extends State<DesktopStatus>
    with SingleTickerProviderStateMixin {
  LocalHealth health = LocalHealth.checking;
  bool autoRefresh = true;
  bool busy = false;
  DateTime? checked;
  Timer? timer;
  late final AnimationController motion;

  @override
  void initState() {
    super.initState();
    motion = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 30),
    );
    refresh();
    timer = Timer.periodic(const Duration(seconds: 5), (_) {
      if (autoRefresh) refresh();
    });
  }

  Future<void> refresh() async {
    if (busy || !mounted) return;
    setState(() => busy = true);
    LocalHealth result;
    try {
      result = await widget.probe().timeout(const Duration(seconds: 8));
    } catch (_) {
      result = LocalHealth.unavailable;
    }
    if (!mounted) return;
    setState(() {
      health = result;
      checked = DateTime.now();
      busy = false;
    });
    // Local loopback health is not proof of a coordinator session.
    motion.stop();
    motion.reset();
  }

  @override
  void dispose() {
    timer?.cancel();
    motion.dispose();
    super.dispose();
  }

  String get localDetail => switch (health) {
    LocalHealth.checking => '正在检查本机诊断接口',
    LocalHealth.unavailable => '未检测到本机 Router（非必需）',
    LocalHealth.routerOnly => '本机 Router 正常，后端未就绪',
    LocalHealth.ready => '本地服务正常',
  };

  @override
  Widget build(BuildContext context) {
    final ready = health == LocalHealth.ready;
    final routerReady = ready || health == LocalHealth.routerOnly;
    // No authorized SSE session-status source is integrated in this preview.
    // Neither a successful nor failed local probe establishes remote status.
    const phase = shared.LinkPhase.off;
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(28),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 520),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Row(
                    children: [
                      const Text.rich(
                        TextSpan(
                          text: 'codas',
                          style: TextStyle(
                            fontSize: 32,
                            fontWeight: FontWeight.w900,
                            letterSpacing: -1.5,
                          ),
                          children: [
                            TextSpan(
                              text: '.',
                              style: TextStyle(color: shared.red),
                            ),
                          ],
                        ),
                      ),
                      const Spacer(),
                      const Text(
                        'WINDOWS  /  PREVIEW 02',
                        style: TextStyle(
                          fontSize: 11,
                          color: shared.muted,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      IconButton(
                        tooltip: '关于',
                        icon: const Icon(Icons.settings_outlined),
                        onPressed: () {
                          showAboutDialog(
                            context: context,
                            applicationName: 'Codas for Windows',
                            applicationVersion: '0.1.1 Desktop Preview',
                            children: const [
                              Text(
                                'SSE-first 只读预览版。尚未接入授权的 SSE 会话状态源；不提供远程执行、配对或安全策略修改。',
                              ),
                            ],
                          );
                        },
                      ),
                    ],
                  ),
                  const SizedBox(height: 22),
                  AspectRatio(
                    aspectRatio: 230 / 165,
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(20),
                      child: CustomPaint(
                        painter: shared.ConnectionPainter(
                          phase,
                          motion,
                          MediaQuery.disableAnimationsOf(context),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 20),
                  const Text(
                    'SSE 会话未验证',
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      fontSize: 32,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  const SizedBox(height: 8),
                  const Text(
                    '尚未接入授权的 SSE 会话状态源，不能据本机诊断判断跨设备是否在线。',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: shared.muted, fontSize: 13),
                  ),
                  const SizedBox(height: 26),
                  const Text(
                    '本机诊断 · 非必需',
                    style: TextStyle(
                      color: shared.muted,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 10),
                  Text(localDetail),
                  const SizedBox(height: 10),
                  _statusCard('本地 Router', '127.0.0.1:17676', routerReady),
                  const SizedBox(height: 12),
                  _statusCard('本机后端', '仅反映本地诊断接口', ready),
                  const SizedBox(height: 18),
                  SwitchListTile.adaptive(
                    title: const Text('自动刷新本机诊断'),
                    subtitle: const Text('仅刷新本机诊断，不建立或改变 SSE 会话。'),
                    value: autoRefresh,
                    onChanged: (value) => setState(() => autoRefresh = value),
                  ),
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          checked == null
                              ? '尚未完成检测'
                              : '最近检测  ${TimeOfDay.fromDateTime(checked!).format(context)}',
                          style: const TextStyle(
                            color: shared.muted,
                            fontSize: 12,
                          ),
                        ),
                      ),
                      FilledButton.tonalIcon(
                        onPressed: busy ? null : refresh,
                        icon: const Icon(Icons.refresh),
                        label: Text(busy ? '检测中' : '立即刷新'),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  const Text(
                    'Desktop Preview · 只读管理端',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: shared.muted, fontSize: 11),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _statusCard(String label, String detail, bool ok) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 18),
    decoration: BoxDecoration(
      color: shared.soft,
      borderRadius: BorderRadius.circular(20),
    ),
    child: Row(
      children: [
        Icon(
          ok ? Icons.check_circle_outline : Icons.radio_button_unchecked,
          color: ok ? const Color(0xff3c8064) : shared.muted,
        ),
        const SizedBox(width: 14),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                label,
                style: const TextStyle(
                  fontWeight: FontWeight.w700,
                  fontSize: 16,
                ),
              ),
              const SizedBox(height: 4),
              Text(
                detail,
                style: const TextStyle(color: shared.muted, fontSize: 12),
              ),
            ],
          ),
        ),
        Text(
          health == LocalHealth.checking
              ? '检测中'
              : ok
              ? '正常'
              : '未检测到',
          style: TextStyle(color: ok ? const Color(0xff3c8064) : shared.muted),
        ),
      ],
    ),
  );
}
