set -eu
SRC=$(pwd -P)
COMPONENT=gxwi
export CARGO_HOME="$PEKIT_OUT/cargo-home"
mkdir -p "$CARGO_HOME"
cp "$PEKIT_VENDOR_OUT/cargo-config.toml" "$CARGO_HOME/config.toml"
unset PEIOS_LIB_DIR PEIOS_INCLUDE PKM_UAPI
pkg-config --atleast-version=0.5.8 peios
export BINDGEN_EXTRA_CLANG_ARGS="-isystem $(gcc -print-file-name=include) ${BINDGEN_EXTRA_CLANG_ARGS:-}"
# ring, under rustls and rcgen, is C and assembly. The musl target has no
# compiler of its own name here, and what ring needs of libc is in the
# static musl it links; and its objects carry IBT and SHSTK like the rest, or
# the linker takes them off the whole program.
export CC_x86_64_unknown_linux_musl=gcc
export CFLAGS="${CFLAGS:+$CFLAGS }-fcf-protection=full"
export RUSTC_BOOTSTRAP=1
export RUSTFLAGS="${RUSTFLAGS:+$RUSTFLAGS }-Zcf-protection=full --remap-path-prefix=$PEKIT_WORKSPACE_ROOT=/usr/src/debug/dev.peios.$COMPONENT/.workspace --remap-path-prefix=$PEKIT_OUT_BASE=/usr/src/debug/dev.peios.$COMPONENT/.build --remap-path-prefix=$SRC=/usr/src/debug/dev.peios.$COMPONENT --remap-path-prefix=$PEKIT_VENDOR_OUT/vendor=/usr/src/debug/dev.peios.$COMPONENT/vendor"
cargo build --release --workspace --exclude gxwi-server --bins --locked --offline --target-dir "$PEKIT_OUT/target"
# The restricted worker cannot open the dynamic loader or shared libraries.
# Use the distribution's self-contained musl target, matching dev/push.sh.
RUSTFLAGS="$RUSTFLAGS -C relocation-model=pic -C link-self-contained=yes -C link-arg=-static-pie -C link-arg=-Wl,-z,ibtplt" \
  cargo build --release -p gxwi-server --target x86_64-unknown-linux-musl --locked --offline --target-dir "$PEKIT_OUT/target"
cargo build --release -p libgxwi --example hello --locked --offline --target-dir "$PEKIT_OUT/target"
/usr/libexec/peios-packaging/collect-rust-licences --licence-root "$PEKIT_OUT/licenses" --root gxwid --root gxwi-server --root gxwi-hello --root libgxwi  --notice "git+https://github.com/peios/peios-rs.git=third-party/peios-rs-LICENSE" --notice "git+https://github.com/peios/authd.git=third-party/authd-LICENSE" --expression-out "$PEKIT_OUT/license-expression"
python3 packaging/check-licenses.py "$PEKIT_OUT/license-expression"
mkdir -p "$PEKIT_OUT/usr/bin" "$PEKIT_OUT/usr/share/regman" "$PEKIT_OUT/usr/share/regim"
cp "$PEKIT_OUT/target/release/gxwid" "$PEKIT_OUT/usr/bin/gxwid"
cp "$PEKIT_OUT/target/x86_64-unknown-linux-musl/release/gxwi-server" "$PEKIT_OUT/usr/bin/gxwi-server"
cp "$PEKIT_OUT/target/release/gxwi-hello" "$PEKIT_OUT/usr/bin/gxwi-hello"
cp "$PEKIT_OUT/target/release/examples/hello" "$PEKIT_OUT/usr/bin/gxwi-hello-app"
cp gxwi.regman "$PEKIT_OUT/usr/share/regman/"
cp registry.d/*.reg "$PEKIT_OUT/usr/share/regim/"
mkdir -p "$PEKIT_OUT/usr/share/apps" "$PEKIT_OUT/usr/share/icons/base"
cp libgxwi/examples/hello/dev.peios.gxwi.hello.toml "$PEKIT_OUT/usr/share/apps/"
cp libgxwi/examples/hello/hello.svg "$PEKIT_OUT/usr/share/icons/base/dev.peios.gxwi.hello.svg"
: > "$PEKIT_OUT/.debug-sources"
split_debug() {
  component=$1
  elf=$2
  list="$PEKIT_OUT/.debug-$component"
  debugedit -b "$SRC" -d /usr/src/debug/dev.peios.$COMPONENT -l "$list" -n "$elf"
  cat "$list" >> "$PEKIT_OUT/.debug-sources"
  build_id=$(readelf -n "$elf" | sed -n 's/^[[:space:]]*Build ID: //p' | head -1)
  [ -n "$build_id" ] || {
    echo "gxwi: $elf has no build ID" >&2
    exit 1
  }
  first=$(printf %s "$build_id" | cut -c1-2)
  rest=$(printf %s "$build_id" | cut -c3-)
  debug="$PEKIT_OUT/debug/$component/usr/lib/debug/.build-id/$first/$rest.debug"
  mkdir -p "$(dirname "$debug")"
  objcopy --only-keep-debug "$elf" "$debug"
  strip --strip-unneeded "$elf"
  objcopy --add-gnu-debuglink="$debug" "$elf"
  rm -f "$list"
}

split_debug gxwi "$PEKIT_OUT/usr/bin/gxwid"
split_debug gxwi "$PEKIT_OUT/usr/bin/gxwi-server"
split_debug gxwi "$PEKIT_OUT/usr/bin/gxwi-hello"
split_debug gxwi "$PEKIT_OUT/usr/bin/gxwi-hello-app"
DEBUG_ROOT="$PEKIT_OUT/usr/src/debug/dev.peios.$COMPONENT"
mkdir -p "$DEBUG_ROOT"
tr '\0' '\n' < "$PEKIT_OUT/.debug-sources" | LC_ALL=C sort -u | while IFS= read -r rel; do
  [ -n "$rel" ] || continue
  case "$rel" in */) continue ;; esac
  case "$rel" in
    vendor/*) origin="$PEKIT_VENDOR_OUT/$rel" ;;
    *)        origin="$SRC/$rel" ;;
  esac
  [ -f "$origin" ] || continue
  mkdir -p "$DEBUG_ROOT/$(dirname "$rel")"
  cp "$origin" "$DEBUG_ROOT/$rel"
done
rm -f "$PEKIT_OUT/.debug-sources"
test -n "$(find "$DEBUG_ROOT" -type f -print -quit)"


python3 packaging/stage-sdk.py "$PEKIT_OUT"

mkdir -p "$PEKIT_OUT/usr/share/man/man1"
for manual in man/*.1; do gzip -n -9 -c "$manual" > "$PEKIT_OUT/usr/share/man/man1/$(basename "$manual").gz"; done

# musl is statically included; its notice must travel with the worker.
cp /usr/share/licenses/org.libc.musl-sysroot/COPYRIGHT "$PEKIT_OUT/licenses/musl-COPYRIGHT"
