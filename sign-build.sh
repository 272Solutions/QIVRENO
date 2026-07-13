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
npm run tauri build

DMG="src-tauri/target/release/bundle/dmg/Qivreno_$(node -p "require('./package.json').version")_aarch64.dmg"
echo "\n== Verifying notarization/staple =="
xcrun stapler validate "$DMG" && echo "✓ stapled" || echo "⚠ not stapled — check the build log above"
spctl -a -t open --context context:primary-signature -v "$DMG" 2>&1 | head -3 || true
