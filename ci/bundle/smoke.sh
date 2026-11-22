#!/usr/bin/env bash
# Собранный демон в ЧИСТОМ контейнере: ни bun, ни git, ни сабмодуля донора.
# Бежит в debian:12-slim.
#
#   bash ci/bundle/smoke.sh dist/poe-deck
#
# Зачем: «один файл без тулчейна» проверяется только там, где тулчейна нет.
# В контейнере bun тот же файл мог бы молча дочитать донора с диска.
set -euo pipefail

dir="${1:?каталог набора}"
tag='[bundle-smoke]'

for tool in bun git; do
  if command -v "$tool" > /dev/null; then
    echo "$tag ✗  в контейнере есть $tool — проверка без тулчейна не получится"; exit 1
  fi
done
[ ! -e vendor/awakened-poe-trade/renderer ] || {
  echo "$tag ✗  каталог донора смонтирован — файл мог бы читать справочники с диска"; exit 1; }
echo "$tag ✓  ни bun, ни git, ни донора на диске"

"$dir/poe-deck" --version
# Обе формы предмета, как в E2E: с модами и без. Пустой или отказной вывод —
# парсер или справочники не вшились.
for item in rare-ring-with-mods fragment-no-mods; do
  out=$("$dir/poe-deck" --check-parser "fixtures/$item.txt")
  echo "$out" | sed "s/^/$tag   /"
  echo "$out" | grep -q '^item: ' || { echo "$tag ✗  $item не разобран"; exit 1; }
done
echo "$out" | grep -q 'no mods' || { echo "$tag ✗  предмет без модов разобран не как предмет без модов"; exit 1; }
"$dir/poe-deck" --check-parser fixtures/rare-ring-with-mods.txt | grep -q 'maximum Life' \
  || { echo "$tag ✗  у предмета с модами не видно модов"; exit 1; }
echo "$tag ✓  вшитый парсер разбирает обе формы предмета"

# Режим цены нужен deck-verify.sh на Deck. Сеть здесь не трогаем: без аргумента
# он обязан ответить кодом 2 — значит, в файл он вшит.
rc=0
"$dir/poe-deck" --check-price > /dev/null || rc=$?
[ "$rc" = 2 ] || { echo "$tag ✗  --check-price без аргумента вернул $rc, ожидался 2"; exit 1; }
echo "$tag ✓  режим --check-price вшит"

# doctor в той же пустоте: сессии, раскладки и Steam нет, сеть
# отрезана прокси на закрытый порт — чтобы ответ не зависел от сети агента.
# Ожидание — все шесть звеньев строкой, ненулевой код и ни одного стектрейса.
rc=0
HTTPS_PROXY=http://127.0.0.1:9 "$dir/poe-deck" doctor > /tmp/doctor.log 2>&1 || rc=$?
sed "s/^/$tag   /" /tmp/doctor.log
[ "$rc" = 1 ] || { echo "$tag ✗  doctor без сессии вышел с $rc, ожидался 1"; exit 1; }
for link in config protocol binaries layout network league; do
  grep -qE "^(✓|✗)  $link " /tmp/doctor.log || { echo "$tag ✗  doctor не напечатал звено $link"; exit 1; }
done
grep -qE "^✗  network .*" /tmp/doctor.log || { echo "$tag ✗  отрезанная сеть не дала ✗ network"; exit 1; }
grep -q "fix: check Wi-Fi" /tmp/doctor.log || { echo "$tag ✗  у сети нет совета про Wi-Fi"; exit 1; }
if grep -qE 'at [a-zA-Z]+ \(|\.ts:[0-9]+:[0-9]+' /tmp/doctor.log; then
  echo "$tag ✗  в выводе doctor стектрейс"; exit 1
fi
[ -f "$dir/poe-deck.conf.example" ] || { echo "$tag ✗  в наборе нет примера конфига"; exit 1; }
echo "$tag ✓  doctor: шесть звеньев словами, код 1, пример конфига в наборе"

# Сам демон в той же пустоте: сессии gamescope нет, xprop нет. Ожидание —
# деградация кодом 3 со словами, а не стектрейс (ADR 0002 § Цена). Заодно
# видно, что собранный файл ищет C-бинари РЯДОМ С СОБОЙ: gs-clip в наборе есть,
# и в списке нехватки его быть не должно.
rc=0
"$dir/poe-deck" > /tmp/daemon.log 2>&1 || rc=$?
sed "s/^/$tag   /" /tmp/daemon.log
[ "$rc" = 3 ] || { echo "$tag ✗  демон без сессии вышел с $rc, ожидалась деградация кодом 3"; exit 1; }
grep -q 'missing external commands: xprop$' /tmp/daemon.log \
  || { echo "$tag ✗  в нехватке не ровно xprop — gs-clip рядом с файлом не нашёлся?"; exit 1; }
