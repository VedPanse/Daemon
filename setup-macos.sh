#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="$ROOT_DIR/.build"
STATE_FILE="$STATE_DIR/installed-tools.log"

mkdir -p "$STATE_DIR"

log_line() {
  local line="$1"
  echo "$(date '+%Y-%m-%d %H:%M:%S') | macos | $line" | tee -a "$STATE_FILE"
}

ensure_xcode_cli() {
  if xcode-select -p >/dev/null 2>&1; then
    log_line "xcode-cli present"
    return
  fi

  log_line "xcode-cli missing; requesting install"
  xcode-select --install || true
  echo "Complete Xcode Command Line Tools install, then re-run this script."
  exit 1
}

ensure_rust() {
  if command -v rustup >/dev/null 2>&1; then
    log_line "rustup present: $(rustup --version | head -n 1)"
  else
    log_line "installing rustup"
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  fi

  # shellcheck disable=SC1090
  source "$HOME/.cargo/env"
  rustup default stable
  log_line "rustc: $(rustc --version)"
  log_line "cargo: $(cargo --version)"
}

ensure_tauri_cli() {
  # shellcheck disable=SC1090
  source "$HOME/.cargo/env"

  if cargo tauri --version >/dev/null 2>&1; then
    log_line "tauri-cli present: $(cargo tauri --version)"
    return
  fi

  log_line "installing tauri-cli"
  cargo install tauri-cli --locked
  log_line "tauri-cli: $(cargo tauri --version)"
}

main() {
  ensure_xcode_cli
  ensure_rust
  ensure_tauri_cli
  log_line "setup complete"
}

main "$@"
