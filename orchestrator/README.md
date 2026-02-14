# DAEMON Orchestrator

Local multi-node runtime glue for DAEMON node endpoints.

## Features
- Connects to multiple DAEMON nodes via TCP
- Sends `HELLO` and loads each node `MANIFEST <json>`
- Deterministic command catalog merge from the provided `--node` order
- Namespaced routing (`base.FWD`, `arm.GRIP`) with collision-safe resolution
- Executes `RUN` and `STOP` steps with optional `duration_ms`
- Optional telemetry subscription with per-node prefixed output
- Optional remote planner URL; local fallback planner if remote is unavailable
- Strict plan validation against per-node manifest command/arg schemas
- Optional localhost HTTP bridge for desktop control loop integration:
  - `POST /execute_plan`
  - `POST /stop`
  - `GET /status`

## Token collisions and namespacing
- If a token appears on one node only, unqualified token routing is allowed.
- If multiple nodes expose the same token, unqualified routing is rejected as ambiguous.
- In collisions, plans must provide explicit `target`.

## Local fallback macros
Fallback planner (when no planner URL, or planner call fails) supports deterministic open-loop macros:
- `square`: 4x `[FWD 0.6 for 1200ms, TURN +90 for 800ms]`
- `left square`: same, but `TURN -90`
- `straight line`: `FWD 0.6 for 2000ms`, then `STOP`
- `triangle`: 3x with `TURN +120` (`-120` for left triangle)

These are time-based demos. Closed-loop physical accuracy requires feedback sensors (encoders/IMU) and richer command semantics.

## Demo run
1. Start base emulator:
```bash
python3 daemon-cli/examples/node-emulator/emulator.py --port 7777 --manifest daemon-cli/examples/manifests/base.yml
```

2. Start arm emulator:
```bash
python3 daemon-cli/examples/node-emulator/emulator.py --port 7778 --manifest daemon-cli/examples/manifests/arm.yml
```

3. Run orchestrator:
```bash
python3 orchestrator/orchestrator.py \
  --node base=localhost:7777 \
  --node arm=localhost:7778 \
  --planner-url https://<domain>/api/plan
```

4. Try instructions in REPL:
- `forward then close gripper`
- `square`

5. Run without planner URL:
```bash
python3 orchestrator/orchestrator.py --node base=localhost:7777 --node arm=localhost:7778
```

## Optional flags
- `--telemetry` subscribe to all node telemetry streams
- `--planner-url https://<domain>/api/plan` call remote planner first
- `--instruction "forward then close gripper"` one-shot mode (no REPL)
- `--step-timeout 1.0` per-step RUN/STOP response timeout in seconds
- `--http-host 127.0.0.1` HTTP bridge host
- `--http-port 5055` HTTP bridge port (runs server mode)

If planner URL is down/unreachable/invalid, orchestrator prints a warning and falls back to local planning.

## HTTP bridge mode
```bash
python3 orchestrator/orchestrator.py \
  --node base=localhost:7777 \
  --node arm=localhost:7778 \
  --http-port 5055
```

- `POST /execute_plan` body: `{ "plan": [ ... ] }`
- `POST /stop` body: `{}`
- `GET /status` returns connected node summary and merged manifest

For the full blue-cube deterministic demo flow, see `orchestrator/BLUE_CUBE_RUNBOOK.md`.

## Tests
```bash
python3 -m unittest discover -s orchestrator/tests -v
```
