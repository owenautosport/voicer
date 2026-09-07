#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../native/voicerkit"
swift build "$@"
./.build/debug/voicerkit --self-test 2>/dev/null || ./.build/release/voicerkit --self-test
