import 'package:codas_mobile/main.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  final calls = <MethodCall>[];
  late Map<String, dynamic> snapshot;
  const channel = MethodChannel('codas/native');
  setUp(() {
    calls.clear();
    snapshot = {
      'enabled': false,
      'connected': false,
      'status': '访问已关闭',
      'device': 'RedMagic',
      'endpoint': 'https://router.example.com',
      'paired': true,
      'version': '0.1.0-wireless-preview.9',
      'control': true,
      'install': true,
      'background': true,
      'task': {'status': 'idle'},
    };
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          calls.add(call);
          if (call.method == 'setAccess') {
            final on = (call.arguments as Map)['enabled'] == true;
            snapshot = {
              ...snapshot,
              'enabled': on,
              'connected': false,
              'status': on ? '连接中 · 建立安全连接' : '访问已关闭',
            };
          }
          return call.method == 'openPermission' ? null : snapshot;
        });
  });
  tearDown(
    () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null),
  );

  Future<void> mount(WidgetTester tester) async {
    tester.view.physicalSize = const Size(1216, 2688);
    tester.view.devicePixelRatio = 442 / 160;
    tester.view.padding = const FakeViewPadding(top: 85, bottom: 62);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetPadding);
    await tester.pumpWidget(const CodasPreview());
    await tester.pump();
  }

  Future<void> disposeApp(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();
  }

  testWidgets(
    'Approved layout and real connection state, never timer-simulated success',
    (tester) async {
      await mount(tester);
      final art = tester.getRect(find.byKey(const ValueKey('hero-art')));
      final access = tester.getRect(find.byKey(const ValueKey('access-card')));
      final task = tester.getRect(find.byKey(const ValueKey('task-card')));
      expect(art.width, closeTo(access.width, .01));
      expect(task.width, closeTo(access.width, .01));
      expect(access.height, greaterThanOrEqualTo(108));
      expect(task.height, greaterThanOrEqualTo(108));
      expect(task.top - access.bottom, closeTo(18, .01));
      expect(find.text('未连接'), findsOneWidget);
      await tester.tap(find.bySemanticsLabel('允许 Codas 访问手机'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      expect(
        calls.any(
          (c) =>
              c.method == 'setAccess' &&
              (c.arguments as Map)['enabled'] == true,
        ),
        isTrue,
      );
      expect(find.text('连接中'), findsOneWidget);
      await tester.pump(const Duration(seconds: 3));
      expect(find.text('已连接'), findsNothing);
      snapshot = {...snapshot, 'connected': true, 'status': '已连接 · 后台访问开启'};
      await tester.pump(const Duration(seconds: 1));
      await tester.pump();
      expect(find.text('已连接'), findsOneWidget);
      snapshot = {
        ...snapshot,
        'connected': false,
        'status': '网络中断，自动重连：NETWORK_TIMEOUT',
      };
      await tester.pump(const Duration(seconds: 1));
      await tester.pump();
      expect(find.text('正在重连'), findsOneWidget);
      await tester.tap(find.bySemanticsLabel('允许 Codas 访问手机'));
      await tester.pump();
      expect(find.text('未连接'), findsOneWidget);
      await disposeApp(tester);
    },
  );

  testWidgets(
    'Permission switches launch settings, no optimistic authorization',
    (tester) async {
      await mount(tester);
      await tester.tap(
        find.byWidgetPredicate(
          (w) => w is CustomPaint && w.painter is SettingsPainter,
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('router-input')), findsNothing);
      expect(find.byKey(const ValueKey('pairing-input')), findsNothing);
      final permission = find.byKey(const ValueKey('permission-control'));
      expect(tester.widget<Switch>(permission).value, isTrue);
      await tester.tap(permission);
      await tester.pumpAndSettle();
      expect(
        calls.any(
          (c) =>
              c.method == 'openPermission' &&
              (c.arguments as Map)['kind'] == 'control',
        ),
        isTrue,
      );
      expect(tester.widget<Switch>(permission).value, isTrue);
      snapshot = {...snapshot, 'control': false};
      await tester.pump(const Duration(seconds: 1));
      await tester.pump();
      expect(tester.widget<Switch>(permission).value, isFalse);
      await tester.tap(find.byKey(const ValueKey('help-control')));
      await tester.pumpAndSettle();
      expect(find.textContaining('允许 AI 助手在访问开关开启时'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('connection-config')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('router-input')), findsOneWidget);
      expect(find.byKey(const ValueKey('pairing-input')), findsOneWidget);
      await disposeApp(tester);
    },
  );

  testWidgets('APK task uses live snapshot and original install action', (
    tester,
  ) async {
    snapshot = {
      ...snapshot,
      'enabled': true,
      'connected': true,
      'task': {
        'status': 'ready_to_install',
        'package': 'com.example.fixture',
        'version': '1.0',
      },
    };
    await mount(tester);
    expect(find.text('已下载 · 等待安装'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('task-card')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
    await tester.ensureVisible(find.text('安装收到的测试包'));
    await tester.pump();
    expect(find.text('安装收到的测试包'), findsOneWidget);
    await tester.tap(find.text('安装收到的测试包'));
    await tester.pump();
    expect(calls.any((c) => c.method == 'install'), isTrue);
    snapshot = {
      ...snapshot,
      'task': {'status': 'awaiting_confirmation'},
    };
    await tester.pump(const Duration(seconds: 1));
    await tester.pump();
    expect(find.text('继续系统安装确认'), findsOneWidget);
    await disposeApp(tester);
  });
}
