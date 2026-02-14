# DAEMON CLI

CLI and code generation for `./daemon build`.

## Scope in this sprint
- Annotation-mode export discovery only
- DAEMON.yml schema v0.1 generation + validation
- C dispatcher/runtime generation
- Node emulator test harness

## Install dependencies
```bash
cd daemon-cli
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
```

## Run build
From a firmware repo that contains DAEMON annotations:
```bash
/path/to/daemon-cli/daemon build
```

Or with explicit path:
```bash
cd daemon-cli
./daemon build --firmware-dir examples/annotated_firmware
```

Generated files:
- `generated/DAEMON.yml`
- `generated/daemon_entry.c`
- `generated/daemon_runtime.c`
- `generated/daemon_runtime.h`
- `generated/DAEMON_INTEGRATION.md`

## Run emulator
```bash
cd daemon-cli/examples/node-emulator
python emulator.py
```

Then test quickly:
```bash
nc 127.0.0.1 7777
HELLO
READ_MANIFEST
RUN L 120
STOP
```

## Run tests
```bash
cd daemon-cli
PYTHONPATH=. python3 -m unittest discover -s tests -v
```
