#!/bin/zsh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOTS_TEMP="$(mktemp -d)"
trap 'rm -rf "$DOTS_TEMP"' EXIT
swiftc "$ROOT/scripts/mac/menu-app/DeviceDirectoryClient.swift" "$ROOT/scripts/mac/menu-app/DeviceStatusDots.swift" "$ROOT/test/mac/DeviceStatusDotsTest.swift" -o "$DOTS_TEMP/test"
"$DOTS_TEMP/test" "$ROOT/scripts/mac/menu-app/SeanTemplate.png" "${CODASSOL_DOTS_ARTIFACTS:-$DOTS_TEMP/previews}"
