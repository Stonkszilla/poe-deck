# Сборка C-бинарей набора для Deck: gs-hotkey-probe, gs-panel,
# gs-pointer, gs-clip. Собираются здесь, в CI, а не на Deck: у игрока нет ни
# distrobox, ни компилятора.
#
# Debian 12, а не 13 и не Arch: бинарь требует ту версию glibc, с которой его
# собрали, а на Deck своя. bookworm даёт glibc 2.36 — старше любой SteamOS 3.6+,
# так что символов новее, чем есть на Deck, в бинарях не окажется. Сами
# библиотеки (libX11, libXft, fontconfig, libwayland-client) берутся с Deck по
# soname — их ABI стабилен, проверка — `ldd` на Deck (MODE=E2E).
FROM debian:12-slim
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
    gcc libc6-dev pkg-config binutils \
    libx11-dev libxft-dev libfontconfig-dev libwayland-dev libwayland-bin \
    > /dev/null && rm -rf /var/lib/apt/lists/*
