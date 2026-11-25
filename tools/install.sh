#!/bin/sh
# Install and update poe-deck from a release archive.
#
# There is one recipe: the player runs it from Konsole, and the job
# `poe-deck/deck-probe` runs it with MODE=DAEMON. The two cannot drift: it is
# the same script. The old tools/install-daemon.sh (sources, bun, distrobox,
# build on the Deck) became tools/dev-workspace.sh: it prepares the developer
# workspace for the PAD/POINTER/UX probes and no longer installs the daemon.
#
# The script sits in the ROOT of the unpacked archive, next to the built daemon:
#
#   tar xzf poe-deck-vX.Y.Z-steamos-x86_64.tar.gz
#   sh poe-deck-vX.Y.Z/install.sh [--no-start]
#
# --no-start  only install; do not enable or start the unit
#
# Nothing is compiled; no sudo, git or bun is needed. Everything goes to $HOME:
# the SteamOS rootfs is read-only, and only /home survives system updates.
#
#   ~/.local/share/poe-deck/                  daemon, C binaries, licenses, uninstall.sh
#   ~/.config/systemd/user/poe-deck.service   systemd --user unit
#   ~/.local/share/Steam/controller_base/templates/controller_neptune_poe_deck.vdf
#                                             Steam Input layout template
#
# A second run from a newer archive is an update: the unit stops, the
# directory is replaced as a whole, and the unit starts again. The installer
# creates the player config ~/.config/poe-deck/poe-deck.conf from the bundled
# example only on the first install, when the file does not exist yet. It
# never touches an existing one. To remove: uninstall.sh in the same directory.
#
# Output is in English: the player reads it.

set -eu

START=yes
while [ $# -gt 0 ]; do
  case "$1" in
    --no-start) START=no; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "✗  unknown argument: $1 (usage: sh install.sh [--no-start])"; exit 2 ;;
  esac
done

SRC=$(cd "$(dirname "$0")" && pwd)
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
CONF="${XDG_CONFIG_HOME:-$HOME/.config}"
DEST="$DATA/poe-deck"
UNIT="$CONF/systemd/user/poe-deck.service"
PLAYER_CONF="$CONF/poe-deck"

say() { echo ""; echo "### $1"; }

say "Checks"
[ "$(id -u)" != 0 ] || {
  echo "✗  do not run this with sudo: poe-deck installs into your home and runs as you"
  exit 1
}
[ "$(uname -m)" = x86_64 ] || { echo "✗  this build is for x86_64 (Steam Deck), this machine is $(uname -m)"; exit 1; }
[ -x "$SRC/poe-deck" ] && [ -f "$SRC/BUILD" ] || {
  echo "✗  no poe-deck executable next to this script: $SRC"
  echo "   run install.sh from the unpacked release archive, not from the source tree"
  echo "   (developer workspace from sources: tools/dev-workspace.sh)"
  exit 1
}
[ "$SRC" != "$DEST" ] || {
  echo "✗  this is the installed copy; run install.sh from a freshly unpacked archive"
  exit 1
}
command -v systemctl > /dev/null || { echo "✗  systemctl not found — poe-deck runs as a systemd user service"; exit 1; }
NEW=$(cat "$SRC/BUILD")
OLD=''
[ -f "$DEST/BUILD" ] && OLD=$(cat "$DEST/BUILD")
echo "✓  package: poe-deck $NEW"
if [ -n "$OLD" ]; then echo "   installed now: poe-deck $OLD — this run updates it"; fi

say "Stop the running daemon"
# Update over a live daemon: the file is replaced as a whole, and the old
# process must not hold the directory that is about to move away.
if systemctl --user is-active --quiet poe-deck 2>/dev/null; then
  systemctl --user stop poe-deck
  echo "✓  stopped"
else
  echo "✓  not running"
fi

