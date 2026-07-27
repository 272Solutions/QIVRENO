#!/bin/zsh
# Signed + notarized macOS build for Qivreno.
# Fill in .signing.env (copy from .signing.env.example) first — it is gitignored.
# Requires: a "Developer ID Application" cert in your login keychain, and an
# App Store Connect API key (.p8) for notarization.
set -e
cd "$(dirname "$0")"

if [ ! -f .signing.env ]; then
  echo "Missing .signing.env — copy .signing.env.example to .signing.env and fill it in."
  exit 1
fi
set -a; source .signing.env; set +a

# tauri reads these for Developer ID signing + notarization + stapling:
#   APPLE_SIGNING_IDENTITY  — the cert name (from: security find-identity -v -p codesigning)
#   APPLE_API_ISSUER        — App Store Connect Issuer ID (a UUID)
#   APPLE_API_KEY           — the Key ID (e.g. ABC123XYZ9)
#   APPLE_API_KEY_PATH      — absolute path to your AuthKey_XXXXX.p8
export APPLE_SIGNING_IDENTITY APPLE_API_ISSUER APPLE_API_KEY APPLE_API_KEY_PATH

echo "Signing identity: $APPLE_SIGNING_IDENTITY"

# The vendored llama.cpp engine ships as prebuilt Mach-O files with no
# signature of their own. Tauri signs the .app bundle but does NOT re-sign
# nested binaries, so notarization rejects them ("not signed with a valid
# Developer ID certificate" / "signature does not include a secure
# timestamp"). Sign them inside-out here, before the bundle is assembled:
# dylibs first, executables last. Idempotent — safe to re-run.
sign_engine_resources() {
  local dir="$1"
  [ -d "$dir" ] || return 0
  local -a machos
  machos=()
  local f
  for f in "$dir"/*; do
    [ -f "$f" ] || continue
    if file "$f" | grep -q "Mach-O"; then machos+=("$f"); fi
  done
  [ ${#machos[@]} -eq 0 ] && return 0
  echo "== Signing ${#machos[@]} engine binaries in $dir =="
  # Libraries before executables so each signature seals already-signed deps.
  for f in "${machos[@]}"; do
    case "$f" in *.dylib) codesign --force --timestamp --options runtime \
      --sign "$APPLE_SIGNING_IDENTITY" "$f" >/dev/null 2>&1 || {
        echo "  ✗ failed: $f"; exit 1; } ;;
    esac
  done
  for f in "${machos[@]}"; do
    case "$f" in *.dylib) ;; *) codesign --force --timestamp --options runtime \
      --sign "$APPLE_SIGNING_IDENTITY" "$f" >/dev/null 2>&1 || {
        echo "  ✗ failed: $f"; exit 1; } ;;
    esac
  done
  # Fail loudly here rather than after a 10-minute notarization round trip.
  for f in "${machos[@]}"; do
    codesign -dvv "$f" 2>&1 | grep -q "Timestamp=" || {
      echo "  ✗ no secure timestamp on $f"; exit 1; }
  done
  echo "  ✓ all signed with secure timestamps"
}
sign_engine_resources "src-tauri/resources/llama"

npm run tauri build

DMG="src-tauri/target/release/bundle/dmg/Qivreno_$(node -p "require('./package.json').version")_aarch64.dmg"

# Tauri notarizes and staples the .app, then wraps it in a DMG that is signed
# but NOT itself notarized. Customers download the DMG, so notarize and staple
# that too — otherwise Gatekeeper warns when they open it.
echo "\n== Notarizing the DMG =="
xcrun notarytool submit "$DMG" \
  --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER" \
  --wait
xcrun stapler staple "$DMG"

echo "\n== Verifying notarization/staple =="
xcrun stapler validate "$DMG" && echo "✓ stapled" || echo "⚠ not stapled — check the build log above"
spctl -a -t open --context context:primary-signature -v "$DMG" 2>&1 | head -3 || true
