use std::{env, fs, path::PathBuf};

const COMMANDS: &[&str] = &[
    "start",
    "snapshot",
    "cancel",
    "result",
    "list_models",
    "remove_model",
    "register_listener",
    "remove_listener",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();

    let target = env::var("TARGET").unwrap_or_default();
    if !target.contains("apple-ios") {
        return;
    }

    // swift-rs packages the plugin's Swift and C++ objects into one static
    // archive, but SwiftPM's transitive native link dependencies do not flow
    // into Rust's final `cc -nodefaultlibs` invocation. FluidAudio requires
    // libc++ for FastClusterWrapper and the selected NeMo text-processing
    // archive for EnglishTextNormalizer.
    println!("cargo:rustc-link-lib=c++");

    let slice = if target.ends_with("-sim") || target.starts_with("x86_64-") {
        "ios-arm64-simulator"
    } else {
        "ios-arm64"
    };
    let archive = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR is set"))
        .join("swift-rs/tauri-plugin-transcription/artifacts/fluidaudio")
        .join("NemoTextProcessing/NemoTextProcessing.xcframework")
        .join(slice)
        .join("libtext_processing_rs.a");

    if !archive.is_file() {
        panic!(
            "FluidAudio NeMo archive was not produced for {target}: {}",
            archive.display()
        );
    }
    // Give the target slice a unique name. swift-rs also exposes a macOS
    // host archive named libtext_processing_rs.a earlier in the search path;
    // linking that name directly would select the wrong architecture.
    let link_directory = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR is set"));
    let linked_archive = link_directory.join("librescript_nemo_ios.a");
    fs::copy(&archive, &linked_archive).unwrap_or_else(|error| {
        panic!(
            "failed to stage FluidAudio NeMo archive {}: {error}",
            archive.display()
        )
    });
    println!("cargo:rustc-link-search=native={}", link_directory.display());
    println!("cargo:rustc-link-lib=static=rescript_nemo_ios");
}
