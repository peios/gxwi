fn main() {
    println!("cargo:rustc-link-arg-cdylib=-Wl,-soname,libgxwi.so.1");
}
