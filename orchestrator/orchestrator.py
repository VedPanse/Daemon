#!/usr/bin/env python3
from __future__ import annotations

import argparse
import http.server
import json
import queue
import socket
import threading
import time
import urllib.error
import urllib.request
import uuid
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
    request_lock: threading.Lock = field(default_factory=threading.Lock)
    running: bool = False
    manifest: dict[str, Any] = field(default_factory=dict)
    node_name: str = ""
    node_id: str = ""
    telemetry_snapshot: dict[str, str] = field(default_factory=dict)
    telemetry_subscribed: bool = False
    read_buffer: bytearray = field(default_factory=bytearray)


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + f".{int((time.time() % 1) * 1000):03d}Z"


def _log_event(event: str, correlation_id: str | None = None, **fields: Any) -> None:
    payload: dict[str, Any] = {
        "ts": _now_iso(),
        "event": event,
    }
    if correlation_id:
        payload["correlation_id"] = correlation_id
    payload.update(fields)
    print(json.dumps(payload), flush=True)


class Orchestrator:
    def __init__(
        self,
        nodes: list[NodeInfo],
        telemetry: bool = False,
        # mDNS `.local` lookups and first HELLO can take several seconds on some networks.
        timeout_s: float = 7.0,
        # Nodes (especially Pi->Arduino bridges) may briefly block while recovering USB/serial.
        # Keep this generous so a single slow RUN doesn't fail the whole plan.
        step_timeout_s: float = 4.0,
    ):
        self.nodes = nodes
        self.enable_telemetry = telemetry
        self.timeout_s = timeout_s
        self.step_timeout_s = step_timeout_s
        self.catalog_qualified: dict[str, NodeInfo] = {}
        self.catalog_unqualified: dict[str, NodeInfo] = {}

    def connect_all(self) -> None:
        errors: list[dict[str, str]] = []
        for node in self.nodes:
            try:
                self._connect_node(node)
            except Exception as exc:
                # Degraded mode: keep orchestrator running even if some nodes are offline.
                # The HTTP bridge + desktop app can still come up and show the status.
                errors.append({"node": node.alias, "error": str(exc)})
                node.running = False
                if node.sock is not None:
                    try:
                        node.sock.close()
                    except OSError:
                        pass
                node.sock = None
                node.manifest = {}
                node.node_name = ""
                node.node_id = ""
                _log_event("node.connect.error", node=node.alias, error=str(exc))
        self._build_catalogs()
        if errors:
            _log_event("orchestrator.connect_all.degraded", nodes_failed=len(errors), errors=errors)

    def close_all(self) -> None:
        for node in self.nodes:
            if self.enable_telemetry and node.telemetry_subscribed and node.running:
                try:
                    self._request(node, "UNSUB TELEMETRY", timeout=0.5)
                except Exception:
                    pass
                node.telemetry_subscribed = False
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
        sock = node.sock
        while node.running:
            try:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                node.read_buffer.extend(chunk)
            except TimeoutError:
                continue
            except OSError:
                break

            while True:
                newline = node.read_buffer.find(b"\n")
                if newline < 0:
                    break
                raw = bytes(node.read_buffer[:newline])
                del node.read_buffer[: newline + 1]
                line = raw.decode("utf-8", errors="replace").strip()
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
        if self.enable_telemetry:
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
            node.telemetry_subscribed = True

        print(
            f"connected {node.alias} -> name={node.node_name} node_id={node.node_id} commands="
            f"{','.join(cmd.get('token', '') for cmd in manifest.get('commands', []))}"
        )

    def _reconnect_node(self, node: NodeInfo) -> None:
        """
        Best-effort reconnect for flaky links.

        The desktop app/orchestrator can run for long periods while Pi ethernet/USB is flaky.
        When a node connection drops, we prefer to reconnect and retry the request once rather
        than failing the whole plan immediately.
        """
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
        node.sock = None
        node.rx_queue = queue.Queue()
        node.read_buffer = bytearray()
        node.telemetry_subscribed = False
        self._connect_node(node)

    def _readline_direct(self, node: NodeInfo, timeout: float) -> str:
        assert node.sock is not None
        sock = node.sock
        previous_timeout = sock.gettimeout()
        try:
            sock.settimeout(timeout)
            while True:
                newline = node.read_buffer.find(b"\n")
                if newline >= 0:
                    raw = bytes(node.read_buffer[:newline])
                    del node.read_buffer[: newline + 1]
                    line = raw.decode("utf-8", errors="replace").strip()
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
                    return line

                chunk = sock.recv(4096)
                if not chunk:
                    raise RuntimeError(f"{node.alias}: connection closed while waiting for response")
                node.read_buffer.extend(chunk)
        except TimeoutError as exc:
            raise RuntimeError(f"{node.alias}: timeout waiting for response") from exc
        except OSError as exc:
            raise RuntimeError(f"{node.alias}: socket error while waiting for response: {exc}") from exc
        finally:
            try:
                sock.settimeout(previous_timeout)
            except OSError:
                pass

    def _request(self, node: NodeInfo, line: str, timeout: float | None = None, correlation_id: str | None = None) -> str:
        if node.sock is None:
            raise RuntimeError(f"{node.alias}: not connected")

        wait = self.timeout_s if timeout is None else timeout
        _log_event("transport.tx", correlation_id, node=node.alias, line=line, timeout_s=wait)
        with node.request_lock:
            try:
                with node.write_lock:
                    node.sock.sendall((line + "\n").encode("utf-8"))
            except OSError as exc:
                # If the peer closed (Broken pipe / reset), reconnect and retry once.
                try:
                    self._reconnect_node(node)
                    assert node.sock is not None
                    with node.write_lock:
                        node.sock.sendall((line + "\n").encode("utf-8"))
                except Exception:
                    raise RuntimeError(f"{node.alias}: socket error sending '{line}': {exc}") from exc

            if self.enable_telemetry:
                try:
                    response = node.rx_queue.get(timeout=wait)
                except queue.Empty as exc:
                    raise RuntimeError(f"{node.alias}: timeout waiting for response to '{line}'") from exc
            else:
                response = self._readline_direct(node, wait)
        _log_event("transport.rx", correlation_id, node=node.alias, line=line, response=response)
        return response

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
        nodes: list[dict[str, Any]] = []
        for node in self.nodes:
            services_in = node.manifest.get("services") if isinstance(node.manifest.get("services"), dict) else {}
            services_out: dict[str, Any] = {}
            if isinstance(services_in, dict):
                for name, spec in services_in.items():
                    if not isinstance(name, str) or not isinstance(spec, dict):
                        continue
                    merged = dict(spec)
                    http_port = merged.get("http_port")
                    if isinstance(http_port, int) and http_port > 0 and "base_url" not in merged:
                        merged["base_url"] = f"http://{node.host}:{http_port}"
                    base_url = merged.get("base_url")
                    if isinstance(base_url, str) and base_url.startswith("http"):
                        snap_path = merged.get("snapshot_path")
                        mjpeg_path = merged.get("mjpeg_path")
                        if isinstance(snap_path, str) and "snapshot_url" not in merged:
                            merged["snapshot_url"] = base_url.rstrip("/") + (snap_path if snap_path.startswith("/") else f"/{snap_path}")
                        if isinstance(mjpeg_path, str) and "mjpeg_url" not in merged:
                            merged["mjpeg_url"] = base_url.rstrip("/") + (mjpeg_path if mjpeg_path.startswith("/") else f"/{mjpeg_path}")
                    services_out[name] = merged

            nodes.append(
                {
                    # Use the CLI alias as the "name" so planners return targets like "base"/"arm"/"cam",
                    # which the orchestrator can always resolve. Device names remain available as display_name.
                    "name": node.alias,
                    "node_id": node.node_id or node.alias,
                    "display_name": node.node_name or node.alias,
                    "commands": node.manifest.get("commands", []),
                    "telemetry": node.manifest.get("telemetry", {}),
                    **({"services": services_out} if services_out else {}),
                }
            )

        return {
            "daemon_version": "0.1",
            "nodes": nodes,
        }

    def telemetry_snapshot(self) -> dict[str, Any]:
        snapshot: dict[str, Any] = {}
        for node in self.nodes:
            key = node.node_name or node.alias
            snapshot[key] = dict(node.telemetry_snapshot)
        return snapshot

    def _node_from_target(self, target: str) -> NodeInfo | None:
        for node in self.nodes:
            if target in {node.alias, node.node_name, node.node_id}:
                return node
        return None

    def _command_spec(self, node: NodeInfo, token: str) -> dict[str, Any] | None:
        token_u = token.upper()
        for command in node.manifest.get("commands", []):
            if str(command.get("token", "")).upper() == token_u:
                return command
        return None

    def _is_token_ambiguous(self, token: str) -> bool:
        token_u = token.upper()
        matches = [node for key, node in self.catalog_qualified.items() if key.endswith(f".{token_u}")]
        return len(matches) > 1

    def _validate_arg_value(self, arg_value: Any, arg_spec: dict[str, Any], context: str) -> None:
        arg_type = str(arg_spec.get("type", "")).lower()

        def is_int_like(value: Any) -> bool:
            if isinstance(value, bool):
                return False
            if isinstance(value, int):
                return True
            if isinstance(value, float):
                return value.is_integer()
            if isinstance(value, str):
                try:
                    int(value)
                    return True
                except ValueError:
                    return False
            return False

        if arg_type == "int":
            if not is_int_like(arg_value):
                raise RuntimeError(f"{context}: expected int")
            numeric_value = float(int(arg_value))
        elif arg_type == "float":
            if isinstance(arg_value, bool):
                raise RuntimeError(f"{context}: expected float")
            try:
                numeric_value = float(arg_value)
            except (TypeError, ValueError) as exc:
                raise RuntimeError(f"{context}: expected float") from exc
        elif arg_type == "bool":
            if isinstance(arg_value, bool):
                numeric_value = None
            elif isinstance(arg_value, str) and arg_value.lower() in {"true", "false", "1", "0"}:
                numeric_value = None
            else:
                raise RuntimeError(f"{context}: expected bool")
        elif arg_type == "string":
            if not isinstance(arg_value, str):
                raise RuntimeError(f"{context}: expected string")
            numeric_value = None
        else:
            raise RuntimeError(f"{context}: unsupported arg type '{arg_type}'")

        allowed = arg_spec.get("enum")
        if isinstance(allowed, list) and allowed:
            if arg_value not in allowed and str(arg_value) not in [str(item) for item in allowed]:
                raise RuntimeError(f"{context}: value '{arg_value}' not in enum {allowed}")

        if numeric_value is not None:
            min_value = arg_spec.get("min")
            max_value = arg_spec.get("max")
            if min_value is not None and numeric_value < float(min_value):
                raise RuntimeError(f"{context}: value {numeric_value} < min {min_value}")
            if max_value is not None and numeric_value > float(max_value):
                raise RuntimeError(f"{context}: value {numeric_value} > max {max_value}")

    def validate_plan(self, plan: list[dict[str, Any]], correlation_id: str | None = None) -> None:
        if not isinstance(plan, list):
            raise RuntimeError("plan must be a list")
        _log_event("orchestrator.validate_plan.start", correlation_id, plan_len=len(plan))

        for index, step in enumerate(plan):
            if not isinstance(step, dict):
                raise RuntimeError(f"step[{index}] must be an object")

            step_type = str(step.get("type", "")).upper()
            if step_type not in {"RUN", "STOP"}:
                raise RuntimeError(f"step[{index}] has invalid type '{step.get('type')}'")

            if step_type == "STOP":
                continue

            target = step.get("target")
            if target is not None and (not isinstance(target, str) or not target.strip()):
                raise RuntimeError(f"step[{index}] RUN target must be a non-empty string when provided")

            token = step.get("token")
            if not isinstance(token, str) or not token.strip():
                raise RuntimeError(f"step[{index}] RUN requires non-empty string token")

            if target is None and self._is_token_ambiguous(token):
                raise RuntimeError(
                    f"step[{index}] token '{token.upper()}' is ambiguous across nodes; explicit target is required"
                )

            try:
                node = self.resolve_node(target, token)
            except RuntimeError as exc:
                raise RuntimeError(f"step[{index}] {exc}") from exc

            command_spec = self._command_spec(node, token)
            if command_spec is None:
                target_name = target if target is not None else node.alias
                raise RuntimeError(f"step[{index}] token '{token}' not found on node '{target_name}'")

            args = step.get("args", [])
            if not isinstance(args, list):
                raise RuntimeError(f"step[{index}] args must be a list")

            spec_args = command_spec.get("args", [])
            if len(args) != len(spec_args):
                raise RuntimeError(
                    f"step[{index}] token '{token}' expects {len(spec_args)} args, got {len(args)}"
                )

            for arg_index, arg_spec in enumerate(spec_args):
                self._validate_arg_value(
                    args[arg_index],
                    arg_spec,
                    context=f"step[{index}] {token} arg[{arg_index}]",
                )

            if "duration_ms" in step:
                duration_ms = step["duration_ms"]
                if isinstance(duration_ms, bool):
                    raise RuntimeError(f"step[{index}] duration_ms must be numeric")
                try:
                    duration = float(duration_ms)
                except (TypeError, ValueError) as exc:
                    raise RuntimeError(f"step[{index}] duration_ms must be numeric") from exc
                if duration < 0:
                    raise RuntimeError(f"step[{index}] duration_ms must be >= 0")
                step["duration_ms"] = duration
        _log_event("orchestrator.validate_plan.ok", correlation_id, plan_len=len(plan))

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

    def run_step(self, step: dict[str, Any], correlation_id: str | None = None) -> None:
        step_type = str(step.get("type", "")).upper()
        if step_type == "STOP":
            _log_event("orchestrator.run_step.stop", correlation_id)
            self.emergency_stop(correlation_id=correlation_id)
            return

        if step_type != "RUN":
            raise RuntimeError(f"Unsupported step type: {step_type}")

        token = str(step.get("token", "")).upper()
        target = step.get("target")
        args = step.get("args", [])
        duration_ms = step.get("duration_ms")

        node = self.resolve_node(target, token)
        _log_event(
            "orchestrator.run_step.start",
            correlation_id,
            target=target,
            resolved_node=node.alias,
            token=token,
            args=args,
            duration_ms=duration_ms,
        )

        wire = ["RUN", token] + [str(arg) for arg in args]
        response = self._request(node, " ".join(wire), timeout=self.step_timeout_s, correlation_id=correlation_id)
        if response != "OK":
            raise RuntimeError(f"{node.alias}: RUN failed -> {response}")

        if duration_ms is not None:
            delay = max(0.0, float(duration_ms) / 1000.0)
            time.sleep(delay)
            stop_resp = self._request(node, "STOP", timeout=self.step_timeout_s, correlation_id=correlation_id)
            if stop_resp != "OK":
                raise RuntimeError(f"{node.alias}: STOP after duration failed -> {stop_resp}")
        _log_event("orchestrator.run_step.ok", correlation_id, token=token, node=node.alias)

    def execute_plan(self, plan: list[dict[str, Any]], correlation_id: str | None = None) -> None:
        _log_event("orchestrator.execute_plan.start", correlation_id, plan_len=len(plan))
        for index, step in enumerate(plan):
            try:
                self.run_step(step, correlation_id=correlation_id)
            except Exception as exc:
                try:
                    self.emergency_stop(correlation_id=correlation_id)
                except Exception as stop_exc:
                    raise RuntimeError(f"step[{index}] failed: {exc}; panic STOP failed: {stop_exc}") from exc
                raise RuntimeError(f"step[{index}] failed: {exc}; panic STOP sent") from exc
        _log_event("orchestrator.execute_plan.ok", correlation_id, plan_len=len(plan))

    def emergency_stop(self, correlation_id: str | None = None) -> None:
        _log_event("orchestrator.emergency_stop.start", correlation_id)
        for node in self.nodes:
            try:
                if node.sock is None:
                    print(f"stop warning [{node.alias}]: socket not connected")
                    continue
                # STOP can block briefly if a node is recovering USB/serial; keep this > typical reset delay.
                response = self._request(node, "STOP", timeout=2.5, correlation_id=correlation_id)
                if response != "OK":
                    print(f"stop warning [{node.alias}]: {response}")
            except Exception as exc:
                print(f"stop warning [{node.alias}]: {exc}")
        _log_event("orchestrator.emergency_stop.ok", correlation_id)


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


