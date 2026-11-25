#!/bin/sh
# Remove poe-deck: stops and removes the unit, deletes everything that
# install.sh installed, and prints the list of what it removed.
#
#   sh ~/.local/share/poe-deck/uninstall.sh [--purge]
#
# --purge  also delete the player settings ~/.config/poe-deck/ and the daemon
#          state ~/.local/state/poe-deck/ (the "ready frame shown" mark).
#          Without the flag both stay: after a reinstall the settings load
#          as they were, and the ready frame does not show again.
#
# What to delete comes from the INSTALLED list that install.sh writes. If the
# list is missing (the install stopped before it), the default paths go.
#
# The script sits in the directory that it deletes, so the whole body is in a
# function: sh reads all of it before the first step.

set -eu

main() {
  PURGE=no
  while [ $# -gt 0 ]; do
    case "$1" in
      --purge) PURGE=yes; shift ;;
      -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
      *) echo "✗  unknown argument: $1 (usage: sh uninstall.sh [--purge])"; exit 2 ;;
    esac
  done

  DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
  CONF="${XDG_CONFIG_HOME:-$HOME/.config}"
  DEST="$DATA/poe-deck"
  UNIT="$CONF/systemd/user/poe-deck.service"
  PLAYER_CONF="$CONF/poe-deck"
  PLAYER_STATE="${XDG_STATE_HOME:-$HOME/.local/state}/poe-deck"
  TEMPLATE="${STEAM_DIR:-$HOME/.local/share/Steam}/controller_base/templates/controller_neptune_poe_deck.vdf"

  if [ -f "$DEST/INSTALLED" ]; then
    LIST=$(cat "$DEST/INSTALLED")
  else
    LIST="$DEST
$UNIT
$TEMPLATE"
  fi

  if command -v systemctl > /dev/null; then
    systemctl --user disable --now poe-deck > /dev/null 2>&1 || true
  fi

  removed=''
  for path in $LIST; do
    # Guard against a broken list: delete only what is under $HOME
    # and has our name.
    case "$path" in
      "$HOME"/*poe-deck*|"$HOME"/*poe_deck*) ;;
      *) echo "⚠  skipped, not a poe-deck path: $path"; continue ;;
    esac
    if [ -e "$path" ] || [ -L "$path" ]; then
      rm -rf "$path"
      removed="$removed
  $path"
    fi
  done

  if command -v systemctl > /dev/null; then
    systemctl --user daemon-reload 2> /dev/null || true
    systemctl --user reset-failed poe-deck > /dev/null 2>&1 || true
  fi

  if [ "$PURGE" = yes ]; then
    for path in "$PLAYER_CONF" "$PLAYER_STATE"; do
      [ -e "$path" ] || continue
      rm -rf "$path"
      removed="$removed
  $path"
    done
  fi

  if [ -n "$removed" ]; then
    echo "✓  poe-deck removed:$removed"
  else
    echo "✓  nothing to remove: poe-deck is not installed"
  fi
  if [ -e "$PLAYER_CONF" ]; then
    echo "   kept your settings: $PLAYER_CONF (sh uninstall.sh --purge removes them too)"
  fi
  echo "   a layout already applied to the game lives in your Steam account; pick another one in Controller Settings"
}

main "$@"
