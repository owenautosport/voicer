#!/usr/bin/env bash
# Create the local code-signing identity Voicer builds are signed with.
#
# Run once per machine. Everything it makes lives in the login keychain; nothing
# secret is written into the repository.
#
# Why an identity at all: macOS records a TCC grant against the app's signature.
# An ad-hoc signature is a fresh hash on every build, so each rebuild looks like
# a different app and silently loses the microphone, screen recording and
# accessibility grants you gave the last one — the System Settings row stays
# switched on while the running app is refused.
set -euo pipefail

NAME="${1:-Voicer Dev}"
DIR="$(mktemp -d)"
trap 'rm -rf "$DIR"' EXIT

if security find-identity -v -p codesigning | grep -q "$NAME"; then
  echo "'$NAME' already exists — nothing to do."
  exit 0
fi

openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
  -keyout "$DIR/key" -out "$DIR/crt" \
  -subj "/CN=$NAME/O=Voicer local development" \
  -addext "basicConstraints=critical,CA:false" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning"

openssl pkcs12 -export -out "$DIR/p12" -inkey "$DIR/key" -in "$DIR/crt" \
  -name "$NAME" -passout pass:voicer

security import "$DIR/p12" -k ~/Library/Keychains/login.keychain-db \
  -P voicer -T /usr/bin/codesign

# Self-signed certificates are not code-signing identities until trusted.
security add-trusted-cert -r trustRoot -p codeSign \
  -k ~/Library/Keychains/login.keychain-db "$DIR/crt"

security find-identity -v -p codesigning
