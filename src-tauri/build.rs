fn main() {
    // Tauri's generated Windows resource links the application icon, but the
    // icon file is not always included in Cargo's rebuild triggers. Watch it
    // explicitly so replacing the brand artwork refreshes the embedded .exe
    // icon instead of reusing a stale resource library.
    println!("cargo:rerun-if-changed=icons/icon.ico");
    tauri_build::build()
}
