#!/usr/bin/env bash
# The full Deck bundle: C binaries, the daemon as one file,
# the installer, a check in a clean container, an archive with sha256. It needs only
# docker: nothing is installed on the build node, as in the other stages of
# ci/Jenkinsfile.
#
#   bash ci/bundle/build.sh [dir]           default dist
#
# POE_DECK_VERSION is the release version (tag vX.Y.Z, set by ci/Jenkinsfile.release).
# Without it the version is dev-<commit>: poe-deck/checks and deck-probe build it so.
#
# Result:
#   <dir>/poe-deck-<version>/                what the player unpacks
#     install.sh uninstall.sh                install/update and removal
#     poe-deck                               daemon: bun + code + donor with indexes
#     gs-hotkey-probe gs-panel gs-pointer gs-clip
#     tools/steam-template.sh steam/         Steam Input layout template
#     LICENSE licenses/ BUILD
#   <dir>/poe-deck-<version>-steamos-x86_64.tar.gz and .sha256 next to it
#
# One recipe for three jobs: poe-deck/checks builds the bundle on each push,
# poe-deck/deck-probe (MODE=E2E, DAEMON) builds the same bundle from main before the run
# on the Deck, poe-deck/release builds it from a tag.
set -euo pipefail

out="${1:-dist}"
tag='[bundle]'
bun_image="${BUN_IMAGE:-docker.io/oven/bun:1}"
as_me=(--user "$(id -u):$(id -g)")

commit=$(git rev-parse --short HEAD)
pin=$(git -C vendor/awakened-poe-trade rev-parse --short HEAD)
version="${POE_DECK_VERSION:-dev-$commit}"
# The version goes into the file name, into --define and into the installer shell: only safe
# characters, or else the quotes somewhere below break first, not the build.
[[ "$version" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || {
  echo "$tag ✗  version \"$version\": only letters, digits, dot, hyphen and underscore are allowed"; exit 1; }
# Version and SHA: what the daemon prints as the first log line and in --version.
build="$version ($commit, donor $pin)"
name="poe-deck-$version"
set_dir="$out/$name"
echo "$tag BUILD = $build"
echo "$tag OUT   = $out/$name-steamos-x86_64.tar.gz"

rm -rf "$out"
mkdir -p "$set_dir"

docker build -q -t poe-deck-bundle:ci ci/bundle > /dev/null
docker run --rm "${as_me[@]}" -v "$PWD:/w" -w /w poe-deck-bundle:ci \
  bash ci/bundle/build-native.sh "$set_dir"

# HOME=/tmp: the substituted uid has no home directory in the image, and bun
# writes its cache there (the same trick as in ci/Jenkinsfile).
docker run --rm "${as_me[@]}" -e HOME=/tmp -e POE_DECK_BUILD="$build" \
  -v "$PWD:/w" -w /w "$bun_image" \
  bash ci/bundle/build-daemon.sh "$set_dir"

# The installer and all it puts in place except the binaries. The tree tools/ + steam/
# repeats the repository: steam-template.sh finds the template by the path ../steam/
# in both places with no changes.
install -m 755 tools/install.sh "$set_dir/install.sh"
install -m 755 tools/uninstall.sh "$set_dir/uninstall.sh"
mkdir -p "$set_dir/tools" "$set_dir/steam"
install -m 755 tools/steam-template.sh "$set_dir/tools/steam-template.sh"
install -m 644 steam/controller_neptune_poe_deck.vdf "$set_dir/steam/"
install -m 644 LICENSE "$set_dir/LICENSE"
echo "$tag ✓  installer, uninstaller, layout template and LICENSE are in the bundle"

# The clean container sees only the bundle, the fixtures and the check script itself:
# no repository, no donor, no bun.
docker run --rm "${as_me[@]}" \
  -v "$PWD/$set_dir:/w/dist/poe-deck:ro" \
  -v "$PWD/fixtures/deck:/w/fixtures:ro" \
  -v "$PWD/ci/bundle/smoke.sh:/w/smoke.sh:ro" \
  -w /w debian:12-slim bash smoke.sh dist/poe-deck

tarball="$name-steamos-x86_64.tar.gz"
tar czf "$out/$tarball" -C "$out" "$name"
(cd "$out" && sha256sum "$tarball" > "$tarball.sha256" && sha256sum -c "$tarball.sha256" > /dev/null)
echo "$tag ✓  sha256sum -c passes"

# The archive contents are checked on the archive itself, not on the dir it was
# built from: the player gets the tar, so the tar is what we check.
listing=$(tar tzf "$out/$tarball")
for f in install.sh uninstall.sh poe-deck gs-hotkey-probe gs-panel gs-pointer gs-clip BUILD LICENSE \
         tools/steam-template.sh steam/controller_neptune_poe_deck.vdf \
         licenses/poe-deck.LICENSE licenses/awakened-poe-trade.LICENSE; do
  grep -qx "$name/$f" <<< "$listing" || { echo "$tag ✗  the archive has no $f"; exit 1; }
done
# Donor attribution: the copyright line exactly as in the repository (ADR 0001).
copyright=$(grep -m1 '^Copyright' licenses/awakened-poe-trade.LICENSE)
tar xzf "$out/$tarball" -O "$name/licenses/awakened-poe-trade.LICENSE" | grep -qxF "$copyright" \
  || { echo "$tag ✗  the donor copyright line in the archive does not match the repository"; exit 1; }
echo "$tag ✓  archive contents complete; donor copyright: $copyright"
echo "$tag ✓  $out/$tarball: $(du -h "$out/$tarball" | cut -f1), sha256 $(cut -c1-16 "$out/$tarball.sha256")…"
