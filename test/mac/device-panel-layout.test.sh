#!/bin/zsh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TEST_TEMP="$(mktemp -d)"
TEST_FIXTURE_PID=""
cleanup() {
  if [[ -n "$TEST_FIXTURE_PID" ]]; then
    kill "$TEST_FIXTURE_PID" 2>/dev/null || true
    wait "$TEST_FIXTURE_PID" 2>/dev/null || true
  fi
  rm -rf "$TEST_TEMP"
}
trap cleanup EXIT

# URLProtocol.registerClass is not applied to the client's ephemeral URLSession
# on all macOS runtimes. Use an owned, ephemeral loopback listener instead.
node "$ROOT/scripts/mac/test-support/layout-usage-fixture.cjs" "$TEST_TEMP/fixture.port" &
TEST_FIXTURE_PID=$!
for attempt in {1..50}; do
  [[ -s "$TEST_TEMP/fixture.port" ]] && break
  kill -0 "$TEST_FIXTURE_PID" 2>/dev/null || break
  sleep 0.1
done
[[ -s "$TEST_TEMP/fixture.port" ]] || { print -u2 -- 'Layout fixture failed to start'; exit 1; }

swiftc \
  "$ROOT/scripts/mac/menu-app/DeviceDirectoryClient.swift" \
  "$ROOT/scripts/mac/menu-app/DevSpaceManager.swift" \
  "$ROOT/scripts/mac/menu-app/DevicePanelView.swift" \
  "$ROOT/scripts/mac/menu-app/DevicePanelLayout.swift" \
  "$ROOT/test/mac/DevicePanelLayoutTest.swift" \
  -o "$TEST_TEMP/device-panel-layout-test"
"$TEST_TEMP/device-panel-layout-test" "$(cat "$TEST_TEMP/fixture.port")"
