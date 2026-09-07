#!/usr/bin/env bash
# build/icon.png -> build/icon.icns, the multi-resolution icon electron-builder
# stamps into the bundle. Regenerate after editing scripts/make-icon.swift.
set -euo pipefail
cd "$(dirname "$0")/.."

swift scripts/make-icon.swift

SET=build/icon.iconset
rm -rf "$SET"; mkdir -p "$SET"
for pair in 16:icon_16x16 32:icon_16x16@2x 32:icon_32x32 64:icon_32x32@2x \
            128:icon_128x128 256:icon_128x128@2x 256:icon_256x256 512:icon_256x256@2x \
            512:icon_512x512 1024:icon_512x512@2x; do
  sips -z "${pair%%:*}" "${pair%%:*}" build/icon.png --out "$SET/${pair##*:}.png" >/dev/null
done
iconutil -c icns "$SET" -o build/icon.icns
echo "wrote build/icon.icns"
