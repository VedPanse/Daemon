# DAEMON Orchestrator

Local multi-node runtime glue for DAEMON node endpoints.

## Features
- Connects to multiple DAEMON nodes via TCP
- Sends `HELLO` and loads each node `MANIFEST <json>`
- Merges capability catalogs with namespaced routing (`base.FWD`, `arm.GRIP`)
- Executes `RUN` and `STOP` steps with optional `duration_ms`
- Optional telemetry subscription with per-node prefixed output
- Optional remote planner URL; local fallback planner if remote is unavailable

## Demo run
0. (YAML manifest support dependency)
```bash
python -m pip install PyYAML
```

1. Run base emulator:
```bash
python daemon-cli/examples/node-emulator/emulator.py --port 7777 --manifest daemon-cli/examples/manifests/base.yml
```

2. Run arm emulator:
```bash
python daemon-cli/examples/node-emulator/emulator.py --port 7778 --manifest daemon-cli/examples/manifests/arm.yml
```

3. Run orchestrator:
```bash
python orchestrator/orchestrator.py --node base=localhost:7777 --node arm=localhost:7778
```

4. Try instruction in REPL:
```text
forward then turn left then close gripper
```

## Optional flags
- `--telemetry` subscribe to all node telemetry streams
- `--planner-url https://<vercel>/plan` call remote planner first

If planner call fails or is not provided, fallback planner is used.
