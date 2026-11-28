import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:codas_mobile/device_painter.dart';

void main() {
  test('all vector glyphs fit the same 78 x 76 slot and use fine dots', () {
    final signatures = <String>{};
    for (final kind in DeviceKind.values) {
      final glyph = deviceGlyph(kind);
      final points = glyph.contours.expand(outlineSamples).toList();
      expect(points.length, greaterThan(35));
      expect(
        points.every((p) => p.dx >= 0 && p.dx <= 78 && p.dy >= 0 && p.dy <= 76),
        isTrue,
      );
      signatures.add(
        points
            .map((p) => '${p.dx.toStringAsFixed(2)},${p.dy.toStringAsFixed(2)}')
            .join(';'),
      );
    }
    expect(signatures, hasLength(DeviceKind.values.length));
    expect(DeviceConnectionPainter.devicePitch, 3.25);
    expect(DeviceConnectionPainter.dotRadius, 1.35);
  });

  test('MacBook screen is smaller than the desktop monitor', () {
    final pc = deviceGlyph(DeviceKind.pc).contours.first.getBounds();
    final mac = deviceGlyph(DeviceKind.macBook).contours.first.getBounds();
    expect(mac.width, lessThan(pc.width));
    expect(mac.height, lessThan(pc.height));
    expect(
      deviceGlyph(DeviceKind.macBook).contours[1].getBounds().width,
      lessThan(60),
    );
  });

  test('MacBook has a centered three-dot camera notch', () {
    final glyph = deviceGlyph(DeviceKind.macBook);
    final screen = glyph.contours.first.getBounds();
    final notch = outlineSamples(glyph.contours.last);
    expect(notch, hasLength(3));
    expect(notch[1].dx, closeTo(screen.center.dx, .0001));
    expect(notch.every((p) => p.dy == screen.top + 3.25), isTrue);
    expect(screen.width, 47);
    expect(screen.height, 31);
  });

  test('four-unit rectangular margin removes entire background dots', () {
    for (final kind in DeviceKind.values) {
      final stamp = DeviceStamp(kind, const Offset(3.5, 40.5));
      final expected = ConnectionLayout.boundsFor(kind)
          .shift(stamp.origin)
          .inflate(4);
      expect(stamp.rectangle, expected);
      expect(stamp.cleared, isNotEmpty);
      expect(stamp.cleared.contains(0), isFalse);
      final box = expected.inflate(1.05);
      for (int row = 0; row < 33; row++) {
        for (int col = 0; col < 46; col++) {
          final p = Offset(2.5 + col * 5, 2.5 + row * 5);
          expect(
            stamp.cleared.contains(row * 46 + col),
            p.dx >= box.left &&
                p.dx <= box.right &&
                p.dy >= box.top &&
                p.dy <= box.bottom,
          );
        }
      }
    }
  });

  test(
    'all pairs have equal margins, matching link gaps and vertical centers',
    () {
      for (final local in DeviceKind.values) {
        for (final core in DeviceKind.values) {
          for (final phase in LinkPhase.values) {
            final layout = ConnectionLayout(local, core, phase);
            final l = ConnectionLayout.boundsFor(local)
                .shift(layout.localOrigin);
            final r = ConnectionLayout.boundsFor(core).shift(layout.coreOrigin);
            expect(l.left, closeTo(230 - r.right, .0001));
            expect(l.left, greaterThanOrEqualTo(10));
            expect(l.center.dy, closeTo(82.5, .0001));
            expect(r.center.dy, closeTo(82.5, .0001));
            expect(
              layout.dot(0).dx - l.right,
              closeTo(r.left - layout.dot(6).dx, .0001),
            );
            expect(
              layout.dot(0).dx - l.right,
              greaterThanOrEqualTo(14 - .0001),
            );
            expect(layout.step, greaterThan(5));
            final reversed = ConnectionLayout(core, local, phase);
            expect(layout.dot(3).dx + reversed.dot(3).dx, closeTo(230, .0001));
          }
        }
      }
    },
  );

  testWidgets('all 25 ordered combinations render in all 3 phases', (
    tester,
  ) async {
    final motion = AnimationController(vsync: tester);
    for (final local in DeviceKind.values) {
      for (final core in DeviceKind.values) {
        for (final phase in LinkPhase.values) {
          await tester.pumpWidget(
            Directionality(
              textDirection: TextDirection.ltr,
              child: Center(
                child: SizedBox(
                  width: 345,
                  height: 247.5,
                  child: CustomPaint(
                    painter: DeviceConnectionPainter(
                      local: local,
                      core: core,
                      phase: phase,
                      motion: motion,
                      reduceMotion: true,
                    ),
                  ),
                ),
              ),
            ),
          );
          expect(
            tester.takeException(),
            isNull,
            reason: '$local / $core / $phase',
          );
        }
      }
    }
    await tester.pumpWidget(const SizedBox());
    motion.dispose();
  });
}
