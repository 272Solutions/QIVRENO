#!/bin/zsh
# Full Developer ID signing + notarization + stapling for a distributable
# Qivreno release. tauri's own signing misses secure timestamps on the bundled
# llama binaries (notarization rejects them), so we sign inside-out ourselves.
# Requires .signing.env (gitignored) with APPLE_SIGNING_IDENTITY + API key vars.
#
# IMPORTANT: run this in the FOREGROUND from an interactive shell. Background /
# detached processes cannot reach the login keychain's private key without an
# unlock prompt, so codesign silently falls back to ad-hoc signatures and the
# notary service then rejects every nested binary. If you must automate it,
# `security unlock-keychain` first so the key is available non-interactively.
set -e
cd "$(dirname "$0")"
[ -f .signing.env ] || { echo "Missing .signing.env"; exit 1; }
set -a; source .signing.env; set +a

ENT="src-tauri/entitlements.plist"
VER=$(node -p "require('./package.json').version")
BUNDLE="src-tauri/target/release/bundle"
APP="$BUNDLE/macos/Qivreno.app"
DMG="$BUNDLE/dmg/Qivreno_${VER}_aarch64.dmg"

echo "== 1/6 build =="
# tauri's own dmg step needs Finder automation permission and fails in
# non-interactive shells ("AppleEvent timed out"). Its dmg is discarded in
# step 5 anyway, so tolerate that failure — only the .app must exist.
npm run tauri build >/dev/null 2>&1 || true
[ -d "$APP" ] || { echo "build failed: $APP missing"; npm run tauri build; exit 1; }

echo "== 2/6 sign nested binaries (timestamp + hardened runtime) =="
n=0
for f in "$APP/Contents/Resources/llama/"*.dylib "$APP/Contents/Resources/llama/llama-server"; do
  [ -f "$f" ] || continue
  codesign --force --options runtime --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$f" >/dev/null 2>&1 && n=$((n+1))
done
echo "  signed $n nested binaries"

echo "== 3/6 sign app shell (entitlements) =="
codesign --force --options runtime --timestamp --entitlements "$ENT" --sign "$APPLE_SIGNING_IDENTITY" "$APP"
codesign --verify --deep --strict "$APP" && echo "  deep signature valid"

echo "== 4/6 notarize the app =="
ditto -c -k --keepParent "$APP" /tmp/Qivreno-app.zip
xcrun notarytool submit /tmp/Qivreno-app.zip \
  --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER" --wait
xcrun stapler staple "$APP"

echo "== 5/6 rebuild DMG from the stapled app =="
rm -f "$DMG"
TMPDMG=/tmp/Qivreno-staged
rm -rf "$TMPDMG"; mkdir -p "$TMPDMG"
cp -R "$APP" "$TMPDMG/"
ln -s /Applications "$TMPDMG/Applications"
hdiutil create -volname "Qivreno" -srcfolder "$TMPDMG" -ov -format UDZO "$DMG"
codesign --force --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$DMG"

echo "== 6/6 notarize + staple the DMG =="
xcrun notarytool submit "$DMG" \
  --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER" --wait
xcrun stapler staple "$DMG"

echo "\n== verification =="
xcrun stapler validate "$DMG" && echo "✓ DMG stapled"
spctl -a -t open --context context:primary-signature -v "$DMG" 2>&1 | head -2 || true
echo "DONE: $DMG"
