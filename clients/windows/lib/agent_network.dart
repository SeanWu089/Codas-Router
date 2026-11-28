import 'dart:async';
import 'dart:convert';
import 'dart:io';

// Validate the user-selected HTTPS origin before proxy lookup or worker launch.
String validateCoordinatorOrigin(String value) {
  final raw = value.trim();
  final match = RegExp(
    r'^https://([A-Za-z0-9.-]+)(?::443)?/?$',
    caseSensitive: false,
  ).firstMatch(raw);
  if (match == null || match.end != raw.length) {
    throw StateError('HTTPS_ORIGIN_REQUIRED');
  }
  final host = match.group(1)!.toLowerCase();
  final labels = host.split('.');
  if (host.length > 253 || labels.length < 2 ||
      !RegExp(r'^[a-z][a-z0-9-]*$').hasMatch(labels.last) ||
      labels.any((label) => label.length > 63 ||
          !RegExp(r'^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$').hasMatch(label))) {
    throw StateError('HTTPS_ORIGIN_REQUIRED');
  }
  return 'https://$host';
}

class AgentProxyLaunch {
  const AgentProxyLaunch(this.source, this.environment);
  final String source;
  final Map<String, String> environment;
}

Future<AgentProxyLaunch> resolveAgentProxy({
  required Map<String, String> environment,
  required Future<String?> Function() systemProxy,
}) async {
  String? env(String name) {
    for (final e in environment.entries) {
      if (e.key.toLowerCase() == name.toLowerCase()) return e.value;
    }
    return null;
  }

  // The Agent also calls DevSpace on loopback. Never send its local credentials
  // through a proxy. Preserve other user-provided proxy exclusions.
  final exclusions = <String>{
    ...?env('NO_PROXY')
        ?.split(',')
        .map((s) => s.trim())
        .where((s) => s.isNotEmpty),
    'localhost',
    '127.0.0.1',
    '::1',
  };
  final overrides = {'NO_PROXY': exclusions.join(',')};
  if ([
    env('HTTPS_PROXY'),
    env('HTTP_PROXY'),
  ].any((value) => value != null && value.trim().isNotEmpty)) {
    return AgentProxyLaunch('environment', overrides);
  }
  final proxy = await systemProxy();
  if (proxy == null) return AgentProxyLaunch('direct', overrides);
  final uri = Uri.tryParse(proxy);
  if (uri == null ||
      !['http', 'https'].contains(uri.scheme) ||
      uri.host.isEmpty ||
      uri.userInfo.isNotEmpty ||
      uri.hasQuery ||
      uri.hasFragment ||
      !['', '/'].contains(uri.path)) {
    throw StateError('SYSTEM_PROXY_UNVERIFIED');
  }
  overrides['HTTPS_PROXY'] = uri.toString();
  return AgentProxyLaunch('system', overrides);
}

// Query the operating system's current-user proxy resolver. This respects its
// chosen route and does not edit registry, proxy, execution or security policy.
// Do not silently ignore a resolver failure and assume direct access.
Future<String?> windowsSystemProxy(String origin) async {
  final coordinatorOrigin = validateCoordinatorOrigin(origin);
  final root = Platform.environment['SystemRoot'];
  if (!Platform.isWindows || root == null || root.isEmpty) {
    throw StateError('SYSTEM_PROXY_UNVERIFIED');
  }
  final executable = '$root\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  final script =
      r"$ErrorActionPreference='Stop'; $u=[Uri]"
      "'$coordinatorOrigin';"
      r"$p=[System.Net.WebRequest]::GetSystemWebProxy().GetProxy($u); if ($null -eq $p -or $p.AbsoluteUri -eq $u.AbsoluteUri) { 'DIRECT' } else { $p.AbsoluteUri }";
  Process? process;
  try {
    final child = await Process.start(executable, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script,
    ], runInShell: false);
    process = child;
    final output = child.stdout.transform(utf8.decoder).join();
    final discard = child.stderr.drain<void>();
    final code = await child.exitCode.timeout(const Duration(seconds: 6));
    final value = (await output).trim();
    await discard;
    if (code != 0 || value.isEmpty) throw StateError('SYSTEM_PROXY_UNVERIFIED');
    return value == 'DIRECT' ? null : value;
  } catch (_) {
    process?.kill();
    throw StateError('SYSTEM_PROXY_UNVERIFIED');
  }
}
