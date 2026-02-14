#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import queue
import socket
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any


@dataclass
class NodeInfo:
    alias: str
    host: str
    port: int
    sock: socket.socket | None = None
    reader_thread: threading.Thread | None = None
    rx_queue: queue.Queue[str] = field(default_factory=queue.Queue)
    write_lock: threading.Lock = field(default_factory=threading.Lock)
    running: bool = False
    manifest: dict[str, Any] = field(default_factory=dict)
    node_name: str = ""
    node_id: str = ""
    telemetry_snapshot: dict[str, str] = field(default_factory=dict)


class Orchestrator:
    def __init__(self, nodes: list[NodeInfo], telemetry: bool = False, timeout_s: float = 3.0):
        self.nodes = nodes
        self.enable_telemetry = telemetry
        self.timeout_s = timeout_s
        self.catalog_qualified: dict[str, NodeInfo] = {}
        self.catalog_unqualified: dict[str, NodeInfo] = {}

    def connect_all(self) -> None:
        for node in self.nodes:
            self._connect_node(node)
        self._build_catalogs()

    def close_all(self) -> None:
        for node in self.nodes:
            node.running = False
            if node.sock is not None:
                try:
                    node.sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                try:
                    node.sock.close()
                except OSError:
                    pass

    def _reader_loop(self, node: NodeInfo) -> None:
        assert node.sock is not None
        with node.sock, node.sock.makefile("r", encoding="utf-8", newline="\n") as reader:
            while node.running:
                raw = reader.readline()
                if not raw:
                    break
                line = raw.strip()
                if not line:
                    continue

                if line.startswith("TELEMETRY "):
                    payload = line[len("TELEMETRY ") :].strip()
                    for pair in payload.split():
                        if "=" in pair:
                            k, v = pair.split("=", 1)
                            node.telemetry_snapshot[k] = v
                    if self.enable_telemetry:
                        print(f"[{node.alias}] {line}")
                    continue

                node.rx_queue.put(line)

        node.running = False

    def _connect_node(self, node: NodeInfo) -> None:
        node.sock = socket.create_connection((node.host, node.port), timeout=self.timeout_s)
        node.running = True
        node.reader_thread = threading.Thread(target=self._reader_loop, args=(node,), daemon=True)
        node.reader_thread.start()

        hello_line = self._request(node, "HELLO")
        if not hello_line.startswith("MANIFEST "):
            raise RuntimeError(f"{node.alias}: expected MANIFEST from HELLO, got: {hello_line}")

        manifest = json.loads(hello_line[len("MANIFEST ") :])
        node.manifest = manifest
        node.node_name = str(manifest.get("device", {}).get("name", node.alias))
        node.node_id = str(manifest.get("device", {}).get("node_id", node.alias))

        if self.enable_telemetry:
            ack = self._request(node, "SUB TELEMETRY")
            if ack != "OK":
                raise RuntimeError(f"{node.alias}: failed to subscribe telemetry: {ack}")

        print(
            f"connected {node.alias} -> name={node.node_name} node_id={node.node_id} commands="
            f"{','.join(cmd.get('token', '') for cmd in manifest.get('commands', []))}"
        )

    def _request(self, node: NodeInfo, line: str) -> str:
        assert node.sock is not None
        with node.write_lock:
            node.sock.sendall((line + "\n").encode("utf-8"))
        try:
            return node.rx_queue.get(timeout=self.timeout_s)
        except queue.Empty as exc:
            raise RuntimeError(f"{node.alias}: timeout waiting for response to '{line}'") from exc

    def _build_catalogs(self) -> None:
        first_owner: dict[str, NodeInfo] = {}
        duplicates: set[str] = set()

        for node in self.nodes:
            for command in node.manifest.get("commands", []):
                token = str(command.get("token", "")).upper()
                if not token:
                    continue
                self.catalog_qualified[f"{node.alias}.{token}"] = node
                if token in first_owner:
                    duplicates.add(token)
                else:
                    first_owner[token] = node

        for token, owner in first_owner.items():
            if token not in duplicates:
                self.catalog_unqualified[token] = owner

    def merged_manifest(self) -> dict[str, Any]:
        by_node: dict[str, Any] = {}
        for node in self.nodes:
            by_node[node.alias] = {
                "device": node.manifest.get("device", {}),
                "commands": node.manifest.get("commands", []),
                "telemetry": node.manifest.get("telemetry", {}),
            }

        return {
            "daemon_version": "0.1",
            "nodes": by_node,
            "catalog": {
                "qualified": sorted(self.catalog_qualified.keys()),
                "unqualified": sorted(self.catalog_unqualified.keys()),
            },
        }

    def telemetry_snapshot(self) -> dict[str, Any]:
        return {node.alias: dict(node.telemetry_snapshot) for node in self.nodes}

    def resolve_node(self, target: str | None, token: str) -> NodeInfo:
        token_u = token.upper()

        if target:
            for node in self.nodes:
                if target in {node.alias, node.node_name, node.node_id}:
                    return node
            raise RuntimeError(f"Unknown target '{target}'")

        if "." in token_u:
            prefix, bare = token_u.split(".", 1)
            for node in self.nodes:
                if prefix.lower() in {node.alias.lower(), node.node_name.lower()}:
                    return self.resolve_node(node.alias, bare)
            raise RuntimeError(f"Unknown namespaced token '{token}'")

        owner = self.catalog_unqualified.get(token_u)
        if owner:
            return owner

        matches = [node for key, node in self.catalog_qualified.items() if key.endswith(f".{token_u}")]
        if len(matches) == 1:
            return matches[0]
        if len(matches) > 1:
            raise RuntimeError(f"Ambiguous token '{token_u}', use namespaced token or target")
        raise RuntimeError(f"Token '{token_u}' not found")

    def run_step(self, step: dict[str, Any]) -> None:
        step_type = str(step.get("type", "")).upper()
        if step_type == "STOP":
            self.emergency_stop()
            return

        if step_type != "RUN":
            raise RuntimeError(f"Unsupported step type: {step_type}")

        token = str(step.get("token", "")).upper()
        target = step.get("target")
        args = step.get("args", [])
        duration_ms = step.get("duration_ms")

        node = self.resolve_node(target, token)

        wire = ["RUN", token] + [str(arg) for arg in args]
        response = self._request(node, " ".join(wire))
        if response != "OK":
            raise RuntimeError(f"{node.alias}: RUN failed -> {response}")

        if duration_ms is not None:
            delay = max(0.0, float(duration_ms) / 1000.0)
            time.sleep(delay)
            stop_resp = self._request(node, "STOP")
            if stop_resp != "OK":
                raise RuntimeError(f"{node.alias}: STOP after duration failed -> {stop_resp}")

    def execute_plan(self, plan: list[dict[str, Any]]) -> None:
        for step in plan:
            self.run_step(step)

    def emergency_stop(self) -> None:
        errors: list[str] = []
        for node in self.nodes:
            try:
                response = self._request(node, "STOP")
                if response != "OK":
                    errors.append(f"{node.alias}:{response}")
            except Exception as exc:
                errors.append(f"{node.alias}:{exc}")
        if errors:
            raise RuntimeError("Emergency stop failures: " + ", ".join(errors))


