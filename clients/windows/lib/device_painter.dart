import 'dart:math' as math;

import 'package:flutter/material.dart';

// Preserve the original Codas palette, logical canvas and background grid.
// The device contours use a finer pitch for better silhouette recognition.
const codasBg = Color(0xfff6f6f2);
const codasInk = Color(0xff1b1c1a);
const codasSoft = Color(0xffebebe6);
const codasMuted = Color(0xff81847e);
const codasRed = Color(0xffd9342b);

enum DeviceKind { pc, macBook, android, iPhone, unknown }

enum LinkPhase { off, connecting, connected }

extension DeviceLabel on DeviceKind {
  String get label => switch (this) {
    DeviceKind.pc => 'Windows PC',
    DeviceKind.macBook => 'MacBook',
    DeviceKind.android => 'Android',
    DeviceKind.iPhone => 'iPhone',
    DeviceKind.unknown => 'Unknown',
  };
}

// A vector-first silhouette keeps the original Codas dot language, but
// avoids the heavy, staircase-shaped outlines of the 15-cell masks.
class DeviceGlyph {
  DeviceGlyph(this.contours, this.interiors, {this.accents = const []});
  final List<Path> contours;
  final List<Path> interiors;
  final List<Offset> accents;
}

Path _rounded(double x, double y, double w, double h, double radius) => Path()
  ..addRRect(
    RRect.fromRectAndRadius(Rect.fromLTWH(x, y, w, h), Radius.circular(radius)),
  );

Path _line(List<Offset> points) => Path()..addPolygon(points, false);

DeviceGlyph deviceGlyph(DeviceKind kind) {
  switch (kind) {
    case DeviceKind.pc:
      final screen = _rounded(3, 16, 49, 34, 3);
      final tower = _rounded(58, 16, 17, 44, 3);
      return DeviceGlyph(
        [
          screen,
          tower,
          _line([const Offset(27.5, 50), const Offset(27.5, 59)]),
          _line([const Offset(16, 59), const Offset(39, 59)]),
        ],
        [screen, tower],
        accents: [const Offset(66.5, 23.5)],
      );
    case DeviceKind.macBook:
      final screen = _rounded(15.5, 20, 47, 31, 3);
      final base = Path()
        ..addPolygon([
          const Offset(15.5, 51),
          const Offset(62.5, 51),
          const Offset(68.5, 56.5),
          const Offset(9.5, 56.5),
        ], true);
      return DeviceGlyph(
        [
          screen,
          _line([
            const Offset(15.5, 51),
            const Offset(9.5, 56.5),
            const Offset(68.5, 56.5),
            const Offset(62.5, 51),
          ]),
          _line([const Offset(17.5, 53.75), const Offset(60.5, 53.75)]),
          // Three evenly spaced dots immediately below the top bezel.
          _line([const Offset(35.75, 23.25), const Offset(42.25, 23.25)]),
        ],
        [screen, base],
      );
    case DeviceKind.android:
      final body = _rounded(22, 7, 34, 65, 4.5);
      return DeviceGlyph([body], [body], accents: [const Offset(39, 14)]);
    case DeviceKind.iPhone:
      final body = _rounded(22, 7, 34, 65, 8);
      return DeviceGlyph(
        [
          body,
          _line([const Offset(34.5, 14.5), const Offset(43.5, 14.5)]),
          _line([const Offset(32.5, 65), const Offset(45.5, 65)]),
        ],
        [body],
      );
    case DeviceKind.unknown:
      final body = _rounded(18, 19, 42, 42, 8);
      return DeviceGlyph(
        [
          body,
          _line([
            const Offset(32, 30),
            const Offset(45, 30),
            const Offset(45, 37),
            const Offset(39, 42),
          ]),
        ],
        [body],
        accents: [const Offset(39, 49)],
      );
  }
}

