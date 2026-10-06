# Sourced from the gxwi root, not run: what cargo needs to build gxwid against
# the `peios` crate from sibling checkouts. The packaged build gets these from
# pekit instead.
REPO="$(cd .. && pwd)"
export BINDGEN_EXTRA_CLANG_ARGS="-isystem $(gcc -print-file-name=include)"
export PEIOS_LIB_DIR="$REPO/libpeios/target/debug"
export PEIOS_INCLUDE="$REPO/libpeios/include"
export PKM_UAPI="$REPO/pkm/out/build/headers/usr/include"
export LD_LIBRARY_PATH="$REPO/libpeios/target/debug"
# ring, under rustls and rcgen, is C: gcc for the static musl server, and
# IBT and SHSTK on its objects as on everything else (packaging/build.sh).
export CC_x86_64_unknown_linux_musl=gcc
export CFLAGS="${CFLAGS:+$CFLAGS }-fcf-protection=full"
