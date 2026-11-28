import 'package:codas_mobile/agent_network.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('validates and canonicalizes only HTTPS DNS origins', () {
    expect(validateCoordinatorOrigin(' HTTPS://CORE.EXAMPLE.TEST:443/ '),
        'https://core.example.test');
    expect(validateCoordinatorOrigin('https://other.example.test'),
        'https://other.example.test');
    for (final invalid in [
      '', 'http://core.example.test', 'https://core.example.test/path',
      'https://core.example.test:8443', 'https://127.0.0.1',
      'https://localhost', 'https://user@core.example.test',
      'https://core..example.test', 'https://core.example.test?secret=x',
      'https://core.example.test#fragment', r'https://core.example.test\evil',
    ]) {
      expect(() => validateCoordinatorOrigin(invalid), throwsStateError);
    }
  });
  test(
    'environment proxy takes priority and preserves local bypasses',
    () async {
      final result = await resolveAgentProxy(
        environment: {
          'https_proxy': 'http://proxy.example.test:8080',
          'no_proxy': 'internal.example.test',
        },
        systemProxy: () async => throw StateError('system lookup must not run'),
      );
      expect(result.source, 'environment');
      expect(
        result.environment['NO_PROXY']!.split(','),
        containsAll(['localhost', '127.0.0.1', '::1', 'internal.example.test']),
      );
      expect(result.environment.containsKey('HTTPS_PROXY'), isFalse);
    },
  );
  test('system-selected proxy is inherited only by the Agent child', () async {
    final result = await resolveAgentProxy(
      environment: {},
      systemProxy: () async => 'http://proxy.example.test:8080/',
    );
    expect(result.source, 'system');
    expect(
      result.environment['HTTPS_PROXY'],
      'http://proxy.example.test:8080/',
    );
    expect(result.environment['NO_PROXY'], contains('127.0.0.1'));
  });
  test(
    'a system bypass returns direct; failed or invalid lookup fails closed',
    () async {
      final direct = await resolveAgentProxy(
        environment: {},
        systemProxy: () async => null,
      );
      expect(direct.source, 'direct');
      expect(direct.environment.containsKey('HTTPS_PROXY'), isFalse);
      for (final invalid in [
        'file:///tmp/abc',
        'http://user:secret@proxy.example.test',
        'http://proxy.example.test/path',
      ]) {
        await expectLater(
          resolveAgentProxy(environment: {}, systemProxy: () async => invalid),
          throwsStateError,
        );
      }
      await expectLater(
        resolveAgentProxy(
          environment: {},
          systemProxy: () async => throw StateError('unverified'),
        ),
        throwsStateError,
      );
    },
  );
}
