#!/bin/sh
# Установка и обновление poe-deck из архива релиза.
#
# Рецепт один: им ставит игрок из Konsole и джоб `poe-deck/deck-probe`,
# MODE=DAEMON. Расхождения между ними быть не может — он один. Прежний
# tools/install-daemon.sh (исходники, bun, distrobox, сборка на Deck) стал
# tools/dev-workspace.sh: тот готовит рабочее место разработчика для зондов
# PAD/POINTER/UX и демон больше не ставит.
#
# Скрипт лежит в КОРНЕ распакованного архива, рядом с собранным демоном:
#
#   tar xzf poe-deck-vX.Y.Z-steamos-x86_64.tar.gz
#   sh poe-deck-vX.Y.Z/install.sh [--no-start]
#
# --no-start  только поставить, юнит не включать и не запускать
#
# Ничего не компилируется, sudo не нужен, git и bun не нужны. Всё — в $HOME:
# rootfs SteamOS read-only и переживает обновления системы только в /home.
#
#   ~/.local/share/poe-deck/                  демон, C-бинари, лицензии, uninstall.sh
#   ~/.config/systemd/user/poe-deck.service   юнит systemd --user
#   ~/.local/share/Steam/controller_base/templates/controller_neptune_poe_deck.vdf
#                                             шаблон раскладки Steam Input
#
# Повторный запуск из архива новой версии = обновление: юнит останавливается,
# каталог заменяется целиком, юнит поднимается снова. Конфиг игрока
# ~/.config/poe-deck/poe-deck.conf установщик создаёт из примера в наборе только
# при первой установке, когда файла ещё нет; существующий не трогает никогда.
# Удаление — uninstall.sh из того же каталога.
#
# Вывод — по-английски: его читает игрок (CLAUDE.md § Language).

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
# Обновление поверх живого демона: файл заменяется целиком, и старый процесс
# не должен держать каталог, который сейчас уедет.
if systemctl --user is-active --quiet poe-deck 2>/dev/null; then
  systemctl --user stop poe-deck
  echo "✓  stopped"
else
  echo "✓  not running"
fi

say "Files in $DEST"
# Каталог собирается рядом и подменяется одним mv: прерванная установка не
# оставит наполовину старый, наполовину новый набор.
mkdir -p "$DATA"
rm -rf "$DEST.new" "$DEST.old"
mkdir "$DEST.new"
(cd "$SRC" && tar cf - .) | (cd "$DEST.new" && tar xf -)
[ ! -e "$DEST" ] || mv "$DEST" "$DEST.old"
mv "$DEST.new" "$DEST"
rm -rf "$DEST.old"
echo "✓  poe-deck $(cat "$DEST/BUILD")"

say "Steam Input layout template"
# Раскладка не набирается руками: шаблон ложится в каталог шаблонов
# Steam, игрок применяет его в Controller Settings игры.
TEMPLATE=''
sh "$DEST/tools/steam-template.sh" install
if sh "$DEST/tools/steam-template.sh" check > /dev/null; then
  TEMPLATE="${STEAM_DIR:-$HOME/.local/share/Steam}/controller_base/templates/controller_neptune_poe_deck.vdf"
fi

say "systemd user unit"
# graphical-session.target, а не «после Game Mode»: цели «Game Mode поднялся» в
# systemd нет. Поэтому Restart=always — единственный честный ответ. Демон,
# запущенный до сессии, увидит отсутствие протокола, скажет об этом словами и
# выйдет с кодом 3; через RestartSec его поднимут снова, и однажды сессия уже
# будет на месте. Окружение сессии он читает сам из
# /run/user/<uid>/gamescope-environment — прописывать DISPLAY в юнит нельзя,
# на момент старта юнита его ещё не существует.
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

# Что именно поставлено — для uninstall.sh. Он удаляет ровно этот список и
# ничего сверх него; конфиг игрока в список не входит.
{
  echo "$DEST"
  echo "$UNIT"
  [ -z "$TEMPLATE" ] || echo "$TEMPLATE"
} > "$DEST/INSTALLED"

say "Your settings"
# Пример конфига ложится, только если файла ещё нет: обновление
# поверх не перетирает то, что игрок поправил. Конфиг не попадает в INSTALLED —
# он принадлежит игроку, и удаляет его только uninstall.sh --purge.
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
# В Desktop Mode демон выходит кодом 3 («это не сессия Game Mode») и ждёт
# перезапуска юнита — это штатное ожидание, а не провал установки.
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
