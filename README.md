# DAEMON Monorepo

DAEMON is an AI-native firmware-to-agent bridge with two components:

- `daemon-cli/`: `./daemon build` generator for firmware repos
- `desktop-app/`: desktop orchestrator/chat app for DAEMON devices over USB serial

## Monorepo layout
- All CLI build/generation logic is under `daemon-cli/`.
- All desktop app logic is under `desktop-app/`.

## How to run

### 1) Run `./daemon build` on the example firmware
```bash
cd daemon-cli/examples/annotated_firmware
../../daemon build
```
Generated files will appear in:
- `daemon-cli/examples/annotated_firmware/generated/DAEMON.yml`
- `daemon-cli/examples/annotated_firmware/generated/daemon_entry.c`
- `daemon-cli/examples/annotated_firmware/generated/daemon_runtime.c`
- `daemon-cli/examples/annotated_firmware/generated/daemon_runtime.h`
- `daemon-cli/examples/annotated_firmware/generated/DAEMON_INTEGRATION.md`
- `daemon-cli/examples/annotated_firmware/generated/daemon_manifest.json`

### 2) Run desktop app and connect
```bash
cd desktop-app
npm install
npm run tauri dev
```
In the app:
1. Click `Refresh` to list serial ports.
2. Select a device and click `Connect`.
3. The app sends `HELLO` and `READ_MANIFEST` automatically.
4. Use chat to send natural language goals and watch telemetry/log panels.

## Verification
- CLI tests:
```bash
cd daemon-cli
PYTHONPATH=. python3 -m unittest discover -s tests -v
```
- Desktop checks:
```bash
cd desktop-app
npm run build
cd src-tauri
cargo check
```
