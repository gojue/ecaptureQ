#!/bin/bash
# Usage: bash scripts/sign-macos.sh [APP] [adhoc|developer-id]
# Ad-hoc signing is the default and needs no Apple account or credentials.
# Developer ID signing is an explicit release-only choice, never a PR fallback.
# References: https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution
# https://docs.github.com/en/actions/how-tos/deploy/deploy-to-third-party-platforms/sign-xcode-applications
set +x
set -euo pipefail

app=${1:-dist/eCaptureQ.app}
mode=${2:-adhoc}
if [ "$#" -gt 2 ]; then
  echo 'Usage: sign-macos.sh [APP] [adhoc|developer-id]' >&2
  exit 1
fi
case "$mode" in
  adhoc|developer-id) ;;
  *) echo 'Signing mode must be adhoc or developer-id.' >&2; exit 1 ;;
esac
if [ "$(uname -s)" != Darwin ] || [ ! -f "$app/Contents/MacOS/eCaptureQ" ]; then
  echo 'Signing requires macOS and a built eCaptureQ.app bundle.' >&2
  exit 1
fi

report_signing() {
  local signing=$1
  local description=$2
  printf '%s\n' "$description"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then printf 'signing=%s\n' "$signing" >> "$GITHUB_OUTPUT"; fi
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '%s\n' "$description" >> "$GITHUB_STEP_SUMMARY"; fi
}

# Keep this branch before all Apple credential/keychain/notarization handling.
# The app has one Mach-O executable and system frameworks only; sign inside out.
if [ "$mode" = adhoc ]; then
  echo 'Applying ad-hoc signatures to the executable and application bundle.'
  codesign --force --sign - --timestamp=none "$app/Contents/MacOS/eCaptureQ"
  codesign --force --sign - --timestamp=none "$app"
  codesign --verify --deep --strict --verbose=2 "$app"
  signature=$(codesign --display --verbose=2 "$app" 2>&1)
  case $'\n'"$signature"$'\n' in
    *$'\nSignature=adhoc\n'*) ;;
    *) echo 'The application did not receive the required ad-hoc signature.' >&2; exit 1 ;;
  esac
  report_signing adhoc 'macOS app: ad-hoc signed, not notarized; no Apple developer identity is verified.'
  exit 0
fi

required=(APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID)
for key in "${required[@]}"; do
  if [ -z "${!key:-}" ]; then
    echo 'Developer ID mode requires all six APPLE_* signing/notarization secrets.' >&2
    exit 1
  fi
done
case "$APPLE_SIGNING_IDENTITY" in
  'Developer ID Application:'*) ;;
  *) echo 'APPLE_SIGNING_IDENTITY must be a Developer ID Application identity.' >&2; exit 1 ;;
esac

umask 077
signing_temp=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/ecaptureq-sign.XXXXXX")
signing_keychain="$signing_temp/signing.keychain-db"
# A codesign --keychain argument does not replace the user's keychain search list.
# Retain each path as one Bash array element, including paths containing spaces.
original_keychains=()
search_list_changed=0
cleanup() {
  if [ "$search_list_changed" -eq 1 ]; then
    if [ "${#original_keychains[@]}" -gt 0 ]; then
      security list-keychains -d user -s "${original_keychains[@]}" >/dev/null 2>&1 || true
    else
      security list-keychains -d user -s >/dev/null 2>&1 || true
    fi
  fi
  security delete-keychain "$signing_keychain" >/dev/null 2>&1 || true
  rm -rf "$signing_temp"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

signing_password=$(openssl rand -hex 32)
security list-keychains -d user > "$signing_temp/search-list.txt"
while IFS= read -r keychain; do
  keychain="${keychain#*\"}"
  keychain="${keychain%\"*}"
  if [ -n "$keychain" ]; then original_keychains+=("$keychain"); fi
done < "$signing_temp/search-list.txt"

echo 'Preparing the temporary Developer ID keychain.'
# Secrets go only into a private temporary keychain; never print decoded material.
printf '%s' "$APPLE_CERTIFICATE" | base64 --decode > "$signing_temp/certificate.p12"
security create-keychain -p "$signing_password" "$signing_keychain"
security set-keychain-settings -lut 21600 "$signing_keychain"
security unlock-keychain -p "$signing_password" "$signing_keychain"
security import "$signing_temp/certificate.p12" -P "$APPLE_CERTIFICATE_PASSWORD" \
  -t cert -f pkcs12 -k "$signing_keychain" -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$signing_password" "$signing_keychain" >/dev/null
search_list_changed=1
if [ "${#original_keychains[@]}" -gt 0 ]; then
  security list-keychains -d user -s "$signing_keychain" "${original_keychains[@]}"
else
  security list-keychains -d user -s "$signing_keychain"
fi

echo 'Checking the configured Developer ID identity.'
identities=$(security find-identity -v -p codesigning "$signing_keychain")
if ! printf '%s\n' "$identities" | grep -Fq -- "\"$APPLE_SIGNING_IDENTITY\""; then
  echo 'No valid matching Developer ID identity was imported; check certificate expiry, private key and identity configuration.' >&2
  exit 1
fi

echo 'Signing the executable and application bundle with Developer ID.'
codesign --force --options runtime --timestamp --keychain "$signing_keychain" \
  --sign "$APPLE_SIGNING_IDENTITY" "$app/Contents/MacOS/eCaptureQ"
codesign --force --options runtime --timestamp --keychain "$signing_keychain" \
  --sign "$APPLE_SIGNING_IDENTITY" "$app"
codesign --verify --deep --strict --verbose=2 "$app"

echo 'Submitting the signed application for Apple notarization.'
xcrun notarytool store-credentials ecaptureq-release --keychain "$signing_keychain" \
  --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_PASSWORD" >/dev/null
ditto -c -k --sequesterRsrc --keepParent "$app" "$signing_temp/notarize.zip"
xcrun notarytool submit "$signing_temp/notarize.zip" --keychain "$signing_keychain" \
  --keychain-profile ecaptureq-release --wait --timeout 30m
xcrun stapler staple "$app"
xcrun stapler validate "$app"
codesign --verify --deep --strict "$app"
report_signing notarized 'macOS app: Developer ID signed and notarized.'
