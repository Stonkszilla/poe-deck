#!/bin/sh
# Шаблон раскладки Steam Input poe-deck: положить, убрать, сверить.
#
# Раскладка больше не набирается руками по трём активаторам: шаблон
# кладётся в controller_base/templates каталога данных Steam, где лежат штатные
# шаблоны Valve. Расчёт — что Steam покажет его в Controller Settings → Browse
# Layouts → Templates, и игрок получит все жесты одним Apply. На живом Deck это
# ещё не сверено (ADR 0002, Ф17); не покажет — запасной путь там же.
# Файл — steam/controller_neptune_poe_deck.vdf.
#
#   sh tools/steam-template.sh install|remove|check
#
# install  положить шаблон (повторный запуск перезаписывает его новой версией)
# remove   убрать шаблон; применённую к игре раскладку не трогает — она живёт
#          в аккаунте Steam игрока, а не у нас
# check    0 — лежит ровно наша версия, 1 — нет или чужая версия
#
# Каталог данных Steam — STEAM_DIR, по умолчанию ~/.local/share/Steam (так на
# SteamOS). Всё в $HOME, sudo не нужен.

set -eu

SRC=$(cd "$(dirname "$0")/.." && pwd)/steam/controller_neptune_poe_deck.vdf
STEAM_DIR="${STEAM_DIR:-$HOME/.local/share/Steam}"
DIR="$STEAM_DIR/controller_base/templates"
DEST="$DIR/controller_neptune_poe_deck.vdf"

case "${1:-}" in
  install)
    [ -f "$SRC" ] || { echo "✗  layout template missing from the package: $SRC"; exit 1; }
    # Нет каталога Steam — не Deck или Steam ни разу не запускался. Установку
    # демона это не валит: раскладка нужна только в Game Mode.
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
