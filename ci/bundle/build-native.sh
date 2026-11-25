#!/usr/bin/env bash
# C binaries of the Deck bundle → <bundle dir>. Runs in the ci/bundle/Dockerfile container.
#
#   bash ci/bundle/build-native.sh dist/poe-deck
#
# Build recipes are not duplicated: the spike build.sh builds the hotkey probe,
# src/render/build.sh builds the renderer, pointer and clipboard. Here is only what
# they do not have: a check that each binary fits the STOCK SteamOS rootfs.
set -euo pipefail

out="${1:?bundle dir}"
tag='[bundle-native]'
work=$(mktemp -d)
mkdir -p "$out"

sh docs/spikes/gamescope-hotkey/build.sh "$work/hotkey" > /dev/null
cp "$work/hotkey/gs-hotkey-probe" "$out/"
sh src/render/build.sh "$out" > /dev/null
echo "$tag ✓  built: gs-hotkey-probe gs-panel gs-pointer gs-clip"

# Direct dependencies: only what the stock SteamOS rootfs has. The list is
# closed on purpose: a new library in NEEDED means "it will not start for the player",
# and we must learn that here, not on a Deck of someone else. Transitive ones (freetype, xcb,
# expat...) come with these libraries, and their set on the Deck is complete by construction.
allowed='libX11.so.6 libXft.so.2 libfontconfig.so.1 libwayland-client.so.0 libc.so.6'
bad=0
for bin in gs-hotkey-probe gs-panel gs-pointer gs-clip; do
  needed=$(readelf -d "$out/$bin" | sed -n 's/.*Shared library: \[\(.*\)\]/\1/p' | tr '\n' ' ')
  glibc=$(objdump -T "$out/$bin" | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1)
  echo "$tag   $bin: $needed| highest glibc symbol $glibc"
  for lib in $needed; do
    case " $allowed " in
      *" $lib "*) ;;
      *) echo "$tag ✗  $bin needs $lib, which stock SteamOS may not have"; bad=1 ;;
    esac
  done
done
[ "$bad" = 0 ] || exit 1
echo "$tag ✓  direct dependencies come only from the stock rootfs: $allowed"
rm -rf "$work"
