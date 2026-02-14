# Node Emulator

Run:
```bash
python emulator.py
# optional flags:
# python emulator.py --host 127.0.0.1 --port 7777 --manifest /path/to/DAEMON.yml
```

If using YAML manifests, install:
```bash
python -m pip install PyYAML
```

Then connect via netcat:
```bash
nc 127.0.0.1 7777
HELLO
SUB TELEMETRY
RUN L 250
RUN FWD 0.6
STOP
UNSUB TELEMETRY
```

Protocol notes:
- `HELLO` returns `MANIFEST <json>` (never `OK`).
- `READ_MANIFEST` returns `MANIFEST <json>`.
- Telemetry is quiet by default.
- `SUB TELEMETRY` enables periodic `TELEMETRY ...` lines.
- `UNSUB TELEMETRY` disables telemetry streaming.