def call_remote_planner(
    planner_url: str,
    instruction: str,
    system_manifest: dict,
    telemetry_snapshot: dict,
    correlation_id: str | None = None,
) -> dict:
    payload = json.dumps(
        {
            "instruction": instruction,
            "system_manifest": system_manifest,
            "telemetry_snapshot": telemetry_snapshot,
            "correlation_id": correlation_id,
        }
    ).encode("utf-8")

    request = urllib.request.Request(
        planner_url,
        data=payload,
        headers={
            "Content-Type": "application/json",
            **({"X-Correlation-Id": correlation_id} if correlation_id else {}),
        },
        method="POST",
    )

    with urllib.request.urlopen(request, timeout=5) as response:
        if response.status != 200:
            raise RuntimeError(f"Planner returned HTTP {response.status}")
        body = response.read().decode("utf-8")
    parsed = json.loads(body)
    if not isinstance(parsed, dict) or "plan" not in parsed or not isinstance(parsed["plan"], list):
        raise RuntimeError("Planner response missing plan[]")
    return parsed


def fallback_plan(instruction: str) -> dict[str, Any]:
    text = instruction.lower().strip()
    parts = [p.strip() for p in text.replace(",", " then ").split("then") if p.strip()]

    plan: list[dict[str, Any]] = []
    macro_turn_left = "left" in text

    def append_square_steps(turn_left: bool) -> None:
        turn = -90 if turn_left else 90
        for _ in range(4):
            plan.append({"type": "RUN", "target": "base", "token": "FWD", "args": [0.6], "duration_ms": 1200})
            plan.append({"type": "RUN", "target": "base", "token": "TURN", "args": [turn], "duration_ms": 800})

    def append_triangle_steps(turn_left: bool) -> None:
        turn = -120 if turn_left else 120
        for _ in range(3):
            plan.append({"type": "RUN", "target": "base", "token": "FWD", "args": [0.6], "duration_ms": 1200})
            plan.append({"type": "RUN", "target": "base", "token": "TURN", "args": [turn], "duration_ms": 800})

    for part in parts if parts else [text]:
        if "square" in part:
            append_square_steps(turn_left=macro_turn_left or "left" in part)
            continue

        if "triangle" in part:
            append_triangle_steps(turn_left=macro_turn_left or "left" in part)
            continue

        if "straight line" in part:
            plan.append({"type": "RUN", "target": "base", "token": "FWD", "args": [0.6], "duration_ms": 2000})
            continue

        if "takeoff" in part:
            plan.append({"type": "RUN", "token": "THROTTLE", "args": [0.6], "duration_ms": 900})
            continue

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
    correlation_id: str | None = None,
) -> dict[str, Any]:
    if planner_url:
        try:
            remote = call_remote_planner(
                planner_url,
                instruction,
                orchestrator.merged_manifest(),
                orchestrator.telemetry_snapshot(),
                correlation_id=correlation_id,
            )
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, RuntimeError) as exc:
            print(f"planner fallback: {exc}")
        else:
            remote_plan = remote.get("plan")
            if not isinstance(remote_plan, list):
                raise RuntimeError("Planner response missing valid plan[]")
            orchestrator.validate_plan(remote_plan, correlation_id=correlation_id)
            return remote

    local = fallback_plan(instruction)
    local_plan = local.get("plan", [])
    orchestrator.validate_plan(local_plan, correlation_id=correlation_id)
    return local