say "Files in $DEST"
# The directory is built next to the old one and swapped with one mv: an
# interrupted install does not leave a half-old, half-new set.
mkdir -p "$DATA"
rm -rf "$DEST.new" "$DEST.old"
mkdir "$DEST.new"
(cd "$SRC" && tar cf - .) | (cd "$DEST.new" && tar xf -)
[ ! -e "$DEST" ] || mv "$DEST" "$DEST.old"
mv "$DEST.new" "$DEST"
rm -rf "$DEST.old"
echo "✓  poe-deck $(cat "$DEST/BUILD")"

say "Steam Input layout template"
# The layout is not entered by hand: the template goes to the Steam template
# directory, and the player applies it in the Controller Settings of the game.
TEMPLATE=''
sh "$DEST/tools/steam-template.sh" install
if sh "$DEST/tools/steam-template.sh" check > /dev/null; then
  TEMPLATE="${STEAM_DIR:-$HOME/.local/share/Steam}/controller_base/templates/controller_neptune_poe_deck.vdf"
fi

say "systemd user unit"
# graphical-session.target, not "after Game Mode": systemd has no target for
# "Game Mode is up". So Restart=always is the only honest answer. A daemon
# started before the session sees that the protocol is missing, says so in
# words and exits with code 3; after RestartSec systemd starts it again, and
# at some point the session is there. The daemon reads the session environment
# itself from /run/user/<uid>/gamescope-environment. Do not put DISPLAY in the
# unit: it does not exist yet when the unit starts.
mkdir -p "$(dirname "$UNIT")"
cat > "$UNIT" <<EOF
[Unit]
Description=poe-deck: Path of Exile price check on a Steam Deck button
After=graphical-session.target

[Service]
Type=simple
WorkingDirectory=$DEST
ExecStart=$DEST/poe-deck
Restart=always
RestartSec=15

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
echo "✓  $UNIT"

# What exactly is installed, for uninstall.sh. It removes exactly this list
# and nothing more; the player config is not in the list.
{
  echo "$DEST"
  echo "$UNIT"
  [ -z "$TEMPLATE" ] || echo "$TEMPLATE"
} > "$DEST/INSTALLED"

say "Your settings"
# The example config is copied only if the file does not exist yet: an update
# does not overwrite what the player changed. The config is not in INSTALLED:
# it belongs to the player, and only uninstall.sh --purge removes it.
if [ -f "$PLAYER_CONF/poe-deck.conf" ]; then
  echo "✓  your settings in $PLAYER_CONF/poe-deck.conf are kept as they are"
elif [ -f "$SRC/poe-deck.conf.example" ]; then
  mkdir -p "$PLAYER_CONF"
  cp "$SRC/poe-deck.conf.example" "$PLAYER_CONF/poe-deck.conf"
  chmod 644 "$PLAYER_CONF/poe-deck.conf"
  echo "✓  $PLAYER_CONF/poe-deck.conf created from the example — edit it to change the league and price source"
else
  echo "⚠  this package has no poe-deck.conf.example — defaults apply"
fi

if [ "$START" = no ]; then
  echo ""
  echo "✓  installed, not started (--no-start). Start: systemctl --user enable --now poe-deck"
  exit 0
fi

say "Start"
systemctl --user enable --now poe-deck
sleep 3
# In Desktop Mode the daemon exits with code 3 ("not a Game Mode session") and
# waits for the unit restart. This is a normal wait, not a failed install.
if systemctl --user is-active --quiet poe-deck; then
  echo "✓  poe-deck is running"
elif journalctl --user -u poe-deck -n 20 --no-pager 2>/dev/null | grep -q 'not a Game Mode session'; then
  echo "✓  poe-deck is installed and waits for Game Mode (normal in Desktop Mode)"
else
  echo "✗  the service did not come up — its log:"
  journalctl --user -u poe-deck -n 30 --no-pager || true
  exit 1
fi

echo ""
echo "Installed: poe-deck $(cat "$DEST/BUILD")"
echo "Layout:    Game Mode → Path of Exile → Controller Settings → Browse Layouts → Templates → poe-deck"
echo "Log:       journalctl --user -u poe-deck -f"
echo "Update:    run install.sh from a newer release the same way"
echo "Remove:    sh $DEST/uninstall.sh"
