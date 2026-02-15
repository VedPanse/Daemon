# RC Car (Raspberry Pi + Arduino) Firmware Context

This profile splits responsibilities:
- Raspberry Pi: camera + higher-level planning
- Arduino: deterministic motor + steering control loop
- Serial protocol: newline-delimited JSON commands

Safety goals:
- Deadman timeout if command stream stalls
- Max PWM clamp
- Steering angle clamp

## DAEMON Node (generalizable hardware interface)

The desktop app talks to the local `orchestrator` only. The orchestrator talks to hardware via the
standard DAEMON node TCP protocol (`HELLO`/`MANIFEST`/`RUN`/`STOP`) driven by a node `MANIFEST`.

For this profile, the Raspberry Pi runs a node server that:
- keeps `/dev/ttyACM0` open (Arduino resets on open)
- maps high-level tokens like `FWD` + `TURN` to the Arduino's single-letter mecanum commands
- relies on the orchestrator for step timing (orchestrator sleeps `duration_ms` then sends `STOP`)
- also exposes a camera node:
  - DAEMON node protocol on `8768` (token `SNAP` for semantic visibility)
  - HTTP snapshot/MJPEG on `8081` (used by the desktop app for robot-first vision)

### Start on the Pi

For a copy-paste runbook (clone repo on Pi, start node, healthcheck), see:
`daemon-cli/firmware-code/profiles/rc_car_pi_arduino/raspberry_pi/PI_RUNBOOK.md`

Prereqs:
- `python3`
- `pyserial`: `sudo apt-get update && sudo apt-get install -y python3-serial`

Run (foreground):
```bash
python3 daemon-cli/firmware-code/profiles/rc_car_pi_arduino/raspberry_pi/mecanum_daemon_node.py \
  --serial /dev/ttyACM0 --baud 9600 --port 8765 --node-id base
```

Run (background + log):
```bash
pkill -f mecanum_daemon_node.py || true
nohup python3 daemon-cli/firmware-code/profiles/rc_car_pi_arduino/raspberry_pi/mecanum_daemon_node.py \
  --serial /dev/ttyACM0 --baud 9600 --port 8765 --node-id base > ~/mecanum_node.log 2>&1 &
ss -ltn | grep 8765
tail -n 40 ~/mecanum_node.log
```

### Connect orchestrator (on laptop)

Start orchestrator in HTTP bridge mode:
```bash
python3 orchestrator/orchestrator.py \
  --node base=vporto26.local:8765 \
  --http-port 5055
```

Then the desktop app can execute plans via `POST http://127.0.0.1:5055/execute_plan`.

### Quick health check (on laptop)
```bash
python3 tools/daemon_node_healthcheck.py --host vporto26.local --port 8765 --stop
```
