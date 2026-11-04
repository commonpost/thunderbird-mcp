#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost contributors (see LICENSE)
#
# Image for MCP directories that start a server to list its tools (Glama, for example): the bridge answers
# tools/list only once Thunderbird and this add-on run, so the image holds a real Thunderbird, the add-on of this
# checkout in a throw-away profile, and Xvfb. start.sh starts them, then the bridge on standard input and output.
#
# Usage, once at image build, as root, from the root of a git checkout (Debian 13, Node.js 22 or later):
#   bash scripts/inspection/setup.sh
#
# Thunderbird is checked as in the end-to-end lab (commonpost/thunderbird-mcp-lab): the GPG signature of SHA512SUMS
# must chain to Mozilla's release key, then the SHA-512 of the archive must match. The profile turns off add-on
# signature checks so that the add-on built here loads: never use it, or this image, for real mail.
set -euo pipefail

TB_VERSION=156.0.1
TB_BASE=https://archive.mozilla.org/pub/thunderbird/releases
# Primary key of "Mozilla Software Releases <release@mozilla.com>" (the KEY file of the release directory).
MOZ_RELEASE_FPR=14F26682D0916CDD81E37B6D61B7B526D98F0353
OPT=/opt/commonpost-inspection
here="$(cd "$(dirname "$0")" && pwd -P)"
root="$(cd "$here/../.." && pwd -P)"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl gnupg gpgv xz-utils \
  libgtk-3-0t64 libasound2t64 libdbus-glib-1-2 libx11-xcb1 libxtst6 libpci3 libegl1 libgl1 \
  xvfb xauth fonts-dejavu-core fontconfig
rm -rf /var/lib/apt/lists/*

dl="$(mktemp -d)"
trap 'rm -rf -- "$dl"' EXIT
url="$TB_BASE/$TB_VERSION"
f="linux-x86_64/en-US/thunderbird-$TB_VERSION.tar.xz"
get() { curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$dl/$1" "$url/$2"; }
get SHA512SUMS SHA512SUMS
get SHA512SUMS.asc SHA512SUMS.asc
get KEY KEY
gpg --batch --dearmor < "$dl/KEY" > "$dl/moz.gpg"
gpgv --status-fd 3 --keyring "$dl/moz.gpg" "$dl/SHA512SUMS.asc" "$dl/SHA512SUMS" 3> "$dl/gpg-status.txt"
grep -q '^\[GNUPG:\] GOODSIG ' "$dl/gpg-status.txt"
grep -Eq "^\[GNUPG:\] VALIDSIG [0-9A-F]{40} .* $MOZ_RELEASE_FPR\$" "$dl/gpg-status.txt"
if grep -Eq '^\[GNUPG:\] (BADSIG|ERRSIG|EXPKEYSIG|REVKEYSIG|EXPSIG) ' "$dl/gpg-status.txt"; then
  echo "signature rejected" >&2
  exit 1
fi
expected="$(awk -v f="$f" '$2 == f { print $1 }' "$dl/SHA512SUMS")"
[ "$(printf '%s\n' "$expected" | wc -l)" = 1 ] && [[ "$expected" =~ ^[0-9a-f]{128}$ ]] || {
  echo "SHA512 sum of $f missing, duplicated or invalid" >&2
  exit 1
}
get tb.tar.xz "$f"
printf '%s  %s\n' "$expected" "$dl/tb.tar.xz" | sha512sum -c -
mkdir -p /opt
tar -xJf "$dl/tb.tar.xz" -C /opt --no-same-owner
grep -qx "Version=$TB_VERSION" /opt/thunderbird/application.ini
rm -f /opt/thunderbird/updater /opt/thunderbird/updater.ini /opt/thunderbird/update-settings.ini
mkdir -p /opt/thunderbird/distribution
cp "$here/policies.json" /opt/thunderbird/distribution/policies.json

# The add-on of this checkout, built as a release is, installed in the profile template under its id.
(cd "$root" && node scripts/build-xpi-reproducible.cjs)
version="$(node -p 'require(process.argv[1]).version' "$root/extension/manifest.json")"
id="$(node -p 'require(process.argv[1]).browser_specific_settings.gecko.id' "$root/extension/manifest.json")"
mkdir -p "$OPT/profile/extensions"
cp "$root/dist/commonpost-mcp-v$version.xpi" "$OPT/profile/extensions/$id.xpi"
cp "$here/user.js" "$OPT/profile/user.js"
chmod -R a+rX "$OPT" /opt/thunderbird
/opt/thunderbird/thunderbird --version
echo "inspection image: Thunderbird $TB_VERSION, add-on $id $version"
