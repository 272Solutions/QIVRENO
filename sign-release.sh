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
[ -f .signing.env ] || { echo "Missing .signing.env — copy .signing.env.example and fill it in."; exit 1; }
set -a; source .signing.env; set +a

# .signing.env supplies:
#   APPLE_SIGNING_IDENTITY  — cert name (security find-identity -v -p codesigning)
#   APPLE_API_ISSUER        — App Store Connect Issuer ID (a UUID)
#   APPLE_API_KEY           — the Key ID (e.g. ABC123XYZ9)
#   APPLE_API_KEY_PATH      — absolute path to AuthKey_XXXXX.p8
for v in APPLE_SIGNING_IDENTITY APPLE_API_ISSUER APPLE_API_KEY APPLE_API_KEY_PATH; do
  [ -n "${(P)v}" ] || { echo "Missing $v in .signing.env"; exit 1; }
done
[ -f "$APPLE_API_KEY_PATH" ] || { echo "API key not found at APPLE_API_KEY_PATH"; exit 1; }

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
# Discover every Mach-O by inspecting the files, not by globbing known names —
# the engine gains and renames binaries between llama.cpp versions, and one
# unsigned straggler fails the whole notarization.
ENGINE="$APP/Contents/Resources/llama"
machos=()
for f in "$ENGINE"/*; do
  [ -f "$f" ] || continue
  file "$f" | grep -q "Mach-O" && machos+=("$f")
done
[ ${#machos[@]} -gt 0 ] || { echo "no Mach-O files under $ENGINE"; exit 1; }
# Libraries first, then executables, so each signature seals signed deps.
for f in "${machos[@]}"; do
  case "$f" in *.dylib) codesign --force --options runtime --timestamp \
    --sign "$APPLE_SIGNING_IDENTITY" "$f" || exit 1 ;;
  esac
done
for f in "${machos[@]}"; do
  case "$f" in *.dylib) ;; *) codesign --force --options runtime --timestamp \
    --sign "$APPLE_SIGNING_IDENTITY" "$f" || exit 1 ;;
  esac
done
# Verify before notarizing. This is the check that catches the keychain
# problem in the header comment: when codesign cannot reach the private key
# it falls back to an ad-hoc signature with no Developer ID and no secure
# timestamp, and the only other symptom is a notary rejection ten minutes
# later. Fail here instead, with the cause named.
for f in "${machos[@]}"; do
  info=$(codesign -dvv "$f" 2>&1)
  echo "$info" | grep -q "Authority=Developer ID Application" || {
    echo "  ✗ $f is not Developer ID signed (ad-hoc fallback?)"
    echo "    Run this in an interactive shell, or: security unlock-keychain"
    exit 1; }
  echo "$info" | grep -q "Timestamp=" || {
    echo "  ✗ $f has no secure timestamp"; exit 1; }
done
echo "  signed + verified ${#machos[@]} nested binaries"

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
