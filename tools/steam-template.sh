#!/bin/sh
# Steam Input layout template of poe-deck: install, remove, check.
#
# The layout is no longer entered by hand with three activators: the template
# goes to controller_base/templates in the Steam data directory, next to the
# stock Valve templates. The idea is that Steam shows it in Controller Settings →
# Browse Layouts → Templates, and the player gets all gestures with one Apply.
# This is not yet checked on a live Deck (ADR 0002, F17); if Steam does not show
# it, the fallback path is in the same ADR. File: steam/controller_neptune_poe_deck.vdf.
#
#   sh tools/steam-template.sh install|remove|check
#
# install  put the template in place (a second run overwrites it with the new version)
# remove   remove the template; does not touch the layout applied to the game, which
#          lives in the Steam account of the player, not with us
# check    0: exactly our version is in place, 1: missing or a different version
#
# The Steam data directory is STEAM_DIR, by default ~/.local/share/Steam (as on
# SteamOS). Everything is in $HOME, no sudo is needed.

set -eu

SRC=$(cd "$(dirname "$0")/.." && pwd)/steam/controller_neptune_poe_deck.vdf
STEAM_DIR="${STEAM_DIR:-$HOME/.local/share/Steam}"
DIR="$STEAM_DIR/controller_base/templates"
DEST="$DIR/controller_neptune_poe_deck.vdf"

case "${1:-}" in
  install)
    [ -f "$SRC" ] || { echo "✗  layout template missing from the package: $SRC"; exit 1; }
    # No Steam directory: not a Deck, or Steam never ran. This does not fail the
    # daemon install: the layout is needed only in Game Mode.
    [ -d "$STEAM_DIR/controller_base" ] || {
      echo "⚠  no $STEAM_DIR/controller_base — Steam layout template not installed"
      exit 0
    }
    mkdir -p "$DIR"
    cp "$SRC" "$DEST"
    echo "✓  Steam layout template: $DEST"
    echo "   Game Mode: Path of Exile → gear → Controller Settings → Browse Layouts → Templates → poe-deck → Apply"
    echo "   not in the list? restart Steam: Steam button → Power → Restart Steam"
    ;;
  remove)
    rm -f "$DEST"
    echo "✓  Steam layout template removed: $DEST"
    ;;
  check)
    cmp -s "$SRC" "$DEST" && { echo "✓  Steam layout template in place: $DEST"; exit 0; }
    [ -f "$DEST" ] && echo "✗  Steam layout template is a different version: $DEST" \
                   || echo "✗  Steam layout template missing: $DEST"
    exit 1
    ;;
  *)
    echo "usage: sh tools/steam-template.sh install|remove|check"
    exit 2
    ;;
esac
