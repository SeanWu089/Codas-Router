#!/bin/zsh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
SOURCE_COMMIT="$(git -C "$ROOT/../../.." rev-parse HEAD)"
SOURCE_STATE=clean
[[ -z "$(git -C "$ROOT/../../.." status --porcelain --untracked-files=normal)" ]] || SOURCE_STATE=dirty
OUTPUT="${1:-$ROOT/../../../dist/Codas-mac-0.3.15.zip}"
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
swiftc "$ROOT/main.swift" "$ROOT/DevSpaceManager.swift" "$ROOT/DeviceDirectoryClient.swift" "$ROOT/DevicePanelView.swift" "$ROOT/DevicePanelLayout.swift" "$ROOT/DeviceStatusDots.swift" "$ROOT/WorkspaceDirectoryModel.swift" "$ROOT/WorkspaceDirectoriesView.swift" -O -o "$DEST/Contents/MacOS/CodasMac"
swiftc "$ROOT/menu-launcher.swift" -O -o "$DEST/Contents/Helpers/CodasMenuLauncher"
swiftc "$ROOT/workspace-owner-approval.swift" -O -o "$DEST/Contents/Helpers/CodasWorkspaceApproval"
cp "$ROOT/SeanTemplate.png" "$DEST/Contents/Resources/SeanTemplate.png"
cp "$ROOT/devspace-runner.zsh" "$DEST/Contents/Resources/devspace-runner.zsh"
cp "$ROOT/migrate-devspace.py" "$DEST/Contents/Resources/migrate-devspace.py"
# Icons are bundled source assets: moving sean.PNG or the application itself
# must not break fresh builds or the background launcher.
swift "$ROOT/render-brand-icon.swift" "$ROOT/../../../assets/brand/codas-peer.svg" "$BUILD_TEMP/Codas.iconset"
/usr/bin/iconutil -c icns "$BUILD_TEMP/Codas.iconset" -o "$DEST/Contents/Resources/Codas.icns"
mkdir -p "$DEST/Contents/Resources/root-policy"
cp "$ROOT/workspace-root-helper.mjs" "$DEST/Contents/Resources/root-policy/"
for module in local-workspace-policy.js local-root-transaction.js mac-workspace-service.js devspace-local-auth.js mcp-routing.js; do
  cp "$ROOT/../../../src/$module" "$DEST/Contents/Resources/root-policy/$module"
done
print -r -- '{"type":"module","private":true}' > "$DEST/Contents/Resources/root-policy/package.json"
/usr/bin/codesign --force --sign - "$DEST/Contents/Helpers/CodasWorkspaceApproval"
/usr/bin/codesign --force --sign - "$DEST/Contents/Helpers/CodasMenuLauncher"
cat > "$DEST/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.codassol.mac</string>
<key>CFBundleName</key><string>Codas</string>
<key>CFBundleDisplayName</key><string>Codas</string>
<key>CFBundleShortVersionString</key><string>0.3.15</string>
<key>CFBundleVersion</key><string>19</string>
<key>CodasSourceCommit</key><string>$SOURCE_COMMIT</string>
<key>CodasSourceState</key><string>$SOURCE_STATE</string>
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
[[ "$(git -C "$ROOT/../../.." rev-parse HEAD)" == "$SOURCE_COMMIT" ]] || { print -u2 -- 'Git HEAD changed during the build'; exit 1; }
if [[ "$SOURCE_STATE" == clean && -n "$(git -C "$ROOT/../../.." status --porcelain --untracked-files=normal)" ]]; then
  print -u2 -- 'Source changed during the build; refusing a clean-source archive'
  exit 1
fi
/usr/bin/codesign --force --sign - "$DEST"
/usr/bin/codesign --verify --strict "$DEST"
mkdir -p "${OUTPUT:h}"
ARCHIVE_STAGE="$(mktemp "${OUTPUT:h}/.Codas-mac-package.XXXXXX")"
/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$DEST" "$ARCHIVE_STAGE"
mv -f -- "$ARCHIVE_STAGE" "$OUTPUT"
ARCHIVE_STAGE=""
echo "Built signed application archive: $OUTPUT"
echo "Staged only. Review installation with: python3 \"$ROOT/install-menu.py\" --source \"$OUTPUT\" --plan"
