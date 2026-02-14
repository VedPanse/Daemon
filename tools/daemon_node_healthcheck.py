#!/usr/bin/env python3
"""
DAEMON node health checker (serial-line-v1 over TCP).

Checks:
- DNS resolution for host (shows all IPs)
- TCP connect + HELLO -> MANIFEST roundtrip
- Optional safe STOP (default on)
- Optional smoke RUN (brief forward + STOP) for a base node

This is hardware-agnostic: it verifies the standard node protocol, not a specific device.
"""

from __future__ import annotations

import argparse
import json
import socket
import sys
import time
from dataclasses import dataclass
from typing import Optional, Tuple


def eprint(*args: object) -> None:
    print(*args, file=sys.stderr)


def resolve_host(host: str, port: int) -> list[Tuple[int, Tuple]]:
    infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    out: list[Tuple[int, Tuple]] = []
    for fam, _stype, _proto, _canon, sa in infos:
        if (fam, sa) not in out:
            out.append((fam, sa))
    return out


@dataclass
class RoundtripResult:
    ok: bool
    error: Optional[str]
    raw: str


def recv_line(sock: socket.socket, timeout_s: float) -> str:
    sock.settimeout(timeout_s)
    buf = bytearray()
    while True:
        nl = buf.find(b"\n")
        if nl >= 0:
            raw = bytes(buf[:nl])
            del buf[: nl + 1]
            line = raw.decode("utf-8", "replace").strip()
            if not line:
                continue
            # Telemetry lines may show up if the node already had telemetry enabled.
            if line.startswith("TELEMETRY "):
                continue
            return line
        chunk = sock.recv(4096)
        if not chunk:
            raise RuntimeError("peer closed connection")
        buf.extend(chunk)


def request_line(host: str, port: int, request: str, timeout_s: float) -> str:
    with socket.create_connection((host, port), timeout=timeout_s) as s:
        s.sendall((request.strip() + "\n").encode("utf-8"))
        return recv_line(s, timeout_s=timeout_s)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="vporto26.local")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--timeout", type=float, default=3.0)
    ap.add_argument("--stop", action="store_true", help="Send STOP after HELLO (recommended).")
    ap.add_argument("--smoke-run", action="store_true", help="RUN FWD 0.5 for 250ms then STOP (base nodes).")
    args = ap.parse_args()

    host = args.host
    port = args.port

    print("** Resolve **")
    try:
        addrs = resolve_host(host, port)
        for fam, sa in addrs:
            fam_name = "IPv6" if fam == socket.AF_INET6 else "IPv4" if fam == socket.AF_INET else str(fam)
            print(f"- {fam_name}: {sa}")
    except Exception as exc:
        eprint(f"Resolution failed for {host}:{port}: {exc}")
        return 2

    print("\n** HELLO -> MANIFEST **")
    try:
        t0 = time.time()
        line = request_line(host, port, "HELLO", timeout_s=args.timeout)
        dt = (time.time() - t0) * 1000
        print(f"- latency_ms: {dt:.1f}")
        print(f"- raw: {line}")
        if not line.startswith("MANIFEST "):
            eprint("Expected MANIFEST ... from HELLO")
            return 3
        raw_json = line[len("MANIFEST ") :].strip()
        manifest = json.loads(raw_json)
        device = manifest.get("device", {}) if isinstance(manifest, dict) else {}
        commands = manifest.get("commands", []) if isinstance(manifest, dict) else []
        print(f"- device.name: {device.get('name')}")
        print(f"- device.node_id: {device.get('node_id')}")
        print(f"- commands: {', '.join(str(c.get('token','')) for c in commands if isinstance(c, dict))}")
    except Exception as exc:
        eprint(f"HELLO roundtrip failed: {exc}")
        return 2

    if args.stop or args.smoke_run:
        print("\n** STOP (safe) **")
        try:
            line = request_line(host, port, "STOP", timeout_s=args.timeout)
            print(f"- raw: {line}")
            if line != "OK":
                eprint("STOP failed")
                return 4
        except Exception as exc:
            eprint(f"STOP failed: {exc}")
            return 4

    if args.smoke_run:
        print("\n** Smoke RUN (FWD 0.5 for 250ms) **")
        try:
            with socket.create_connection((host, port), timeout=args.timeout) as s:
                s.sendall(b"RUN FWD 0.5\n")
                ok = recv_line(s, timeout_s=args.timeout)
                print(f"- RUN resp: {ok}")
                if ok != "OK":
                    return 5
                time.sleep(0.250)
                s.sendall(b"STOP\n")
                ok = recv_line(s, timeout_s=args.timeout)
                print(f"- STOP resp: {ok}")
                if ok != "OK":
                    return 5
        except Exception as exc:
            eprint(f"Smoke run failed: {exc}")
            return 5

    print("\nOK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

