#!/usr/bin/env bash
# Набор для Deck целиком: C-бинари, демон одним файлом,
# установщик, проверка в чистом контейнере, архив с sha256. Нужен только
# docker — на сборочной ноде ничего не ставится, как и в остальных стадиях
# ci/Jenkinsfile.
#
#   bash ci/bundle/build.sh [каталог]       по умолчанию dist
#
# POE_DECK_VERSION — версия релиза (тег vX.Y.Z, его задаёт ci/Jenkinsfile.release).
# Без неё версия — dev-<коммит>: так собирают poe-deck/checks и deck-probe.
#
# Результат:
#   <каталог>/poe-deck-<версия>/             то, что распаковывает игрок
#     install.sh uninstall.sh                установка/обновление и удаление
#     poe-deck                               демон: bun + код + донор с индексами
#     gs-hotkey-probe gs-panel gs-pointer gs-clip
#     tools/steam-template.sh steam/         шаблон раскладки Steam Input
#     LICENSE licenses/ BUILD
#   <каталог>/poe-deck-<версия>-steamos-x86_64.tar.gz и .sha256 рядом
#
# Один рецепт на три джоба: poe-deck/checks собирает набор на каждый push,
# poe-deck/deck-probe (MODE=E2E, DAEMON) — тот же набор с main перед прогоном
# на Deck, poe-deck/release — по тегу.
set -euo pipefail

out="${1:-dist}"
tag='[bundle]'
bun_image="${BUN_IMAGE:-docker.io/oven/bun:1}"
as_me=(--user "$(id -u):$(id -g)")

commit=$(git rev-parse --short HEAD)
pin=$(git -C vendor/awakened-poe-trade rev-parse --short HEAD)
version="${POE_DECK_VERSION:-dev-$commit}"
# Версия едет в имя файла, в --define и в shell установщика — только безопасные
# символы, иначе первым сломается не сборка, а кавычки где-то ниже.
[[ "$version" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || {
  echo "$tag ✗  версия «$version» — только буквы, цифры, точка, дефис и подчёркивание"; exit 1; }
# Версия и SHA — то, что демон печатает первой строкой журнала и в --version.
build="$version ($commit, donor $pin)"
name="poe-deck-$version"
set_dir="$out/$name"
echo "$tag BUILD = $build"
echo "$tag OUT   = $out/$name-steamos-x86_64.tar.gz"

rm -rf "$out"
mkdir -p "$set_dir"

docker build -q -t poe-deck-bundle:ci ci/bundle > /dev/null
docker run --rm "${as_me[@]}" -v "$PWD:/w" -w /w poe-deck-bundle:ci \
  bash ci/bundle/build-native.sh "$set_dir"

# HOME=/tmp: у подставленного uid домашней директории в образе нет, а bun
# пишет туда кэш (тот же приём, что в ci/Jenkinsfile).
docker run --rm "${as_me[@]}" -e HOME=/tmp -e POE_DECK_BUILD="$build" \
  -v "$PWD:/w" -w /w "$bun_image" \
  bash ci/bundle/build-daemon.sh "$set_dir"

# Установщик и всё, что он раскладывает кроме бинарей. Дерево tools/ + steam/
# повторяет репозиторий: steam-template.sh находит шаблон по пути ../steam/
# в обоих местах без правок.
install -m 755 tools/install.sh "$set_dir/install.sh"
install -m 755 tools/uninstall.sh "$set_dir/uninstall.sh"
mkdir -p "$set_dir/tools" "$set_dir/steam"
install -m 755 tools/steam-template.sh "$set_dir/tools/steam-template.sh"
install -m 644 steam/controller_neptune_poe_deck.vdf "$set_dir/steam/"
install -m 644 LICENSE "$set_dir/LICENSE"
echo "$tag ✓  установщик, удаление, шаблон раскладки и LICENSE в наборе"

# Чистый контейнер видит только набор, фикстуры и сам скрипт проверки —
# ни репозитория, ни донора, ни bun.
docker run --rm "${as_me[@]}" \
  -v "$PWD/$set_dir:/w/dist/poe-deck:ro" \
  -v "$PWD/fixtures/deck:/w/fixtures:ro" \
  -v "$PWD/ci/bundle/smoke.sh:/w/smoke.sh:ro" \
  -w /w debian:12-slim bash smoke.sh dist/poe-deck

tarball="$name-steamos-x86_64.tar.gz"
tar czf "$out/$tarball" -C "$out" "$name"
(cd "$out" && sha256sum "$tarball" > "$tarball.sha256" && sha256sum -c "$tarball.sha256" > /dev/null)
echo "$tag ✓  sha256sum -c проходит"

# Состав архива сверяется по самому архиву, а не по каталогу, из которого он
# собран: игрок получает tar, и проверять надо его.
listing=$(tar tzf "$out/$tarball")
for f in install.sh uninstall.sh poe-deck gs-hotkey-probe gs-panel gs-pointer gs-clip BUILD LICENSE \
         tools/steam-template.sh steam/controller_neptune_poe_deck.vdf \
         licenses/poe-deck.LICENSE licenses/awakened-poe-trade.LICENSE; do
  grep -qx "$name/$f" <<< "$listing" || { echo "$tag ✗  в архиве нет $f"; exit 1; }
done
# Атрибуция донора — строка копирайта ровно как в репозитории (ADR 0001).
copyright=$(grep -m1 '^Copyright' licenses/awakened-poe-trade.LICENSE)
tar xzf "$out/$tarball" -O "$name/licenses/awakened-poe-trade.LICENSE" | grep -qxF "$copyright" \
  || { echo "$tag ✗  строка копирайта донора в архиве не совпала с репозиторием"; exit 1; }
echo "$tag ✓  состав архива полон; копирайт донора: $copyright"
echo "$tag ✓  $out/$tarball: $(du -h "$out/$tarball" | cut -f1), sha256 $(cut -c1-16 "$out/$tarball.sha256")…"
