#!/usr/bin/env bash
# The built daemon in a CLEAN container: no bun, no git, no donor submodule.
# Runs in debian:12-slim.
#
#   bash ci/bundle/smoke.sh dist/poe-deck
#
# Why: "one file with no toolchain" can be checked only where there is no toolchain.
# In the bun container the same file could silently read the rest of the donor from disk.
set -euo pipefail

dir="${1:?bundle dir}"
tag='[bundle-smoke]'

for tool in bun git; do
  if command -v "$tool" > /dev/null; then
    echo "$tag ✗  the container has $tool: a no-toolchain check is not possible"; exit 1
  fi
done
[ ! -e vendor/awakened-poe-trade/renderer ] || {
  echo "$tag ✗  the donor dir is mounted: the file could read reference data from disk"; exit 1; }
echo "$tag ✓  no bun, no git, no donor on disk"

"$dir/poe-deck" --version
# Both item forms, as in E2E: with mods and without. Empty or rejected output means
# the parser or the reference data is not embedded.
for item in rare-ring-with-mods fragment-no-mods; do
  out=$("$dir/poe-deck" --check-parser "fixtures/$item.txt")
  echo "$out" | sed "s/^/$tag   /"
  echo "$out" | grep -q '^item: ' || { echo "$tag ✗  $item is not parsed"; exit 1; }
done
echo "$out" | grep -q 'no mods' || { echo "$tag ✗  the item without mods is not parsed as an item without mods"; exit 1; }
"$dir/poe-deck" --check-parser fixtures/rare-ring-with-mods.txt | grep -q 'maximum Life' \
  || { echo "$tag ✗  the item with mods shows no mods"; exit 1; }
echo "$tag ✓  the embedded parser parses both item forms"

# Map check: the default profile is embedded in the file, not read from disk.
# The empty $HOME keeps a player profile of the agent out of the check.
out=$(HOME=$(mktemp -d) "$dir/poe-deck" --check-map fixtures/conqueror-veritania-citadel-t16.txt)
echo "$out" | sed "s/^/$tag   /"
echo "$out" | grep -q '^map check \[default\]: .* run with care: 2 warnings$' \
  || { echo "$tag ✗  the map check did not mark the conqueror map with the default profile"; exit 1; }
"$dir/poe-deck" map-profile | grep -q '^deadly = ' \
  || { echo "$tag ✗  map-profile printed no deadly rule: the default profile is not embedded"; exit 1; }
echo "$tag ✓  the map check and its default profile are embedded"

# deck-verify.sh needs the price mode on the Deck. We do not touch the network here: with no argument
# it must answer with code 2, which means it is embedded in the file.
rc=0
"$dir/poe-deck" --check-price > /dev/null || rc=$?
[ "$rc" = 2 ] || { echo "$tag ✗  --check-price with no argument returned $rc, expected 2"; exit 1; }
echo "$tag ✓  --check-price mode is embedded"

# doctor in the same empty place: no session, no layout and no Steam, the network
# is cut by a proxy to a closed port, so the answer does not depend on the agent network.
# Expected: all six links as lines, a non-zero code and no stack trace.
rc=0
HTTPS_PROXY=http://127.0.0.1:9 "$dir/poe-deck" doctor > /tmp/doctor.log 2>&1 || rc=$?
sed "s/^/$tag   /" /tmp/doctor.log
[ "$rc" = 1 ] || { echo "$tag ✗  doctor without a session exited with $rc, expected 1"; exit 1; }
for link in config protocol binaries layout network league; do
  grep -qE "^(✓|✗)  $link " /tmp/doctor.log || { echo "$tag ✗  doctor did not print the link $link"; exit 1; }
done
grep -qE "^✗  network .*" /tmp/doctor.log || { echo "$tag ✗  the cut network did not give ✗ network"; exit 1; }
grep -q "fix: check Wi-Fi" /tmp/doctor.log || { echo "$tag ✗  the network link has no Wi-Fi hint"; exit 1; }
if grep -qE 'at [a-zA-Z]+ \(|\.ts:[0-9]+:[0-9]+' /tmp/doctor.log; then
  echo "$tag ✗  the doctor output has a stack trace"; exit 1
fi
[ -f "$dir/poe-deck.conf.example" ] || { echo "$tag ✗  the bundle has no example config"; exit 1; }
echo "$tag ✓  doctor: six links in words, code 1, example config in the bundle"

# The daemon itself in the same empty place: no gamescope session, no xprop. Expected:
# degradation with code 3 and words, not a stack trace (ADR 0002 § Price of the decision). This also
# shows that the built file looks for the C binaries NEXT TO ITSELF: gs-clip is in the bundle,
# and it must not be in the missing list.
rc=0
"$dir/poe-deck" > /tmp/daemon.log 2>&1 || rc=$?
sed "s/^/$tag   /" /tmp/daemon.log
[ "$rc" = 3 ] || { echo "$tag ✗  the daemon without a session exited with $rc, expected degradation with code 3"; exit 1; }
grep -q 'missing external commands: xprop$' /tmp/daemon.log \
  || { echo "$tag ✗  the missing list is not exactly xprop: gs-clip next to the file was not found?"; exit 1; }
if grep -q "gs-clip:" /tmp/daemon.log; then
  echo "$tag ✗  a hint about gs-clip although it is in place"; exit 1
