#!/bin/sh
# One build recipe for gs-panel on every path: check.sh on mini and Jenkins on the Deck.
# The two must not drift apart. Otherwise the hardware run tests a different binary
# than the one that passed the check (the pitfall of run #33 in the hotkey spike).
#
#   ./build.sh [target directory]     default: next to the source
set -eu

out="${1:-$(dirname "$0")}"
src="$(dirname "$0")/gs-panel.c"

# pkg-config, not bare -l: Xft pulls in freetype and fontconfig, and the paths to
# their headers differ between Debian (check.sh) and Arch (the container on the Deck).
cflags=$(pkg-config --cflags xft x11)
libs=$(pkg-config --libs xft x11 fontconfig)

# shellcheck disable=SC2086
gcc -O2 -Wall -Wextra -Werror -o "$out/gs-panel" "$src" $cflags $libs
echo "✓  built $out/gs-panel"

# The pointer reader uses the same recipe. Otherwise the Deck gets a renderer
# without it, and the editor has no input. It does not need Xft: only X11.
# shellcheck disable=SC2086
gcc -O2 -Wall -Wextra -Werror -o "$out/gs-pointer" "$(dirname "$0")/gs-pointer.c" \
  $(pkg-config --cflags x11) $(pkg-config --libs x11)
echo "✓  built $out/gs-pointer"

# The clipboard reader replaces xclip from distrobox. Same recipe for the same
# reason: one script builds the runtime binaries, so the player set can never
# hold a renderer without the reader. Only X11, as for gs-pointer.
# shellcheck disable=SC2086
gcc -O2 -Wall -Wextra -Werror -o "$out/gs-clip" "$(dirname "$0")/gs-clip.c" \
  $(pkg-config --cflags x11) $(pkg-config --libs x11)
echo "✓  built $out/gs-clip"
