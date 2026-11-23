#!/bin/zsh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
OUTPUT="${1:-$ROOT/../../../dist/Codas-mac-0.3.12.zip}"
if [[ "$OUTPUT" != *.zip ]]; then
    print -u2 -- "Build output must be a .zip archive; use install-menu.py to install the app."
    exit 2
fi
# Build/sign off iCloud, then publish only an archive. A loose build .app can
# be indexed by Spotlight and selected instead of the installed application.
BUILD_TEMP="$(mktemp -d "${TMPDIR:-/tmp}/codas-menu-build.XXXXXX")"
BUILD_TEMP="$(cd "$BUILD_TEMP" && pwd -P)"
ARCHIVE_STAGE=""
trap 'rm -rf -- "$BUILD_TEMP"; [[ -z "$ARCHIVE_STAGE" ]] || rm -f -- "$ARCHIVE_STAGE"' EXIT
DEST="$BUILD_TEMP/Codas-mac.app"
mkdir -p "$DEST/Contents/MacOS"
mkdir -p "$DEST/Contents/Resources"
mkdir -p "$DEST/Contents/Helpers"
swiftc "$ROOT/main.swift" "$ROOT/DevSpaceManager.swift" "$ROOT/DeviceDirectoryClient.swift" "$ROOT/DevicePanelView.swift" "$ROOT/DevicePanelLayout.swift" "$ROOT/DeviceStatusDots.swift" -O -o "$DEST/Contents/MacOS/CodasMac"
swiftc "$ROOT/menu-launcher.swift" -O -o "$DEST/Contents/Helpers/CodasMenuLauncher"
cp "$ROOT/SeanTemplate.png" "$DEST/Contents/Resources/SeanTemplate.png"
cp "$ROOT/devspace-runner.zsh" "$DEST/Contents/Resources/devspace-runner.zsh"
cp "$ROOT/migrate-devspace.py" "$DEST/Contents/Resources/migrate-devspace.py"
# Icons are bundled source assets: moving sean.PNG or the application itself
# must not break fresh builds or the background launcher.
cp "$ROOT/Codas.icns" "$DEST/Contents/Resources/Codas.icns"
cat > "$DEST/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.codassol.mac</string>
<key>CFBundleName</key><string>Codas-mac</string>
<key>CFBundleDisplayName</key><string>Codas-mac</string>
<key>CFBundleShortVersionString</key><string>0.3.12</string>
<key>CFBundleVersion</key><string>16</string>
<key>CFBundleIconFile</key><string>Codas</string>
<key>CFBundleExecutable</key><string>CodasMac</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST
# iCloud/Finder can attach these attributes to a newly generated bundle. They
# are not application resources and codesign rejects them; clear only these
# two keys on this build output, preserving all other extended attributes.
/usr/bin/xattr -dr com.apple.FinderInfo "$DEST" 2>/dev/null || true
/usr/bin/xattr -dr com.apple.ResourceFork "$DEST" 2>/dev/null || true
/usr/bin/codesign --force --sign - "$DEST"
/usr/bin/codesign --verify --strict "$DEST"
mkdir -p "${OUTPUT:h}"
ARCHIVE_STAGE="$(mktemp "${OUTPUT:h}/.Codas-mac-package.XXXXXX")"
/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$DEST" "$ARCHIVE_STAGE"
mv -f -- "$ARCHIVE_STAGE" "$OUTPUT"
ARCHIVE_STAGE=""
echo "Built signed application archive: $OUTPUT"
echo "Staged only. Review installation with: python3 \"$ROOT/install-menu.py\" --source \"$OUTPUT\" --plan"
