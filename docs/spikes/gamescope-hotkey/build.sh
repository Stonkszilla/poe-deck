#!/usr/bin/env sh
# Builds the hotkey probe from the vendored protocol XML.
#
#   ./build.sh [DIR] [--with-mock]
#
# DIR defaults to ./build next to the source; on the Deck the caller passes
# ~/poe-deck-tools, so the binary survives the cleanup of the job workspace.
#
# One place for two environments: check.sh calls this in docker on mini, the
# Jenkinsfile calls it in distrobox on the Deck. The build recipe must not drift between them.
#
# Requires: wayland-scanner and libwayland-client (plus libwayland-server for the mock).
#   Arch/SteamOS-distrobox:  pacman -S gcc wayland
#   Debian:                  apt-get install gcc libwayland-dev
set -eu

src=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
out=$src/build
mock=0

for arg in "$@"; do
	case $arg in
	--with-mock) mock=1 ;;
	*) out=$arg ;;
	esac
done

cc=${CC:-cc}
mkdir -p "$out"

# The marshalling is generated, not stored: this guarantees that the code matches
# the XML, and that we do not bring compiled third-party code into the repository.
wayland-scanner client-header "$src/gamescope-action-binding.xml" \
	"$out/gamescope-action-binding-client-protocol.h"
wayland-scanner server-header "$src/gamescope-action-binding.xml" \
	"$out/gamescope-action-binding-server-protocol.h"
wayland-scanner private-code "$src/gamescope-action-binding.xml" \
	"$out/gamescope-action-binding-protocol.c"

# The generated code builds without -Werror: it is not ours and changes with the
# wayland-scanner version. Strict flags apply only to our files, so that nobody
# can ignore a warning in them.
$cc -O1 -I"$out" -c -o "$out/protocol.o" "$out/gamescope-action-binding-protocol.c"

$cc -O1 -Wall -Wextra -Werror -I"$out" -c -o "$out/probe.o" "$src/gs-hotkey-probe.c"
$cc -o "$out/gs-hotkey-probe" "$out/probe.o" "$out/protocol.o" -lwayland-client
echo "✓  built $out/gs-hotkey-probe"

if [ "$mock" = 1 ]; then
	$cc -O1 -Wall -Wextra -Werror -I"$out" -c -o "$out/mock.o" "$src/gs-hotkey-mock.c"
	$cc -o "$out/gs-hotkey-mock" "$out/mock.o" "$out/protocol.o" -lwayland-server
	echo "✓  built $out/gs-hotkey-mock"
fi
