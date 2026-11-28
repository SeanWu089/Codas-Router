import 'package:codas_mobile/agent_desktop.dart';
import 'package:codas_mobile/core_device_info.dart';
import 'package:codas_mobile/device_painter.dart' as art;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

class TestModel extends AgentModel {
  TestModel() : super(loadLocalProfile: false);
  bool running = false;
  bool approved = false;
  bool stopFails = false;
  int stopCount = 0;
  @override
  bool get enabled => running;
  @override
  bool get connected => running && phase == 'connected';

  @override
  Future<void> start({
    required String origin,
    required String root,
    required String pairing,
  }) async {
    running = true;
    endpoint = origin;
    workspace = root;
    phase = 'connecting';
    changed();
  }

  @override
  Future<void> stop() async {
    stopCount++;
    if (stopFails) {
      phase = 'stop_failed';
      error = 'STOP_NOT_VERIFIED';
      changed();
      return;
    }
    running = false;
    phase = 'off';
    approval = null;
    changed();
  }

  @override
  void decide(bool allow) {
    approved = allow && connected;
    approval = null;
    changed();
  }
}

void main() {
  testWidgets('fresh launch is off and does not auto-connect', (tester) async {
    final m = TestModel();
    await tester.pumpWidget(AgentDesktop(model: m));
    expect(find.text('未连接'), findsOneWidget);
    expect(m.enabled, isFalse);
    expect(m.endpoint, isEmpty);
    await tester.pumpWidget(const SizedBox());
    m.dispose();
  });

  testWidgets('first-time Core address is empty and editable', (tester) async {
    final m = TestModel();
    await tester.pumpWidget(AgentDesktop(model: m));
    await tester.tap(find.byTooltip('设置'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('连接配置'));
    await tester.pumpAndSettle();
    final field = find.byKey(const ValueKey('endpoint-field'));
    expect(tester.widget<TextField>(field).enabled, isTrue);
    expect(tester.widget<TextField>(field).controller!.text, isEmpty);
    await tester.enterText(field, 'https://other.example.test');
    expect(tester.widget<TextField>(field).controller!.text,
      'https://other.example.test');
    await tester.pumpWidget(const SizedBox());
    m.dispose();
  });

  testWidgets('connection and local confirmation states follow the worker', (
    tester,
  ) async {
    final m = TestModel();
    m.running = true;
    m.phase = 'connecting';
    await tester.pumpWidget(AgentDesktop(model: m));
    expect(find.text('正在连接'), findsOneWidget);
    m.receive({'type': 'state', 'value': 'connected'});
    await tester.pump();
    expect(find.text('已连接'), findsOneWidget);
    m.receive({
      'type': 'confirmation',
      'id': 'one',
      'name': 'open_workspace',
      'description': 'Local approval test fixture',
      'timeoutSeconds': 20,
    });
    await tester.pump();
    expect(find.text('有一项任务待确认'), findsOneWidget);
    await tester.tap(find.text('有一项任务待确认'));
    await tester.pump();
    expect(find.text('任务确认 · 20 秒内'), findsOneWidget);
    expect(find.text('允许本次'), findsOneWidget);
    m.receive({'type': 'state', 'value': 'reconnecting'});
    await tester.pump();
    await tester.tap(find.byTooltip('返回'));
    await tester.pump();
    expect(find.text('正在重连'), findsOneWidget);
    expect(find.text('允许本次'), findsNothing);
    await m.stop();
    await tester.pump();
    expect(find.text('未连接'), findsOneWidget);
    expect(m.enabled, isFalse);
    await tester.pumpWidget(const SizedBox());
    m.dispose();
  });

  testWidgets('local enable explicitly grants a foreground session', (
    tester,
  ) async {
    final m = TestModel();
    m.paired = true;
    m.endpoint = 'https://core.example.test';
    m.workspace = r'C:\Users\Fixture\Desktop';
    await tester.pumpWidget(AgentDesktop(model: m));
    expect(m.enabled, isFalse);
    await tester.tap(find.text('允许访问'));
    await tester.pumpAndSettle();
    expect(find.text('开启本机远程访问？'), findsOneWidget);
    expect(find.textContaining('脚本使用当前 Windows 账户权限'), findsOneWidget);
    expect(m.enabled, isFalse);
    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();
    expect(m.enabled, isFalse);
    await tester.tap(find.text('允许访问'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('确认开启'));
    await tester.pump(const Duration(milliseconds: 400));
    expect(m.enabled, isTrue);
    m.receive({'type': 'state', 'value': 'connected'});
    await tester.pump();
    expect(find.text('AI 助手可操作此设备'), findsOneWidget);
    expect(find.text('允许本次'), findsNothing);
    await tester.tap(find.byTooltip('设置'));
    await tester.pump();
    await tester.tap(find.text('会话授权'));
    await tester.pump();
    expect(find.text('已验证的 SSE 会话 · 本次访问已授权'), findsOneWidget);
    await tester.tap(find.byTooltip('返回'));
    await tester.pump();
    await tester.tap(find.byTooltip('返回'));
    await tester.pump();
    await m.stop();
    await tester.pump();
    expect(m.enabled, isFalse);
    await tester.pumpWidget(const SizedBox());
    m.dispose();
  });

  test('failure does not create a connected state', () {
    final m = TestModel();
    m.receive({'type': 'error', 'code': 'APPROVED_BACKEND_UNAVAILABLE'});
    expect(m.enabled, isFalse);
    expect(m.connected, isFalse);
    expect(m.error, 'APPROVED_BACKEND_UNAVAILABLE');
    m.dispose();
  });
  test('public and backend diagnostics never imply authenticated SSE', () {
    final m = TestModel();
    m.receive({'type': 'diagnostic', 'layer': 'public', 'value': 'reachable'});
    m.receive({'type': 'diagnostic', 'layer': 'backend', 'value': 'reachable'});
    expect(m.publicStatus, 'reachable');
    expect(m.backendStatus, 'reachable');
    expect(m.connected, isFalse);
    m.dispose();
  });
  testWidgets('compact UI uses the approved logo and real model settings', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(360, 600));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final m = TestModel();
    m.paired = true;
    m.endpoint = 'https://core.example.test';
    m.workspace = r'C:\Users\Fixture\Desktop';
    await tester.pumpWidget(AgentDesktop(model: m));
    final logo = tester.widget<Text>(
      find.byWidgetPredicate(
        (w) => w is Text && w.textSpan?.toPlainText() == 'codas.',
      ),
    );
    expect(logo.textSpan?.style?.fontFamily, 'CodasLogo');
    expect(logo.textSpan?.style?.fontWeight, FontWeight.w900);
    expect(find.text('连接诊断'), findsNothing);
    expect(
      tester.getSize(find.byKey(const ValueKey('allow-access'))).height,
      96,
    );
    await tester.tap(find.byTooltip('设置'));
    await tester.pump();
    await tester.tap(find.text('连接配置'));
    await tester.pump();
    expect(find.byKey(const ValueKey('pairing-field')), findsNothing);
    expect(
      tester
          .widget<TextField>(find.byKey(const ValueKey('workspace-field')))
          .enabled,
      isFalse,
    );
    expect(m.enabled, isFalse);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    m.dispose();
  });
  testWidgets('explicit exit stops access before native window destruction', (
    tester,
  ) async {
    final m = TestModel()
      ..running = true
      ..phase = 'connected';
    const channel = MethodChannel('codas/windows/tray/test');
    final calls = <String>[];
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(channel, (call) async {
      calls.add(call.method);
      if (call.method == 'exitApproved') expect(m.enabled, isFalse);
      return null;
    });
    addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
    await tester.pumpWidget(AgentDesktop(model: m, trayChannel: channel));
    await tester.tap(find.byTooltip('设置'));
    await tester.pump();
    await tester.tap(find.text('关于 Codas'));
    await tester.pump();
    await tester.tap(find.text('退出 Codas'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 350));
    expect(m.enabled, isTrue);
    await tester.tap(find.text('取消'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 350));
    expect(m.stopCount, 0);
    expect(calls, isNot(contains('exitApproved')));
    await tester.tap(find.text('退出 Codas'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 350));
    await tester.tap(find.text('退出并停止访问'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 350));
    expect(m.stopCount, 1);
    expect(m.enabled, isFalse);
    expect(calls.where((v) => v == 'exitApproved'), hasLength(1));
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    m.dispose();
  });

  testWidgets('failed shutdown does not approve native exit', (tester) async {
    final m = TestModel()
      ..running = true
      ..phase = 'connected'
      ..stopFails = true;
    const channel = MethodChannel('codas/windows/tray/test');
    final calls = <String>[];
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(channel, (call) async {
      calls.add(call.method);
      return null;
    });
    addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
    await tester.pumpWidget(AgentDesktop(model: m, trayChannel: channel));
    await tester.tap(find.byTooltip('设置'));
    await tester.pump();
    await tester.tap(find.text('关于 Codas'));
    await tester.pump();
    await tester.tap(find.text('退出 Codas'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 350));
    await tester.tap(find.text('退出并停止访问'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 350));
    expect(m.enabled, isTrue);
    expect(m.phase, 'stop_failed');
    expect(calls, isNot(contains('exitApproved')));
    expect(find.text('关闭未确认'), findsNWidgets(2));
    expect(find.textContaining('尚未确认访问组件退出'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    m.dispose();
  });
  test('Core display mapping is explicit and does not guess from names', () {
    Map<String, dynamic> info(String platform, String formFactor) => {
      'version': 1,
      'name': 'Fixture Mac',
      'platform': platform,
      'formFactor': formFactor,
    };
    expect(
      CoreDisplayDevice.parse(info('darwin', 'laptop'))?.kind,
      art.DeviceKind.macBook,
    );
    expect(
      CoreDisplayDevice.parse(info('win32', 'desktop'))?.kind,
      art.DeviceKind.pc,
    );
    expect(
      CoreDisplayDevice.parse(info('android', 'phone'))?.kind,
      art.DeviceKind.android,
    );
    expect(
      CoreDisplayDevice.parse(info('ios', 'phone'))?.kind,
      art.DeviceKind.iPhone,
    );
    expect(
      CoreDisplayDevice.parse(info('darwin', 'unknown'))?.kind,
      art.DeviceKind.unknown,
    );
    expect(
      CoreDisplayDevice.parse(info('darwin', 'desktop'))?.kind,
      art.DeviceKind.unknown,
    );
    expect(
      CoreDisplayDevice.parse({
        ...info('darwin', 'laptop'),
        'name': '\ninvalid',
      }),
      isNull,
    );
    expect(
      CoreDisplayDevice.parse({...info('win32', 'desktop'), 'version': 2}),
      isNull,
    );
    expect(CoreDisplayDevice.parse(null), isNull);
  });

  testWidgets('Core metadata follows current connected session only', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(360, 600));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final m = TestModel()
      ..running = true
      ..phase = 'connecting';
    await tester.pumpWidget(AgentDesktop(model: m));
    art.DeviceKind kind() => tester
        .widgetList<CustomPaint>(find.byType(CustomPaint))
        .map((w) => w.painter)
        .whereType<art.DeviceConnectionPainter>()
        .single
        .core;
    expect(kind(), art.DeviceKind.unknown);
    final mac = {
      'version': 1,
      'name': 'Fixture Mac',
      'platform': 'darwin',
      'formFactor': 'laptop',
    };
    m.receive({
      'type': 'diagnostic',
      'layer': 'public',
      'value': 'reachable',
      'coreDevice': mac,
    });
    await tester.pump();
    expect(kind(), art.DeviceKind.unknown);
    m.receive({'type': 'state', 'value': 'connected', 'coreDevice': mac});
    await tester.pump();
    expect(kind(), art.DeviceKind.macBook);
    expect(find.textContaining(' · Fixture Mac'), findsOneWidget);
    m.receive({'type': 'state', 'value': 'reconnecting'});
    await tester.pump();
    expect(kind(), art.DeviceKind.unknown);
    expect(find.textContaining(' · Fixture Mac'), findsNothing);
    m.receive({
      'type': 'state',
      'value': 'connected',
      'coreDevice': {
        'version': 1,
        'name': 'Fixture PC',
        'platform': 'win32',
        'formFactor': 'desktop',
      },
    });
    await tester.pump();
    expect(kind(), art.DeviceKind.pc);
    expect(find.textContaining(' · Fixture PC'), findsOneWidget);
    m.receive({'type': 'state', 'value': 'connected'});
    await tester.pump();
    expect(kind(), art.DeviceKind.unknown);
    expect(m.connected, isTrue);
    m.receive({'type': 'state', 'value': 'connected', 'coreDevice': mac});
    await tester.pump();
    m.receive({'type': 'error', 'code': 'SSE_AUTH_REJECTED'});
    await tester.pump();
    expect(kind(), art.DeviceKind.unknown);
    expect(m.coreDevice, isNull);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    m.dispose();
  });
}
