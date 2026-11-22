#!/bin/sh
# Один рецепт сборки gs-panel на все контуры: check.sh на mini и Jenkins на Deck.
# Разъехаться этим двум нельзя — иначе прогон на железе проверяет не тот бинарь,
# что прошёл проверку (грабля прогона #33 в спайке по хоткею).
#
#   ./build.sh [каталог назначения]     по умолчанию — рядом с исходником
set -eu

out="${1:-$(dirname "$0")}"
src="$(dirname "$0")/gs-panel.c"

# pkg-config, а не голые -l: Xft тянет за собой freetype и fontconfig, и пути к их
# заголовкам различаются между Debian (check.sh) и Arch (контейнер на Deck).
cflags=$(pkg-config --cflags xft x11)
libs=$(pkg-config --libs xft x11 fontconfig)

# shellcheck disable=SC2086
gcc -O2 -Wall -Wextra -Werror -o "$out/gs-panel" "$src" $cflags $libs
echo "✓  собран $out/gs-panel"

# Читалка указателя ставится тем же рецептом — иначе на Deck приедет рендерер
# без неё, и редактор окажется без ввода. Xft ей не нужен: только X11.
# shellcheck disable=SC2086
gcc -O2 -Wall -Wextra -Werror -o "$out/gs-pointer" "$(dirname "$0")/gs-pointer.c" \
  $(pkg-config --cflags x11) $(pkg-config --libs x11)
echo "✓  собран $out/gs-pointer"

# Читалка буфера — вместо xclip из distrobox. Тот же рецепт по той
# же причине: бинари рантайма собираются одним скриптом, и в наборе для игрока
# не может оказаться рендерера без читалки. Только X11, как у gs-pointer.
# shellcheck disable=SC2086
gcc -O2 -Wall -Wextra -Werror -o "$out/gs-clip" "$(dirname "$0")/gs-clip.c" \
  $(pkg-config --cflags x11) $(pkg-config --libs x11)
echo "✓  собран $out/gs-clip"