def run_http_bridge(orchestrator: Orchestrator, host: str, port: int) -> None:
    execution_lock = threading.Lock()
    pi_brain_url = "http://vporto26.local:8090/vision_step"

    class Handler(http.server.BaseHTTPRequestHandler):
        def _write_json(self, status_code: int, payload: dict[str, Any]) -> None:
            raw = json.dumps(payload).encode("utf-8")
            self.send_response(status_code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def _read_json_body(self) -> dict[str, Any]:
            content_length = int(self.headers.get("Content-Length", "0") or "0")
            if content_length <= 0:
                raise RuntimeError("request body is required")
            raw = self.rfile.read(content_length)
            try:
                parsed = json.loads(raw.decode("utf-8"))
            except json.JSONDecodeError as exc:
                raise RuntimeError("request body must be valid JSON") from exc
            if not isinstance(parsed, dict):
                raise RuntimeError("request body must be a JSON object")
            return parsed

        def do_GET(self) -> None:  # noqa: N802
            if self.path == "/telemetry":
                self._write_json(
                    200,
                    {
                        "ok": True,
                        "telemetry_snapshot": orchestrator.telemetry_snapshot(),
                    },
                )
                return

            if self.path != "/status":
                self._write_json(404, {"ok": False, "error": "not_found"})
                return

            nodes_summary: list[dict[str, Any]] = []
            for node in orchestrator.nodes:
                nodes_summary.append(
                    {
                        "alias": node.alias,
                        "name": node.node_name or node.alias,
                        "node_id": node.node_id or node.alias,
                        "host": node.host,
                        "port": node.port,
                        "connected": node.sock is not None and node.running,
                        "commands": [str(command.get("token", "")) for command in node.manifest.get("commands", [])],
                        "services": node.manifest.get("services", {}) if isinstance(node.manifest.get("services"), dict) else {},
                    }
                )

            self._write_json(
                200,
                {
                    "ok": True,
                    "nodes": nodes_summary,
                    "system_manifest": orchestrator.merged_manifest(),
                },
            )

        def do_POST(self) -> None:  # noqa: N802
            if self.path == "/stop":
                correlation_id = self.headers.get("X-Correlation-Id") or f"orch-{uuid.uuid4().hex[:12]}"
                _log_event("http.stop.request", correlation_id)
                with execution_lock:
                    orchestrator.emergency_stop(correlation_id=correlation_id)
                self._write_json(200, {"ok": True, "correlation_id": correlation_id})
                return

            if self.path == "/pi_vision_step":
                try:
                    body = self._read_json_body()
                    instruction = body.get("instruction")
                    if not isinstance(instruction, str) or not instruction.strip():
                        raise RuntimeError("instruction is required")
                    correlation_id = (
                        (body.get("correlation_id") if isinstance(body.get("correlation_id"), str) else None)
                        or self.headers.get("X-Correlation-Id")
                        or f"orch-{uuid.uuid4().hex[:12]}"
                    )
                    # If the client didn't include a system manifest, inject the orchestrator manifest.
                    if not isinstance(body.get("system_manifest"), dict):
                        body["system_manifest"] = orchestrator.merged_manifest()

                    raw = json.dumps(body).encode("utf-8")
                    req = urllib.request.Request(
                        pi_brain_url,
                        data=raw,
                        method="POST",
                        headers={
                            "Content-Type": "application/json",
                            "X-Correlation-Id": correlation_id,
                        },
                    )
                    _log_event("http.pi_vision_step.request", correlation_id, url=pi_brain_url)
                    with urllib.request.urlopen(req, timeout=3.0) as resp:
                        resp_raw = resp.read()
                        try:
                            payload = json.loads(resp_raw.decode("utf-8"))
                        except json.JSONDecodeError as exc:
                            raise RuntimeError("pi brain returned invalid JSON") from exc
                        if not isinstance(payload, dict):
                            raise RuntimeError("pi brain returned non-object JSON")
                except urllib.error.URLError as exc:
                    _log_event("http.pi_vision_step.error", correlation_id if "correlation_id" in locals() else None, error=str(exc))
                    self._write_json(
                        502,
                        {
                            "ok": False,
                            "error": f"pi brain unreachable: {exc}",
                            **({"correlation_id": correlation_id} if "correlation_id" in locals() else {}),
                        },
                    )
                    return
                except Exception as exc:
                    _log_event("http.pi_vision_step.error", correlation_id if "correlation_id" in locals() else None, error=str(exc))
                    self._write_json(
                        400,
                        {
                            "ok": False,
                            "error": str(exc),
                            **({"correlation_id": correlation_id} if "correlation_id" in locals() else {}),
                        },
                    )
                    return

                self._write_json(200, payload)
                return

            if self.path == "/execute_plan":
                try:
                    body = self._read_json_body()
                    plan = body.get("plan")
                    if not isinstance(plan, list):
                        raise RuntimeError("plan must be a list")
                    correlation_id = (
                        (body.get("correlation_id") if isinstance(body.get("correlation_id"), str) else None)
                        or self.headers.get("X-Correlation-Id")
                        or f"orch-{uuid.uuid4().hex[:12]}"
                    )
                    _log_event("http.execute_plan.request", correlation_id, plan_len=len(plan), plan=plan)

                    with execution_lock:
                        orchestrator.validate_plan(plan, correlation_id=correlation_id)
                        orchestrator.execute_plan(plan, correlation_id=correlation_id)
                except Exception as exc:
                    _log_event("http.execute_plan.error", correlation_id if "correlation_id" in locals() else None, error=str(exc))
                    self._write_json(
                        400,
                        {
                            "ok": False,
                            "error": str(exc),
                            **({"correlation_id": correlation_id} if "correlation_id" in locals() else {}),
                        },
                    )
                    return

                self._write_json(200, {"ok": True, "correlation_id": correlation_id})
                return

            self._write_json(404, {"ok": False, "error": "not_found"})

        def log_message(self, format: str, *args: Any) -> None:
            return

    server = http.server.ThreadingHTTPServer((host, port), Handler)
    print(f"http bridge listening on http://{host}:{port}")
    try:
        server.serve_forever()
    finally:
        server.server_close()


def repl(orchestrator: Orchestrator, planner_url: str | None) -> None:
    print("orchestrator ready. Type instructions, 'stop' for emergency stop, 'exit' to quit.")
    while True:
        try:
            line = input("daemon> ").strip()
        except KeyboardInterrupt:
            print("\nCtrl+C received, issuing STOP to all nodes...")
            try:
                orchestrator.emergency_stop()
                print("global stop sent")
            except Exception as exc:
                print(f"stop error: {exc}")
            break
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

        correlation_id = f"repl-{uuid.uuid4().hex[:12]}"
        planned = make_plan(line, orchestrator, planner_url, correlation_id=correlation_id)
        plan = planned.get("plan", [])
        print(json.dumps(planned, indent=2))

        try:
            orchestrator.validate_plan(plan, correlation_id=correlation_id)
            orchestrator.execute_plan(plan, correlation_id=correlation_id)
            print("plan executed")
        except Exception as exc:
            print(f"execution error: {exc}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="DAEMON Multi-node Orchestrator")
    parser.add_argument("--node", action="append", required=True, help="Node endpoint as alias=host:port")
    parser.add_argument("--planner-url", default=None, help="Remote planner URL (e.g. https://.../plan)")
    parser.add_argument("--telemetry", action="store_true", help="Subscribe to node telemetry and print it")
    parser.add_argument("--instruction", default=None, help="One-shot instruction (non-interactive)")
    parser.add_argument("--step-timeout", type=float, default=4.0, help="Per-step RUN/STOP response timeout (seconds)")
    parser.add_argument("--timeout", type=float, default=7.0, help="Node connect/HELLO timeout (seconds)")
    parser.add_argument("--http-host", default="127.0.0.1", help="HTTP bridge bind host")
    parser.add_argument("--http-port", type=int, default=None, help="HTTP bridge bind port")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    nodes = [parse_node_arg(raw) for raw in args.node]
    if args.http_port is not None and args.instruction:
        raise RuntimeError("Use either --instruction one-shot mode or --http-port bridge mode, not both.")

    orchestrator = Orchestrator(nodes=nodes, telemetry=args.telemetry, timeout_s=args.timeout, step_timeout_s=args.step_timeout)
    try:
        orchestrator.connect_all()
        if args.http_port is not None:
            run_http_bridge(orchestrator, args.http_host, args.http_port)
        elif args.instruction:
            correlation_id = f"cli-{uuid.uuid4().hex[:12]}"
            planned = make_plan(args.instruction, orchestrator, args.planner_url, correlation_id=correlation_id)
            plan = planned.get("plan", [])
            print(json.dumps(planned, indent=2))
            orchestrator.validate_plan(plan, correlation_id=correlation_id)
            orchestrator.execute_plan(plan, correlation_id=correlation_id)
            print("plan executed")
        else:
            repl(orchestrator, args.planner_url)
    except KeyboardInterrupt:
        print("\nCtrl+C received, issuing STOP to all nodes...")
        try:
            orchestrator.emergency_stop()
            print("global stop sent")
        except Exception as exc:
            print(f"stop error: {exc}")
    finally:
        orchestrator.close_all()


if __name__ == "__main__":
    main()
