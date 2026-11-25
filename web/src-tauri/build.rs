// The on-device reader (reader/main.swift, Apple Foundation Models) is compiled here, before the app, into
// reader/bin/worldline-reader, which the bundle carries as a resource. It needs the macOS 26 SDK: on a Mac without it
// an empty file is left instead, and the app reads dropped text with its own rules alone.
use std::path::Path;
use std::process::Command;

fn main() {
  println!("cargo:rerun-if-changed=reader/main.swift");
  let out = Path::new("reader/bin/worldline-reader");
  std::fs::create_dir_all("reader/bin").expect("reader/bin");
  let ok = cfg!(target_os = "macos")
    && Command::new("xcrun")
      .args(["swiftc", "-O", "-target", "arm64-apple-macos26.0", "reader/main.swift", "-o"])
      .arg(out)
      .status()
      .map(|s| s.success())
      .unwrap_or(false);
  if !ok {
    println!("cargo:warning=the on-device reader wasn't built (no macOS 26 SDK): dropped text is read by the rules alone");
    std::fs::write(out, b"").expect("placeholder");
  }
  tauri_build::build()
}
