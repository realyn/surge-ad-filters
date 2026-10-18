#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
OUT=${1:?请指定输出目录}
mkdir -p "$OUT"
OUT=$(CDPATH= cd -- "$OUT" && pwd)
APP="$OUT/Surge Ad Check.app"
if [ -e "$APP" ]; then echo '输出中已存在同名应用，请使用新的目录。' >&2; exit 1; fi
TARGET=${CARGO_TARGET_DIR:-"$ROOT/tools/ad-check/target"}
export MACOSX_DEPLOYMENT_TARGET=11.0
for ARCH in aarch64-apple-darwin x86_64-apple-darwin; do
  cargo build --locked --release --manifest-path "$ROOT/tools/ad-check/Cargo.toml" --target "$ARCH" --target-dir "$TARGET"
done
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
lipo -create "$TARGET/aarch64-apple-darwin/release/surge-ad-check" "$TARGET/x86_64-apple-darwin/release/surge-ad-check" -output "$APP/Contents/MacOS/surge-ad-check"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>surge-ad-check</string><key>CFBundleIdentifier</key><string>com.realyn.surge-ad-check</string><key>CFBundleName</key><string>Surge Ad Check</string><key>CFBundleVersion</key><string>4</string><key>CFBundleShortVersionString</key><string>0.3.0</string><key>CFBundlePackageType</key><string>APPL</string><key>LSMinimumSystemVersion</key><string>11.0</string><key>CFBundleIconFile</key><string>AppIcon</string><key>NSHighResolutionCapable</key><true/><key>NSPrincipalClass</key><string>NSApplication</string></dict></plist>
PLIST
ICONSET="$OUT/AppIcon.iconset"
mkdir -p "$ICONSET"
for SIZE in 16 32 128 256 512; do
  sips -z "$SIZE" "$SIZE" "$ROOT/tools/ad-check/assets/AppIcon.png" --out "$ICONSET/icon_${SIZE}x${SIZE}.png" >/dev/null
  DOUBLE=$((SIZE * 2))
  sips -z "$DOUBLE" "$DOUBLE" "$ROOT/tools/ad-check/assets/AppIcon.png" --out "$ICONSET/icon_${SIZE}x${SIZE}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
rm -r "$ICONSET"
cp "$ROOT/LICENSE" "$APP/Contents/Resources/LICENSE.txt"
cp "$ROOT/tools/ad-check/THIRD_PARTY_NOTICES.txt" "$APP/Contents/Resources/THIRD_PARTY_NOTICES.txt"
cp "$ROOT/tools/ad-check/README.md" "$OUT/使用说明.md"
xattr -cr "$APP"
codesign --force --sign - --identifier com.realyn.surge-ad-check "$APP"
ditto --norsrc -c -k --keepParent "$APP" "$OUT/Surge-Ad-Check-0.3.0-mac-universal.zip"
shasum -a 256 "$OUT/Surge-Ad-Check-0.3.0-mac-universal.zip" | sed "s|$OUT/||" > "$OUT/SHA256SUMS.txt"
echo "已生成：$APP"