// Evenly spaced dots along the actual vector contours, including curves.
List<Offset> outlineSamples(Path path, {double pitch = 3.25}) {
  final samples = <Offset>[];
  for (final metric in path.computeMetrics()) {
    if (metric.length <= 0) continue;
    final count = math.max(1, (metric.length / pitch).round());
    final end = metric.isClosed ? count - 1 : count;
    for (var i = 0; i <= end; i++) {
      final tangent = metric.getTangentForOffset(metric.length * i / count);
      if (tangent != null) samples.add(tangent.position);
    }
  }
  return samples;
}

// Rectangular clear area, matching the final approved preview.
class DeviceStamp {
  DeviceStamp(DeviceKind kind, this.origin) : glyph = deviceGlyph(kind) {
    points = glyph.contours.expand(outlineSamples).toList();
    rectangle = glyph.contours
        .map((p) => p.getBounds())
        .reduce((a, b) => a.expandToInclude(b))
        .shift(origin)
        .inflate(clearMargin);
    final excluded = rectangle.inflate(1.05);
    for (int row = 0; row < 33; row++) {
      for (int col = 0; col < 46; col++) {
        final p = Offset(2.5 + col * 5, 2.5 + row * 5);
        if (p.dx >= excluded.left &&
            p.dx <= excluded.right &&
            p.dy >= excluded.top &&
            p.dy <= excluded.bottom) {
          cleared.add(row * 46 + col);
        }
      }
    }
  }

  static const clearMargin = 4.0;
  final Offset origin;
  final DeviceGlyph glyph;
  late final Rect rectangle;
  late final List<Offset> points;
  final Set<int> cleared = {};
}

// Compute the layout from visible glyph bounds, not fixed left/right origins.
// The device pair has equal outer margins and identical clearance to the link.
class ConnectionLayout {
  ConnectionLayout(DeviceKind local, DeviceKind core, LinkPhase phase) {
    final l = boundsFor(local);
    final r = boundsFor(core);
    const gap = 14.0;
    final span = math.min(60.0, 206.0 - l.width - r.width - 2 * gap);
    final total = l.width + r.width + span + 2 * gap;
    final leftEdge = (230 - total) / 2;
    final offset = phase == LinkPhase.off ? 2.0 : 0.0;
    final rightEdge = leftEdge + total;
    localOrigin = Offset(leftEdge - l.left - offset, centerY - l.center.dy);
    coreOrigin = Offset(rightEdge - r.right + offset, centerY - r.center.dy);
    final localRight = localOrigin.dx + l.right + DeviceStamp.clearMargin;
    final coreLeft = coreOrigin.dx + r.left - DeviceStamp.clearMargin;
    final linkCenter = (localRight + coreLeft) / 2;
    firstDot = linkCenter - span / 2;
    step = span / 6;
  }

  static const centerY = 82.5;
  late final Offset localOrigin;
  late final Offset coreOrigin;
  late final double firstDot;
  late final double step;
  Offset dot(int i) => Offset(firstDot + i * step, centerY);
  double get radiusScale => math.min(1.0, step / 8.5);

  static Rect boundsFor(DeviceKind kind) =>
      deviceGlyph(kind).contours
          .map((p) => p.getBounds())
          .reduce((a, b) => a.expandToInclude(b));
}

class DeviceConnectionPainter extends CustomPainter {
  DeviceConnectionPainter({
    required this.local,
    required this.core,
    required this.phase,
    required this.motion,
    this.reduceMotion = false,
  }) : super(repaint: motion);

  final DeviceKind local;
  final DeviceKind core;
  final LinkPhase phase;
  final AnimationController motion;
  final bool reduceMotion;

  static const logicalSize = Size(230, 165);
  static const gridPitch = 5.0;
  static const devicePitch = 3.25;
  static const dotRadius = 1.35;
  final Paint _paint = Paint()..isAntiAlias = true;
  late final ConnectionLayout _layout = ConnectionLayout(local, core, phase);
  late final DeviceStamp _localStamp = DeviceStamp(local, _layout.localOrigin);
  late final DeviceStamp _coreStamp = DeviceStamp(core, _layout.coreOrigin);