fi
if grep -qE 'at [a-zA-Z]+ \(|\.ts:[0-9]+:[0-9]+' /tmp/daemon.log; then
  echo "$tag ✗  the output has a stack trace: this is a crash, not degradation"; exit 1
fi
echo "$tag ✓  without a session: code 3 and the reason in words; gs-clip found next to the file"

# Install, update over it and removal in the same empty place, in a
# clean $HOME. The container has no systemd, so systemctl and journalctl here
# are stubs that write their calls to a log: we check WHAT the installer
# puts in place and removes, and WHAT it asks of systemd. A live systemd --user is
# ci/bundle/deck-verify.sh on the Deck.
fake=$(mktemp -d)
export HOME="$fake/home" SYSTEMCTL_LOG="$fake/systemctl.log"
mkdir -p "$HOME/.local/share/Steam/controller_base"
cat > "$fake/systemctl" <<'STUB'
#!/bin/sh
echo "$*" >> "$SYSTEMCTL_LOG"
case "$*" in *is-active*) exit 3 ;; esac
exit 0
STUB
printf '#!/bin/sh\nexit 0\n' > "$fake/journalctl"
chmod +x "$fake/systemctl" "$fake/journalctl"
PATH="$fake:$PATH"

data="$HOME/.local/share/poe-deck"
unit="$HOME/.config/systemd/user/poe-deck.service"
tpl="$HOME/.local/share/Steam/controller_base/templates/controller_neptune_poe_deck.vdf"

sh "$dir/install.sh" --no-start | sed "s/^/$tag   install: /"
for f in "$data/poe-deck" "$data/gs-clip" "$data/uninstall.sh" "$data/INSTALLED" "$unit" "$tpl"; do
  [ -e "$f" ] || { echo "$tag ✗  after install there is no $f"; exit 1; }
done
grep -qx "ExecStart=$data/poe-deck" "$unit" || { echo "$tag ✗  the unit does not start the installed file"; exit 1; }
[ "$("$data/poe-deck" --version)" = "poe-deck $(cat "$dir/BUILD")" ] \
  || { echo "$tag ✗  the installed daemon reports a wrong version"; exit 1; }
cfg="$HOME/.config/poe-deck/poe-deck.conf"
if [ -f "$dir/poe-deck.conf.example" ]; then
  cmp -s "$dir/poe-deck.conf.example" "$cfg" \
    || { echo "$tag ✗  first install did not put the example into $cfg"; exit 1; }
  grep -qxF "$cfg" "$data/INSTALLED" && { echo "$tag ✗  the player config got into INSTALLED"; exit 1; }
  echo "$tag ✓  install: files, unit and template in place, version matches, config created from the example"
else
  echo "$tag ⚠  the bundle has no poe-deck.conf.example: config creation is not checked"
  echo "$tag ✓  install: files, unit and template in place, version matches"
fi

# Update over it: player settings survive it byte for byte.
mkdir -p "$HOME/.config/poe-deck"
echo "league = Standard" > "$cfg"
cp "$cfg" "$fake/config.before"
echo stale > "$data/left-from-old-version"
sh "$dir/install.sh" --no-start | sed "s/^/$tag   update: /"
cmp -s "$fake/config.before" "$cfg" \
  || { echo "$tag ✗  the update touched player settings"; exit 1; }
[ ! -e "$data/left-from-old-version" ] || { echo "$tag ✗  the update left a file of the old version"; exit 1; }
[ ! -e "$data.new" ] && [ ! -e "$data.old" ] || { echo "$tag ✗  temp dirs are left after the update"; exit 1; }
echo "$tag ✓  update: the dir is replaced as a whole, player settings are not touched"

out=$(sh "$data/uninstall.sh")
echo "$out" | sed "s/^/$tag   uninstall: /"
for f in "$data" "$unit" "$tpl"; do
  [ ! -e "$f" ] || { echo "$tag ✗  after removal $f is left"; exit 1; }
  echo "$out" | grep -qF "$f" || { echo "$tag ✗  the removed $f is not named in the output"; exit 1; }
done
grep -q -- '--user disable --now poe-deck' "$SYSTEMCTL_LOG" || { echo "$tag ✗  the unit is not stopped and not disabled"; exit 1; }
[ -f "$cfg" ] || { echo "$tag ✗  removal without --purge deleted player settings"; exit 1; }
# The "ready frame shown" mark lives in XDG_STATE_HOME. Removal without
# --purge keeps it, --purge deletes it: else a clean reinstall does not show ready.
state="$HOME/.local/state/poe-deck"
mkdir -p "$state" && : > "$state/ready-shown"
sh "$dir/uninstall.sh" > /dev/null
[ -f "$state/ready-shown" ] || { echo "$tag ✗  removal without --purge deleted the daemon state"; exit 1; }
out=$(sh "$dir/uninstall.sh" --purge)
for f in "$HOME/.config/poe-deck" "$state"; do
  [ ! -e "$f" ] || { echo "$tag ✗  --purge left $f"; exit 1; }
  echo "$out" | grep -qF "$f" || { echo "$tag ✗  --purge did not name the removed $f"; exit 1; }
done
left=$(cd "$HOME" && find . -mindepth 1 \( -name '*poe-deck*' -o -name '*poe_deck*' \) | tr '\n' ' ')
[ -z "$left" ] || { echo "$tag ✗  after --purge these are left in \$HOME: $left"; exit 1; }
echo "$tag ✓  removal: unit disabled, all installed items removed and named; settings and state only with --purge"
