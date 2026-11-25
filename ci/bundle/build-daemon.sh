#!/usr/bin/env bash
# The daemon as one executable file → <bundle dir>/poe-deck. Runs in the
# oven/bun container.
#
#   bash ci/bundle/build-daemon.sh dist/poe-deck
#
# The file embeds bun, the daemon code, the donor parser and the reference data
# (the pin with our delta) together with the binary indexes. The player needs no
# bun, no git and no network access to GitHub, and nothing is built at first start.
set -euo pipefail

out="${1:?bundle dir}"
tag='[bundle-daemon]'
donor=vendor/awakened-poe-trade
mkdir -p "$out/licenses"

[ -f "$donor/renderer/package.json" ] || {
  echo "$tag ✗  donor pin is not initialized: git submodule update --init $donor"; exit 1; }

bun install --frozen-lockfile > /dev/null
echo "$tag ✓  dependencies (bun $(bun --version))"

# Reference data: the pin with our delta data/poe1/, together with the indexes.
# This is the same assembleDonorData that the daemon from source calls at first start;
# here it runs once, in CI, and puts the result into data/poe1/.public/.
bun -e "import { assembleDonorData } from './src/donor-data'; assembleDonorData({ pinPublicDir: '$donor/renderer/public/', deltaDir: 'data/poe1/en/', outPublicDir: 'data/poe1/.public/', lang: 'en' })"
echo "$tag ✓  donor reference data with delta and indexes built: $(wc -l < data/poe1/en/items.delta.ndjson) bases, $(wc -l < data/poe1/en/stats.delta.ndjson) stats from the delta"

# ci/bundle/build.sh computes the build string outside: the bun image has no git.
build="${POE_DECK_BUILD:?build string, set by ci/bundle/build.sh}"
echo "  BUILD = $build"

# --root .  the tree in /$bunfs/root/ matches the repository tree;
# --asset-naming without a hash: the reference data keeps its own names, and the
#   donor finds it by BASE_URL with no changes in its code (ci/bundle/entry.ts).
bun build --compile --target=bun-linux-x64 ci/bundle/entry.ts \
  --root . --asset-naming '[dir]/[name].[ext]' \
  --define "POE_DECK_BUILD=\"$build\"" \
  --outfile "$out/poe-deck" > /dev/null
echo "$tag ✓  $out/poe-deck: $(du -h "$out/poe-deck" | cut -f1)"

# Licenses travel with the code they cover: MIT of poe-deck, MIT of the donor
# (its parser and reference data are embedded in the file), gamescope (protocol XML in the probe).
cp LICENSE "$out/licenses/poe-deck.LICENSE"
cp licenses/*.LICENSE "$out/licenses/"
printf '%s\n' "$build" > "$out/BUILD"
# Example player config: the installer puts it into ~/.config/poe-deck
# if that is empty, and doctor names its path when there is no config.
cp config/poe-deck.conf.example "$out/"
echo "$tag ✓  licenses, BUILD and example config next to it"
