#!/usr/bin/env bash
# Демон одним исполняемым файлом → <каталог набора>/poe-deck. Бежит в
# контейнере oven/bun.
#
#   bash ci/bundle/build-daemon.sh dist/poe-deck
#
# В файл вшиваются bun, код демона, парсер донора и справочники — пин с нашей
# дельтой — вместе с бинарными индексами. Игроку не нужны ни bun, ни git, ни сеть до
# GitHub — и ничего не строится при первом запуске.
set -euo pipefail

out="${1:?каталог набора}"
tag='[bundle-daemon]'
donor=vendor/awakened-poe-trade
mkdir -p "$out/licenses"

[ -f "$donor/renderer/package.json" ] || {
  echo "$tag ✗  пин донора не инициализирован: git submodule update --init $donor"; exit 1; }

bun install --frozen-lockfile > /dev/null
echo "$tag ✓  зависимости (bun $(bun --version))"

# Справочники — пин с нашей дельтой data/poe1/, вместе с индексами.
# Тот же assembleDonorData, что демон из исходников зовёт при первом запуске;
# здесь он бежит один раз, в CI, и кладёт результат в data/poe1/.public/.
bun -e "import { assembleDonorData } from './src/donor-data'; assembleDonorData({ pinPublicDir: '$donor/renderer/public/', deltaDir: 'data/poe1/en/', outPublicDir: 'data/poe1/.public/', lang: 'en' })"
echo "$tag ✓  справочники донора с дельтой и индексы собраны: $(wc -l < data/poe1/en/items.delta.ndjson) баз, $(wc -l < data/poe1/en/stats.delta.ndjson) статов из дельты"

# Строку сборки считает ci/bundle/build.sh снаружи: git в образе bun нет.
build="${POE_DECK_BUILD:?строка сборки — её задаёт ci/bundle/build.sh}"
echo "  BUILD = $build"

# --root .  — дерево в /$bunfs/root/ совпадает с деревом репозитория;
# --asset-naming без хеша — справочники лежат под своими именами, и донор
#   находит их по BASE_URL без правок в своём коде (ci/bundle/entry.ts).
bun build --compile --target=bun-linux-x64 ci/bundle/entry.ts \
  --root . --asset-naming '[dir]/[name].[ext]' \
  --define "POE_DECK_BUILD=\"$build\"" \
  --outfile "$out/poe-deck" > /dev/null
echo "$tag ✓  $out/poe-deck: $(du -h "$out/poe-deck" | cut -f1)"

# Лицензии едут вместе с кодом, который покрывают: MIT poe-deck, MIT донора
# (его парсер и справочники вшиты в файл), gamescope (XML протокола в зонде).
cp LICENSE "$out/licenses/poe-deck.LICENSE"
cp licenses/*.LICENSE "$out/licenses/"
printf '%s\n' "$build" > "$out/BUILD"
# Пример конфига игрока: установщик кладёт его в ~/.config/poe-deck,
# если там пусто, а doctor называет его путь, когда конфига нет.
cp config/poe-deck.conf.example "$out/"
echo "$tag ✓  лицензии, BUILD и пример конфига рядом"
