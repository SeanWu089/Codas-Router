#!/usr/bin/env bash
set -euo pipefail
# Independent fixture. Does not install, update, or contact a device.
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Library/Android/sdk}}"
JDK="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17}"
BT="$SDK/build-tools/35.0.0"
JAR="$SDK/platforms/android-35/android.jar"
OUT="${1:?Provide an unused absolute output APK path}"
test ! -e "$OUT"
D="$(mktemp -d)"
trap 'rm -rf "$D"' EXIT
export JAVA_HOME="$JDK"
export PATH="$JDK/bin:$PATH"
mkdir "$D/classes" "$D/dex"
"$JDK/bin/javac" --release 8 -cp "$JAR" -d "$D/classes" \
 "$ROOT/identity/native/java/codas/identity/IdentityWire.java" \
 "$ROOT/identity/native/android/codas/identity/AndroidIdentityStore.java" \
 "$ROOT/identity/native/android/codas/identity/IdentityProbe.java"
"$BT/d8" --min-api 30 --lib "$JAR" --output "$D/dex" $(find "$D/classes" -name '*.class')
"$BT/aapt2" link -I "$JAR" --manifest "$ROOT/identity/native/android/AndroidManifest.xml" -o "$D/unsigned.apk"
(cd "$D/dex"; zip -q "$D/unsigned.apk" classes.dex)
"$BT/zipalign" -f 4 "$D/unsigned.apk" "$D/aligned.apk"
export CODAS_PROBE_KEY_PASS="$(python3 -c 'import secrets; print(secrets.token_hex(24))')"
"$JDK/bin/keytool" -genkeypair -alias probe -keyalg RSA -keysize 2048 -validity 30 \
 -dname "CN=Codas isolated test probe" -storetype PKCS12 -keystore "$D/probe.p12" \
 -storepass:env CODAS_PROBE_KEY_PASS -keypass:env CODAS_PROBE_KEY_PASS >/dev/null 2>&1
"$BT/apksigner" sign --ks "$D/probe.p12" --ks-key-alias probe \
 --ks-pass env:CODAS_PROBE_KEY_PASS --key-pass env:CODAS_PROBE_KEY_PASS --out "$OUT" "$D/aligned.apk"
unset CODAS_PROBE_KEY_PASS
"$BT/apksigner" verify --verbose "$OUT"
"$BT/aapt2" dump badging "$OUT" | head -5
echo ANDROID_PROBE_BUILD_OK
