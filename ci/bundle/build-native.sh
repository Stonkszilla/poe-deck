#!/usr/bin/env bash
# C-бинари набора для Deck → <каталог набора>. Бежит в контейнере ci/bundle/Dockerfile.
#
#   bash ci/bundle/build-native.sh dist/poe-deck
#
# Рецепты сборки не дублируются: зонд хоткея собирает свой build.sh спайка,
# рендерер, указатель и буфер — src/render/build.sh. Здесь только то, чего у
# них нет: проверка, что бинарь годится для СТОКОВОГО rootfs SteamOS.
set -euo pipefail

out="${1:?каталог набора}"
tag='[bundle-native]'
work=$(mktemp -d)
mkdir -p "$out"

sh docs/spikes/gamescope-hotkey/build.sh "$work/hotkey" > /dev/null
cp "$work/hotkey/gs-hotkey-probe" "$out/"
sh src/render/build.sh "$out" > /dev/null
echo "$tag ✓  собраны: gs-hotkey-probe gs-panel gs-pointer gs-clip"

# Прямые зависимости — только то, что есть на стоковом rootfs SteamOS. Список
# закрыт намеренно: новая библиотека в NEEDED означает «у игрока не запустится»,
# и узнать это надо здесь, а не на чужом Deck. Транзитивные (freetype, xcb,
# expat…) тянут сами эти библиотеки, их набор на Deck полон по построению.
allowed='libX11.so.6 libXft.so.2 libfontconfig.so.1 libwayland-client.so.0 libc.so.6'
bad=0
for bin in gs-hotkey-probe gs-panel gs-pointer gs-clip; do
  needed=$(readelf -d "$out/$bin" | sed -n 's/.*Shared library: \[\(.*\)\]/\1/p' | tr '\n' ' ')
  glibc=$(objdump -T "$out/$bin" | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1)
  echo "$tag   $bin: $needed| старший символ glibc $glibc"
  for lib in $needed; do
    case " $allowed " in
      *" $lib "*) ;;
      *) echo "$tag ✗  $bin тянет $lib — на стоковом SteamOS её может не быть"; bad=1 ;;
    esac
  done
done
[ "$bad" = 0 ] || exit 1
echo "$tag ✓  прямые зависимости — только из стокового rootfs: $allowed"
rm -rf "$work"