def parse_node_arg(raw: str) -> NodeInfo:
    if "=" not in raw or ":" not in raw:
        raise argparse.ArgumentTypeError("--node must be in format alias=host:port")
    alias, endpoint = raw.split("=", 1)
    host, port_raw = endpoint.rsplit(":", 1)
    if not alias or not host:
        raise argparse.ArgumentTypeError("Invalid --node value")
    try:
        port = int(port_raw)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"Invalid port in --node: {port_raw}") from exc
    return NodeInfo(alias=alias, host=host, port=port)


def call_remote_planner(planner_url: str, instruction: str, system_manifest: dict, telemetry_snapshot: dict) -> dict:
    payload = json.dumps(
        {
            "instruction": instruction,
            "system_manifest": system_manifest,
            "telemetry_snapshot": telemetry_snapshot,
        }
    ).encode("utf-8")

    request = urllib.request.Request(
        planner_url,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    with urllib.request.urlopen(request, timeout=5) as response:
        body = response.read().decode("utf-8")
    parsed = json.loads(body)
    if not isinstance(parsed, dict) or "plan" not in parsed or not isinstance(parsed["plan"], list):
        raise RuntimeError("Planner response missing plan[]")
    return parsed


def fallback_plan(instruction: str) -> dict[str, Any]:
    text = instruction.lower().strip()
    parts = [p.strip() for p in text.replace(",", " then ").split("then") if p.strip()]

    plan: list[dict[str, Any]] = []
    for part in parts if parts else [text]:
        if "forward" in part:
            plan.append({"type": "RUN", "target": "base", "token": "FWD", "args": [0.6], "duration_ms": 1000})
        if "turn left" in part or " left" in f" {part}":
            plan.append({"type": "RUN", "target": "base", "token": "TURN", "args": [-90], "duration_ms": 800})
        elif "right" in part:
            plan.append({"type": "RUN", "target": "base", "token": "TURN", "args": [90], "duration_ms": 800})

        if "open" in part:
            plan.append({"type": "RUN", "target": "arm", "token": "GRIP", "args": ["open"]})
        if "close" in part:
            plan.append({"type": "RUN", "target": "arm", "token": "GRIP", "args": ["close"]})
        if "home" in part:
            plan.append({"type": "RUN", "target": "arm", "token": "HOME", "args": []})

    if not plan:
        plan = [{"type": "STOP"}]
    else:
        plan.append({"type": "STOP"})

    return {"plan": plan}


def make_plan(
    instruction: str,
    orchestrator: Orchestrator,
    planner_url: str | None,
) -> dict[str, Any]:
    if planner_url:
        try:
            return call_remote_planner(
                planner_url,
                instruction,
                orchestrator.merged_manifest(),
                orchestrator.telemetry_snapshot(),
            )
        except (RuntimeError, urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            print(f"planner fallback: {exc}")

    return fallback_plan(instruction)


def repl(orchestrator: Orchestrator, planner_url: str | None) -> None:
    print("orchestrator ready. Type instructions, 'stop' for emergency stop, 'exit' to quit.")
    while True:
        try:
            line = input("instruction> ").strip()
        except EOFError:
            print()
            break

        if not line:
            continue
        if line.lower() in {"exit", "quit"}:
            break
        if line.lower() == "stop":
            orchestrator.emergency_stop()
            print("global stop sent")
            continue

        planned = make_plan(line, orchestrator, planner_url)
        plan = planned.get("plan", [])
        print(json.dumps(planned, indent=2))

        try:
            orchestrator.execute_plan(plan)
            print("plan executed")
        except Exception as exc:
            print(f"execution error: {exc}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="DAEMON Multi-node Orchestrator")
    parser.add_argument("--node", action="append", required=True, help="Node endpoint as alias=host:port")
    parser.add_argument("--planner-url", default=None, help="Remote planner URL (e.g. https://.../plan)")
    parser.add_argument("--telemetry", action="store_true", help="Subscribe to node telemetry and print it")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    nodes = [parse_node_arg(raw) for raw in args.node]

    orchestrator = Orchestrator(nodes=nodes, telemetry=args.telemetry)
    try:
        orchestrator.connect_all()
        repl(orchestrator, args.planner_url)
    finally:
        orchestrator.close_all()


if __name__ == "__main__":
    main()
