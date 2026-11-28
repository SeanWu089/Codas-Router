import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:codas_mobile/windows_main.dart';

void main() {
  test('health parsing fails closed', () {
    expect(
      parseHealth('{"ok":true,"backendReachable":true}'),
      LocalHealth.ready,
    );
    expect(
      parseHealth('{"ok":true,"backendReachable":false}'),
      LocalHealth.routerOnly,
    );
    for (final invalid in [
      '{}',
      '{"ok":true}',
      '{"ok":false,"backendReachable":true}',
      'null',
      '[]',
      'not json',
    ]) {
      expect(parseHealth(invalid), LocalHealth.unavailable);
    }
  });

  testWidgets('local health UI does not claim remote readiness', (
    tester,
  ) async {
    await tester.pumpWidget(CodasDesktop(probe: () async => LocalHealth.ready));
    await tester.pump();
    expect(find.text('本地服务正常'), findsOneWidget);
    expect(find.text('SSE 会话未验证'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('unavailable local probe is not a remote disconnect', (
    tester,
  ) async {
    await tester.pumpWidget(
      CodasDesktop(probe: () async => LocalHealth.unavailable),
    );
    await tester.pump();
    expect(find.text('未检测到本机 Router（非必需）'), findsOneWidget);
    expect(find.text('SSE 会话未验证'), findsOneWidget);
    expect(find.text('本地服务不可用'), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });
}