  void _circle(Canvas canvas, Offset center, double radius, Color color) {
    _paint
      ..color = color
      ..style = PaintingStyle.fill
      ..shader = null;
    canvas.drawCircle(center, radius, _paint);
  }

  void _device(Canvas canvas, DeviceStamp stamp, double opacity) {
    final color = codasInk.withValues(alpha: opacity);
    for (final point in stamp.points) {
      _circle(canvas, point + stamp.origin, dotRadius, color);
    }
    for (final point in stamp.glyph.accents) {
      _circle(canvas, point + stamp.origin, 1.65, color);
    }
  }

  double _pulse(double t) => (math.cos(t * 2 * math.pi) + 1) / 2;

  @override
  void paint(Canvas canvas, Size size) {
    canvas.save();
    canvas.scale(
      size.width / logicalSize.width,
      size.height / logicalSize.height,
    );
    final backgroundDot = Color.alphaBlend(
      const Color(0xffcccfc9).withValues(alpha: .65),
      codasBg,
    );
    for (int row = 0; row < 33; row++) {
      for (int col = 0; col < 46; col++) {
        final index = row * 46 + col;
        if (_localStamp.cleared.contains(index) ||
            _coreStamp.cleared.contains(index)) {
          continue;
        }
        _circle(
          canvas,
          Offset(2.5 + col * gridPitch, 2.5 + row * gridPitch),
          1.05,
          backgroundDot,
        );
      }
    }

    final seconds = reduceMotion
        ? 0.0
        : (motion.lastElapsedDuration?.inMicroseconds ?? 0) / 1000000;
    _device(canvas, _localStamp, 1.0);
    final opacity = switch (phase) {
      LinkPhase.off => .36,
      LinkPhase.connecting =>
        reduceMotion ? .8 : .4 + .6 * _pulse(seconds / 1.25),
      LinkPhase.connected => 1.0,
    };
    _device(canvas, _coreStamp, opacity);

    // The original seven-dot connection animation, unchanged in behavior.
    for (int i = 0; i < 7; i++) {
      final radius = i == 3 ? 3.1 : 2.5;
      final search = _pulse((seconds - i * .13) / 1.25);
      final flow = _pulse((seconds - i * .16) / 2.2);
      final color = switch (phase) {
        LinkPhase.off => const Color(0xffbec1ba),
        LinkPhase.connecting => Color.lerp(
          const Color(0xffc9cbc4),
          codasRed,
          search,
        )!,
        LinkPhase.connected => codasRed.withValues(alpha: .6 + .4 * flow),
      };
      _circle(
        canvas,
        _layout.dot(i),
        (phase == LinkPhase.connected && !reduceMotion
                ? radius + flow * .9
                : radius) *
            _layout.radiusScale,
        color,
      );
    }
    if (phase == LinkPhase.connected && !reduceMotion) {
      final p = (seconds % 3) / 3;
      _paint
        ..color = codasRed.withValues(alpha: .38 * (1 - p))
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1;
      canvas.drawCircle(
        _layout.dot(3),
        (6 + p * 15) * _layout.radiusScale,
        _paint,
      );
    }
    if (phase == LinkPhase.connecting && !reduceMotion) {
      final p = (seconds % 1.5) / 1.5;
      final rect = Rect.fromLTWH(40 + 120 * p, 20, 30, 125);
      _paint
        ..style = PaintingStyle.fill
        ..shader = LinearGradient(
          colors: [
            codasRed.withValues(alpha: 0),
            codasRed.withValues(alpha: .22 * math.sin(p * math.pi)),
            codasRed.withValues(alpha: 0),
          ],
        ).createShader(rect);
      canvas.drawRect(rect, _paint);
      _paint.shader = null;
    }
    canvas.restore();
  }

  @override
  bool shouldRepaint(covariant DeviceConnectionPainter old) =>
      old.local != local ||
      old.core != core ||
      old.phase != phase ||
      old.reduceMotion != reduceMotion ||
      old.motion != motion;
}
