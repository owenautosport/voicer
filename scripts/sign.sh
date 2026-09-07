#!/usr/bin/env bash
# Sign the packaged app.
#
# Not cosmetic. macOS refuses microphone, screen recording and accessibility to
# an unsigned bundle without prompting and without erroring — it just answers
# "denied", and Voicer hears silence and sees nothing.
#
# The identity must also be stable, because TCC matches a grant against the
# signature: ad-hoc signing produces a new hash every build, so each rebuild is a
# different app and quietly drops the permissions granted to the last one.
# scripts/make-signing-identity.sh creates the stable one, once.
set -euo pipefail
cd "$(dirname "$0")/.."

APP="dist/mac/Voicer.app"
IDENTITY="${VOICER_SIGN_IDENTITY:-Voicer Dev}"

[ -d "$APP" ] || { echo "no $APP to sign — run the build first" >&2; exit 1; }

if security find-identity -v -p codesigning | grep -q "$IDENTITY"; then
  codesign --force --deep --sign "$IDENTITY" "$APP"
else
  echo "no '$IDENTITY' identity found — signing ad hoc, so every rebuild will" >&2
  echo "lose its permissions. Run scripts/make-signing-identity.sh to fix." >&2
  codesign --force --deep --sign - "$APP"
fi

codesign -dv "$APP" 2>&1 | grep -E "Identifier=|Authority=|Signature=" >&2