if grep -q "gs-clip:" /tmp/daemon.log; then
  echo "$tag ✗  подсказка про gs-clip при том, что он на месте"; exit 1
fi
if grep -qE 'at [a-zA-Z]+ \(|\.ts:[0-9]+:[0-9]+' /tmp/daemon.log; then
  echo "$tag ✗  в выводе стектрейс — это падение, а не деградация"; exit 1
fi
echo "$tag ✓  без сессии — код 3 и причина словами; gs-clip найден рядом с файлом"

# Установка, обновление поверх и удаление — в той же пустоте, в
# чистом $HOME. systemd в контейнере нет, поэтому systemctl и journalctl здесь
# заглушки, которые пишут свои вызовы в журнал: проверяется, ЧТО установщик
# кладёт и удаляет и ЧТО он просит у systemd. Живой systemd --user —
# ci/bundle/deck-verify.sh на Deck.
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
  [ -e "$f" ] || { echo "$tag ✗  после установки нет $f"; exit 1; }
done
grep -qx "ExecStart=$data/poe-deck" "$unit" || { echo "$tag ✗  юнит запускает не установленный файл"; exit 1; }
[ "$("$data/poe-deck" --version)" = "poe-deck $(cat "$dir/BUILD")" ] \
  || { echo "$tag ✗  установленный демон говорит не ту версию"; exit 1; }
cfg="$HOME/.config/poe-deck/poe-deck.conf"
if [ -f "$dir/poe-deck.conf.example" ]; then
  cmp -s "$dir/poe-deck.conf.example" "$cfg" \
    || { echo "$tag ✗  первая установка не положила пример в $cfg"; exit 1; }
  grep -qxF "$cfg" "$data/INSTALLED" && { echo "$tag ✗  конфиг игрока попал в INSTALLED"; exit 1; }
  echo "$tag ✓  установка: файлы, юнит и шаблон на месте, версия совпала, конфиг создан из примера"
else
  echo "$tag ⚠  в наборе нет poe-deck.conf.example — создание конфига не проверено"
  echo "$tag ✓  установка: файлы, юнит и шаблон на месте, версия совпала"
fi

# Обновление поверх: настройки игрока переживают его байт в байт.
mkdir -p "$HOME/.config/poe-deck"
echo "league = Standard" > "$cfg"
cp "$cfg" "$fake/config.before"
echo stale > "$data/left-from-old-version"
sh "$dir/install.sh" --no-start | sed "s/^/$tag   update: /"
cmp -s "$fake/config.before" "$cfg" \
  || { echo "$tag ✗  обновление тронуло настройки игрока"; exit 1; }
[ ! -e "$data/left-from-old-version" ] || { echo "$tag ✗  обновление оставило файл старой версии"; exit 1; }
[ ! -e "$data.new" ] && [ ! -e "$data.old" ] || { echo "$tag ✗  после обновления остались временные каталоги"; exit 1; }
echo "$tag ✓  обновление: каталог заменён целиком, настройки игрока не тронуты"

out=$(sh "$data/uninstall.sh")
echo "$out" | sed "s/^/$tag   uninstall: /"
for f in "$data" "$unit" "$tpl"; do
  [ ! -e "$f" ] || { echo "$tag ✗  после удаления остался $f"; exit 1; }
  echo "$out" | grep -qF "$f" || { echo "$tag ✗  удалённый $f не назван в выводе"; exit 1; }
done
grep -q -- '--user disable --now poe-deck' "$SYSTEMCTL_LOG" || { echo "$tag ✗  юнит не остановлен и не выключен"; exit 1; }
[ -f "$cfg" ] || { echo "$tag ✗  удаление без --purge снесло настройки игрока"; exit 1; }
# Метка «кадр ready показан» живёт в XDG_STATE_HOME. Удаление без
# --purge её оставляет, --purge сносит: иначе чистая переустановка не покажет ready.
state="$HOME/.local/state/poe-deck"
mkdir -p "$state" && : > "$state/ready-shown"
sh "$dir/uninstall.sh" > /dev/null
[ -f "$state/ready-shown" ] || { echo "$tag ✗  удаление без --purge снесло состояние демона"; exit 1; }
out=$(sh "$dir/uninstall.sh" --purge)
for f in "$HOME/.config/poe-deck" "$state"; do
  [ ! -e "$f" ] || { echo "$tag ✗  --purge оставил $f"; exit 1; }
  echo "$out" | grep -qF "$f" || { echo "$tag ✗  --purge не назвал удалённый $f"; exit 1; }
done
left=$(cd "$HOME" && find . -mindepth 1 \( -name '*poe-deck*' -o -name '*poe_deck*' \) | tr '\n' ' ')
[ -z "$left" ] || { echo "$tag ✗  после --purge в \$HOME остались: $left"; exit 1; }
echo "$tag ✓  удаление: юнит выключен, всё поставленное удалено и названо; настройки и состояние — только с --purge"
