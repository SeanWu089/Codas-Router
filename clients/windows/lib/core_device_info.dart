import 'device_painter.dart';

/// Display metadata is never a routing identity or permission grant.
class CoreDisplayDevice {
  const CoreDisplayDevice(this.name, this.platform, this.formFactor);
  final String name;
  final String platform;
  final String formFactor;

  static final _forbidden = RegExp(
    r'[\x00-\x1f\x7f-\x9f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]',
    unicode: true,
  );
  static CoreDisplayDevice? parse(Object? raw) {
    if (raw is! Map || raw['version'] != 1) return null;
    final name = raw['name'];
    final platform = raw['platform'];
    final form = raw.containsKey('formFactor') ? raw['formFactor'] : 'unknown';
    if (name is! String ||
        name.length > 128 ||
        _forbidden.hasMatch(name) ||
        name.trim().isEmpty ||
        name.trim().runes.length > 64 ||
        platform is! String ||
        !const {
          'darwin',
          'win32',
          'linux',
          'android',
          'ios',
          'unknown',
        }.contains(platform) ||
        form is! String ||
        !const {
          'desktop',
          'laptop',
          'phone',
          'tablet',
          'unknown',
        }.contains(form)) {
      return null;
    }
    return CoreDisplayDevice(name.trim(), platform, form);
  }

  DeviceKind get kind => switch ((platform, formFactor)) {
    ('darwin', 'laptop') => DeviceKind.macBook,
    ('win32', 'desktop') => DeviceKind.pc,
    ('android', 'phone') => DeviceKind.android,
    ('ios', 'phone') => DeviceKind.iPhone,
    _ => DeviceKind.unknown,
  };
}
