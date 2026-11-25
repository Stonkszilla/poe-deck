# Builds the C binaries of the Deck bundle: gs-hotkey-probe, gs-panel,
# gs-pointer, gs-clip. They are built here, in CI, not on the Deck: the player
# has no distrobox and no compiler.
#
# Debian 12, not 13 and not Arch: a binary needs the glibc version it was
# built against, and the Deck has its own. bookworm gives glibc 2.36, older than
# any SteamOS 3.6+, so the binaries get no symbols newer than the Deck has. The
# libraries themselves (libX11, libXft, fontconfig, libwayland-client) come from
# the Deck by soname: their ABI is stable, and `ldd` on the Deck checks it (MODE=E2E).
FROM debian:12-slim
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
    gcc libc6-dev pkg-config binutils \
    libx11-dev libxft-dev libfontconfig-dev libwayland-dev libwayland-bin \
    > /dev/null && rm -rf /var/lib/apt/lists/*
