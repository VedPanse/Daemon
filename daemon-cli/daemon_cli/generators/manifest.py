from __future__ import annotations

import json
from pathlib import Path

from daemon_cli.models import CommandSpec


def _sanitize_node_id(name: str) -> str:
    filtered = [c.lower() if c.isalnum() else "-" for c in name]
    node_id = "".join(filtered).strip("-")
    return node_id or "daemon-node"


def build_manifest(firmware_dir: Path, commands: list[CommandSpec]) -> dict:
    return {
        "daemon_version": "0.1",
        "device": {
            "name": firmware_dir.name,
            "version": "0.1.0",
            "node_id": _sanitize_node_id(firmware_dir.name),
        },
        "commands": [
            {
                "token": command.token,
                "description": command.description,
                "args": [
                    {
                        "name": arg.name,
                        "type": arg.arg_type,
                        "min": arg.minimum,
                        "max": arg.maximum,
                        "required": arg.required,
                    }
                    for arg in command.args
                ],
                "safety": {
                    "rate_limit_hz": command.safety.rate_limit_hz,
                    "watchdog_ms": command.safety.watchdog_ms,
                    "clamp": command.safety.clamp,
                },
                "nlp": {
                    "synonyms": command.synonyms,
                    "examples": command.examples,
                },
            }
            for command in commands
        ],
        "telemetry": {
            "keys": [
                {"name": "uptime_ms", "type": "int", "unit": "ms"},
                {"name": "last_token", "type": "string"},
            ]
        },
        "transport": {
            "type": "serial-line-v1",
        },
    }


def write_manifest_yaml(manifest: dict, output_path: Path) -> None:
    try:
        import yaml
    except ModuleNotFoundError as exc:
        raise RuntimeError("Missing dependency 'PyYAML'. Install with: pip install pyyaml") from exc

    rendered = yaml.safe_dump(manifest, sort_keys=False)
    output_path.write_text(rendered, encoding="utf-8")


def manifest_json_compact(manifest: dict) -> str:
    return json.dumps(manifest, separators=(",", ":"))
