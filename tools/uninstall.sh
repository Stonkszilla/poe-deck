#!/bin/sh
# Удаление poe-deck: останавливает и убирает юнит, удаляет всё, что
# поставил install.sh, и печатает список удалённого.
#
#   sh ~/.local/share/poe-deck/uninstall.sh [--purge]
#
# --purge  удалить и настройки игрока ~/.config/poe-deck/, и состояние демона
#          ~/.local/state/poe-deck/ (метка «кадр ready показан»).
#          Без флага оба остаются: при переустановке настройки подхватятся
#          как были, а кадр ready повторно не покажется.
#
# Что удалять, берётся из списка INSTALLED, который пишет install.sh. Списка
# нет (установка прервалась до него) — удаляются известные пути по умолчанию.
#
# Скрипт лежит в каталоге, который сам удаляет, поэтому всё тело — в функции:
# sh дочитывает её целиком до первого шага.

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
    # Защита от испорченного списка: удаляется только то, что лежит в $HOME
    # и называется по-нашему.
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
