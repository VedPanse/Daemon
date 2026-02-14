Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$StateDir = Join-Path $RootDir ".build"
$StateFile = Join-Path $StateDir "installed-tools.log"

if (!(Test-Path $StateDir)) {
  New-Item -ItemType Directory -Path $StateDir | Out-Null
}

function Write-LogLine {
  param([string]$Line)
  $Stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  $Out = "$Stamp | windows | $Line"
  Write-Host $Out
  Add-Content -Path $StateFile -Value $Out
}

function Ensure-Winget {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-LogLine "winget present"
    return
  }

  throw "winget is required on Windows to bootstrap rustup."
}

function Ensure-Rust {
  if (Get-Command rustup -ErrorAction SilentlyContinue) {
    Write-LogLine "rustup present: $(& rustup --version)"
  } else {
    Write-LogLine "installing rustup via winget"
    winget install --id Rustlang.Rustup -e --accept-package-agreements --accept-source-agreements
    $env:Path += ";$env:USERPROFILE\.cargo\bin"
  }

  & rustup default stable
  Write-LogLine "rustc: $(& rustc --version)"
  Write-LogLine "cargo: $(& cargo --version)"
}

function Ensure-TauriCli {
  $env:Path += ";$env:USERPROFILE\.cargo\bin"

  try {
    $tauriVersion = & cargo tauri --version
    Write-LogLine "tauri-cli present: $tauriVersion"
    return
  } catch {
    Write-LogLine "installing tauri-cli"
  }

  & cargo install tauri-cli --locked
  Write-LogLine "tauri-cli: $(& cargo tauri --version)"
}

Ensure-Winget
Ensure-Rust
Ensure-TauriCli
Write-LogLine "setup complete"
