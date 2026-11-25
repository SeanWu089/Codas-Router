# Codas Android — Flutter UI

This is the integrated Android application, not the standalone UI demo. Its Gradle build compiles the canonical phone service source and resources from `../android/app/src/main` (excluding the legacy MainActivity), and the new Flutter Activity bridges the existing native API. Keep the native backend canonical; do not fork the connection, permission, authentication or APK implementation.

Build with Flutter 3.47.5 / JDK 17 / Android SDK 36 (target SDK remains 35):
`flutter pub get --offline`
`flutter test --no-pub`
`flutter build apk --release --target-platform android-arm64 --no-pub`

Preview.9 (versionCode 10) preserves the original package ID and existing debug signing certificate. The Flutter release APK is not debuggable, unlike the prior native debug APK. AndroidX contributes a same-signature internal receiver permission; the user-facing permissions are unchanged. System permission and APK confirmation must remain user-mediated.

Use real mobile devices or simulators for visual acceptance. Never treat browser-framed HTML as final mobile UI verification. The independent prototype remains separate and simulated.

A same-signed native Preview.8 recovery build with a higher versionCode can be generated from the original native Gradle app using `-PcodasVersionCode=11 -PcodasVersionName=0.1.0-wireless-preview.8-recovery`. This is a recovery artifact only, not a deployed version.
