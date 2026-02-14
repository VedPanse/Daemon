# Pi Runbook: RC Car Mecanum DAEMON Node

This runbook installs and runs the **DAEMON node server** on the Raspberry Pi that bridges:

- DAEMON node protocol over TCP (`HELLO` -> `MANIFEST`, `RUN`, `STOP`)
- Arduino mecanum sketch over serial (`/dev/ttyACM0` at `9600`)

The desktop app should talk to the **local orchestrator** (HTTP bridge). The orchestrator talks to the Pi node.

## 0) SSH Into The Pi

From your laptop:
```bash
ssh treehacks@vporto26.local
```

If `.local` is flaky, use the Pi IPv4 (on the Pi run `hostname -I`).

## 1) Install Prereqs On The Pi

```bash
sudo apt-get update
sudo apt-get install -y git python3 python3-serial
```

## 2) Clone The Repo On The Pi

Choose a folder (example uses `~/Daemon`):
```bash
cd ~
rm -rf Daemon
git clone --depth 1 https://github.com/Sachin-dot-py/Daemon Daemon
cd Daemon
```

## 3) Verify The Arduino Is Present

```bash
ls -l /dev/ttyACM* /dev/serial/by-id 2>/dev/null || true
dmesg | egrep -i 'cdc_acm|ttyACM|Arduino|error -32|enumerate' | tail -n 60
```

If `/dev/ttyACM0` is missing, fix USB/power/wiring first.

## 4) Start The DAEMON Node Server

Important: port conflicts
- If you already have an old JSON TCP bridge running on `8765`, either stop it or use a different port (recommended `8766`).

### Option A (recommended): Run node on `8766` (avoid conflicts)
```bash
pkill -f mecanum_daemon_node.py || true
nohup python3 daemon-cli/firmware-code/profiles/rc_car_pi_arduino/raspberry_pi/mecanum_daemon_node.py \
  --serial /dev/ttyACM0 --baud 9600 --port 8766 --node-id base \
  > ~/mecanum_node.log 2>&1 &
```

Verify:
```bash
ss -ltnp | egrep ':(8766)\\b' || true
tail -n 60 ~/mecanum_node.log
```

### Option B: Reuse `8765` (only if you stop the old JSON bridge)
Stop anything else on `8765`:
```bash
pkill -f mecanum_bridge_server.py || true
pkill -f mecanum_daemon_node.py || true
```

Start node on `8765`:
```bash
nohup python3 daemon-cli/firmware-code/profiles/rc_car_pi_arduino/raspberry_pi/mecanum_daemon_node.py \
  --serial /dev/ttyACM0 --baud 9600 --port 8765 --node-id base \
  > ~/mecanum_node.log 2>&1 &
```

## 5) Healthcheck From Laptop

From repo root on laptop (not on Pi):
```bash
python3 tools/daemon_node_healthcheck.py --host vporto26.local --port 8766 --stop
```

Optional smoke motion:
```bash
python3 tools/daemon_node_healthcheck.py --host vporto26.local --port 8766 --smoke-run
```

If `vporto26.local` resolution is unreliable, substitute the Pi IPv4 address.

## 6) Run The Orchestrator On Laptop (what the desktop app uses)

Start orchestrator in HTTP bridge mode on your laptop:
```bash
python3 orchestrator/orchestrator.py \
  --node base=vporto26.local:8766 \
  --http-port 5055
```

Verify:
```bash
curl -s http://127.0.0.1:5055/status | head
```

Then the desktop app can execute plans via `http://127.0.0.1:5055/execute_plan`.

## Troubleshooting

- If the Pi ethernet drops, reconnect it and re-run:
  - `ss -ltnp | egrep ':(8765|8766)\\b'`
  - `tail -n 60 ~/mecanum_node.log`
- If the node returns `ERR SERIAL ... No such file or directory: '/dev/ttyACM0'`, the Arduino disappeared.
- If your laptop healthcheck gets JSON like `{"ok": false, ...}` back, you're still hitting the *old* JSON bridge, not the DAEMON node.

