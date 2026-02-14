#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import socket
import threading
import time
from pathlib import Path

HOST = "127.0.0.1"
PORT = 7777

DEFAULT_MANIFEST = {
    "daemon_version": "0.1",
    "device": {"name": "node-emulator", "version": "0.1.0", "node_id": "node-emulator-1"},
    "commands": [
        {
            "token": "L",
            "description": "Turn left",
            "args": [{"name": "intensity", "type": "int", "min": 0, "max": 255, "required": True}],
            "safety": {"rate_limit_hz": 20, "watchdog_ms": 300, "clamp": True},
            "nlp": {"synonyms": ["left", "turn left"], "examples": ["turn left 120"]},
        },
        {
            "token": "FWD",
            "description": "Move forward",
            "args": [{"name": "speed", "type": "float", "min": 0.0, "max": 1.0, "required": True}],
            "safety": {"rate_limit_hz": 10, "watchdog_ms": 500, "clamp": True},
            "nlp": {"synonyms": ["forward", "go ahead"], "examples": ["forward 0.6"]},
        },
    ],
    "telemetry": {"keys": [{"name": "uptime_ms", "type": "int", "unit": "ms"}, {"name": "last_token", "type": "string"}]},
    "transport": {"type": "serial-line-v1"},
}


class ClientState:
    def __init__(self, conn: socket.socket):
        self.conn = conn
        self.running = True
        self.telemetry_enabled = False
        self.last_token = "NONE"
        self.started = time.time()
        self.lock = threading.Lock()


def send_line(conn: socket.socket, line: str) -> None:
    conn.sendall((line + "\n").encode("utf-8"))


def parse_run(parts: list[str]):
    if len(parts) < 2:
        return None, []
    return parts[1], parts[2:]


def _manifest_line(manifest: dict) -> str:
    return f"MANIFEST {json.dumps(manifest, separators=(',', ':'))}"


def _load_manifest(path: str | None) -> dict:
    if not path:
        return DEFAULT_MANIFEST

    manifest_path = Path(path)
    raw = manifest_path.read_text(encoding="utf-8")
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        try:
            import yaml
        except ModuleNotFoundError as exc:
            raise RuntimeError("Manifest file is not valid JSON and PyYAML is not installed") from exc
        parsed = yaml.safe_load(raw)
        if not isinstance(parsed, dict):
            raise RuntimeError("Manifest file must contain a JSON/YAML object")
        return parsed


def handle_run(state: ClientState, manifest: dict, token: str, args: list[str]) -> str:
    token = token.upper()
    if token == "STOP":
        with state.lock:
            state.last_token = "STOP"
        return "OK"

    command = next((c for c in manifest.get("commands", []) if str(c.get("token", "")).upper() == token), None)
    if not command:
        return "ERR BAD_TOKEN unknown"

    expected_args = command.get("args", [])
    if len(args) != len(expected_args):
        return "ERR BAD_ARGS wrong_count"

    for idx, arg_spec in enumerate(expected_args):
        raw = args[idx]
        arg_type = str(arg_spec.get("type", "")).lower()
        if arg_type in {"int", "float"}:
            try:
                value = float(raw)
            except ValueError:
                return "ERR BAD_ARGS parse"

            min_v = arg_spec.get("min")
            max_v = arg_spec.get("max")
            if min_v is not None and value < float(min_v):
                if command["safety"].get("clamp", True):
                    value = float(min_v)
                else:
                    return "ERR RANGE low"
            if max_v is not None and value > float(max_v):
                if command["safety"].get("clamp", True):
                    value = float(max_v)
                else:
                    return "ERR RANGE high"

    with state.lock:
        state.last_token = token
    return "OK"


def telemetry_loop(state: ClientState) -> None:
    while state.running:
        if not state.telemetry_enabled:
            time.sleep(0.1)
            continue

        with state.lock:
            uptime_ms = int((time.time() - state.started) * 1000)
            last_token = state.last_token
        try:
            send_line(state.conn, f"TELEMETRY uptime_ms={uptime_ms} last_token={last_token}")
        except OSError:
            break

        for _ in range(10):
            if not state.running or not state.telemetry_enabled:
                break
            time.sleep(0.1)


def client_loop(conn: socket.socket, addr, manifest: dict) -> None:
    state = ClientState(conn)
    telemetry_thread = threading.Thread(target=telemetry_loop, args=(state,), daemon=True)
    telemetry_thread.start()
    manifest_line = _manifest_line(manifest)

    try:
        with conn:
            file = conn.makefile("r", encoding="utf-8", newline="\n")
            for raw_line in file:
                line = raw_line.strip()
                if not line:
                    continue

                parts = line.split()
                command = parts[0].upper()

                if command == "HELLO":
                    send_line(conn, manifest_line)
                elif command == "READ_MANIFEST":
                    send_line(conn, manifest_line)
                elif command == "SUB" and len(parts) >= 2 and parts[1].upper() == "TELEMETRY":
                    state.telemetry_enabled = True
                    send_line(conn, "OK")
                elif command == "UNSUB" and len(parts) >= 2 and parts[1].upper() == "TELEMETRY":
                    state.telemetry_enabled = False
                    send_line(conn, "OK")
                elif command == "STOP":
                    with state.lock:
                        state.last_token = "STOP"
                    send_line(conn, "OK")
                elif command == "RUN":
                    token, args = parse_run(parts)
                    if not token:
                        send_line(conn, "ERR BAD_ARGS missing_token")
                    else:
                        send_line(conn, handle_run(state, manifest, token, args))
                else:
                    send_line(conn, "ERR BAD_REQUEST unsupported")
    finally:
        state.running = False
        telemetry_thread.join(timeout=1.0)
        print(f"client disconnected: {addr}")


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="DAEMON Node Emulator (serial-line-v1 over TCP)")
    parser.add_argument("--host", default=HOST, help="Host interface (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=PORT, help="Port (default: 7777)")
    parser.add_argument("--manifest", default=None, help="Optional path to manifest JSON/YAML")
    return parser.parse_args()


def main() -> None:
    args = _parse_args()
    manifest = _load_manifest(args.manifest)
    print(f"DAEMON node emulator listening on {args.host}:{args.port}")
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        server.bind((args.host, args.port))
        server.listen(5)
        while True:
            conn, addr = server.accept()
            print(f"client connected: {addr}")
            threading.Thread(target=client_loop, args=(conn, addr, manifest), daemon=True).start()


if __name__ == "__main__":
    main()
