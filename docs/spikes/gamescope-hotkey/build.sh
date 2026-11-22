#!/usr/bin/env sh
# Сборка зонда хоткея из вендоренного XML протокола.
#
#   ./build.sh [КАТАЛОГ] [--with-mock]
#
# КАТАЛОГ по умолчанию — ./build рядом с исходником; на Deck сюда передаётся
# ~/poe-deck-tools, чтобы бинарь пережил чистку workspace джоба.
#
# Одно место на два контура: check.sh зовёт это в docker на mini, Jenkinsfile —
# в distrobox на Deck. Рецепт сборки не должен разъезжаться между ними.
#
# Нужны: wayland-scanner и libwayland-client (плюс libwayland-server для мока).
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

# Маршалинг генерируется, а не хранится: гарантия, что код соответствует XML,
# и что мы не тащим в репозиторий скомпилированное чужое.
wayland-scanner client-header "$src/gamescope-action-binding.xml" \
	"$out/gamescope-action-binding-client-protocol.h"
wayland-scanner server-header "$src/gamescope-action-binding.xml" \
	"$out/gamescope-action-binding-server-protocol.h"
wayland-scanner private-code "$src/gamescope-action-binding.xml" \
	"$out/gamescope-action-binding-protocol.c"

# Сгенерированный код собирается без -Werror: он чужой и меняется с версией
# wayland-scanner. Строгость — только на наших файлах, чтобы предупреждение
# в них нельзя было проигнорировать.
$cc -O1 -I"$out" -c -o "$out/protocol.o" "$out/gamescope-action-binding-protocol.c"

$cc -O1 -Wall -Wextra -Werror -I"$out" -c -o "$out/probe.o" "$src/gs-hotkey-probe.c"
$cc -o "$out/gs-hotkey-probe" "$out/probe.o" "$out/protocol.o" -lwayland-client
echo "✓  собран $out/gs-hotkey-probe"

if [ "$mock" = 1 ]; then
	$cc -O1 -Wall -Wextra -Werror -I"$out" -c -o "$out/mock.o" "$src/gs-hotkey-mock.c"
	$cc -o "$out/gs-hotkey-mock" "$out/mock.o" "$out/protocol.o" -lwayland-server
	echo "✓  собран $out/gs-hotkey-mock"
fi
