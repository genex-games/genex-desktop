// Links the official prebuilt Colyseus native core (colyseus/native-sdk) for the `native` feature.
//
// Resolution order:
//   1. GENEX_COLYSEUS_LIB_DIR: a directory holding libcolyseus.a (or the per-platform tarball's
//      lib/ with its companion archives). Nothing is downloaded. Any target.
//   2. macOS: the pinned Colyseus.xcframework.zip, sha256-verified, from GENEX_COLYSEUS_ARCHIVE
//      (a local copy of that zip) or downloaded with `curl` into OUT_DIR. Its
//      macos-arm64_x86_64/libcolyseus.a is one merged universal archive that Apple ld accepts as
//      shipped (the per-lib macOS tarball does not: zig `ar` members are not 8-byte aligned).
//   3. Anything else: fail with instructions (scripts/fetch-colyseus.sh prepares a lib dir).
//
// Nothing is linked for wasm32 or without the `native` feature.
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const COLYSEUS_VERSION: &str = "0.18.10";
const XCFRAMEWORK_URL: &str =
    "https://github.com/colyseus/native-sdk/releases/download/v0.18.10/Colyseus.xcframework.zip";
const XCFRAMEWORK_SHA256: &str = "66eb6f4ebd662e81f20e63a3c42c515159f523246238055ff55fdf6d09b09982";
const XCFRAMEWORK_MACOS_LIB: &str = "Colyseus.xcframework/macos-arm64_x86_64/libcolyseus.a";

/// The per-platform tarballs ship the core plus its dependencies as separate archives, in link order.
const SPLIT_LIBS: &[&str] = &[
    "colyseus",
    "http_zig",
    "strutil_zig",
    "system_certs_zig",
    "msgpack_builder",
    "msgpack_reader",
    "wslay",
    "mbedtls",
    "mbedx509",
    "mbedcrypto",
];

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=GENEX_COLYSEUS_LIB_DIR");
    println!("cargo:rerun-if-env-changed=GENEX_COLYSEUS_ARCHIVE");

    let native = env::var_os("CARGO_FEATURE_NATIVE").is_some();
    let arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    if !native || arch == "wasm32" {
        return;
    }
    let os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();

    let lib_dir = match env::var_os("GENEX_COLYSEUS_LIB_DIR") {
        Some(dir) => PathBuf::from(dir),
        None if os == "macos" => fetch_macos_xcframework(),
        None => panic!(
            "genex-multiplayer: no prebuilt Colyseus {COLYSEUS_VERSION} for target os `{os}` is fetched \
             automatically. Run sdks/rust/scripts/fetch-colyseus.sh <target> and set \
             GENEX_COLYSEUS_LIB_DIR to the directory it prints (see README.md)."
        ),
    };
    link(&lib_dir, &os);
}

fn link(dir: &Path, os: &str) {
    if !dir.join(lib_file_name("colyseus", os)).is_file() {
        panic!(
            "genex-multiplayer: {} has no {} (GENEX_COLYSEUS_LIB_DIR must point at the directory that holds it)",
            dir.display(),
            lib_file_name("colyseus", os)
        );
    }
    println!("cargo:rustc-link-search=native={}", dir.display());
    for lib in SPLIT_LIBS {
        if dir.join(lib_file_name(lib, os)).is_file() {
            println!("cargo:rustc-link-lib=static={lib}");
        }
    }
    match os {
        "macos" | "ios" => {
            println!("cargo:rustc-link-lib=framework=CoreFoundation");
            println!("cargo:rustc-link-lib=framework=Security");
        }
        "linux" | "android" => {
            println!("cargo:rustc-link-lib=dylib=pthread");
            println!("cargo:rustc-link-lib=dylib=m");
        }
        "windows" => {
            for lib in ["ws2_32", "advapi32", "crypt32", "kernel32"] {
                println!("cargo:rustc-link-lib=dylib={lib}");
            }
        }
        _ => {}
    }
}

fn lib_file_name(lib: &str, os: &str) -> String {
    if os == "windows" && env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        format!("{lib}.lib")
    } else {
        format!("lib{lib}.a")
    }
}

fn fetch_macos_xcframework() -> PathBuf {
    let out = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR"));
    let lib_dir = out.join(format!("colyseus-{COLYSEUS_VERSION}-macos"));
    let lib = lib_dir.join("libcolyseus.a");
    let stamp = lib_dir.join(".verified");
    if lib.is_file() && fs::read_to_string(&stamp).ok().as_deref() == Some(XCFRAMEWORK_SHA256) {
        return lib_dir;
    }
    fs::create_dir_all(&lib_dir).expect("create OUT_DIR lib dir");

    let zip = match env::var_os("GENEX_COLYSEUS_ARCHIVE") {
        Some(p) => PathBuf::from(p),
        None => {
            let zip = out.join("Colyseus.xcframework.zip");
            if !zip.is_file() || sha256_hex(&zip) != XCFRAMEWORK_SHA256 {
                let status = Command::new("curl")
                    .args(["-fsSL", "--retry", "3", "-o"])
                    .arg(&zip)
                    .arg(XCFRAMEWORK_URL)
                    .status()
                    .expect("genex-multiplayer: `curl` is needed to fetch the Colyseus xcframework");
                assert!(
                    status.success(),
                    "genex-multiplayer: downloading {XCFRAMEWORK_URL} failed"
                );
            }
            zip
        }
    };
    let digest = sha256_hex(&zip);
    assert_eq!(
        digest,
        XCFRAMEWORK_SHA256,
        "genex-multiplayer: {} has sha256 {digest}, expected the pinned Colyseus {COLYSEUS_VERSION} xcframework",
        zip.display()
    );

    let unpack = out.join("xcframework-unpack");
    let _ = fs::remove_dir_all(&unpack);
    let status = Command::new("unzip")
        .args(["-q", "-o"])
        .arg(&zip)
        .arg(XCFRAMEWORK_MACOS_LIB)
        .arg("-d")
        .arg(&unpack)
        .status()
        .expect("genex-multiplayer: `unzip` is needed to unpack the Colyseus xcframework");
    assert!(status.success(), "genex-multiplayer: unzip of {} failed", zip.display());
    fs::copy(unpack.join(XCFRAMEWORK_MACOS_LIB), &lib).expect("copy libcolyseus.a");
    let _ = fs::remove_dir_all(&unpack);
    fs::write(&stamp, XCFRAMEWORK_SHA256).expect("write verification stamp");
    lib_dir
}

#[cfg(feature = "native")]
fn sha256_hex(path: &Path) -> String {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut file = fs::File::open(path).unwrap_or_else(|e| panic!("open {}: {e}", path.display()));
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = file.read(&mut buf).expect("read archive");
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    hasher.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(not(feature = "native"))]
fn sha256_hex(_path: &Path) -> String {
    unreachable!("only the native feature fetches archives")
}
