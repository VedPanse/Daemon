from __future__ import annotations

import re
from pathlib import Path

from daemon_cli.models import ArgSpec, CommandSpec, SafetySpec

ANNOTATION_RE = re.compile(
    r'@daemon:export\s+token=(?P<token>[A-Z0-9_]+)\s+desc="(?P<desc>[^"]+)"\s+args="(?P<args>[^"]*)"\s+'
    r'safety="(?P<safety>[^"]+)"(?:\s+function=(?P<function>[A-Za-z_][A-Za-z0-9_]*))?'
)
ARG_RE = re.compile(
    r'^(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*:\s*(?P<type>int|float|bool|string)'
    r'(?:\[(?P<range_min>[^\]]+)\.\.(?P<range_max>[^\]]+)\])?$'
)


def parse_args_spec(raw: str) -> list[ArgSpec]:
    content = raw.strip()
    if not content:
        return []

    args: list[ArgSpec] = []
    for chunk in [p.strip() for p in content.split(",") if p.strip()]:
        match = ARG_RE.match(chunk)
        if not match:
            raise ValueError(f"Invalid args chunk: {chunk}")
        arg_type = match.group("type")
        minimum = None
        maximum = None
        if match.group("range_min") and match.group("range_max") and arg_type in {"int", "float"}:
            minimum = float(match.group("range_min"))
            maximum = float(match.group("range_max"))
        args.append(
            ArgSpec(
                name=match.group("name"),
                arg_type=arg_type,
                minimum=minimum,
                maximum=maximum,
                required=True,
            )
        )
    return args


def parse_safety_spec(raw: str) -> SafetySpec:
    values: dict[str, str] = {}
    for piece in [x.strip() for x in raw.split(",") if x.strip()]:
        if "=" not in piece:
            continue
        key, value = piece.split("=", 1)
        values[key.strip()] = value.strip()

    rate = int(values.get("rate_hz", values.get("rate_limit_hz", "20")))
    watchdog = int(values.get("watchdog_ms", "500"))
    clamp = values.get("clamp", "true").lower() in {"1", "true", "yes"}
    return SafetySpec(rate_limit_hz=rate, watchdog_ms=watchdog, clamp=clamp)


def discover_annotated_exports(firmware_dir: Path) -> list[CommandSpec]:
    commands: list[CommandSpec] = []
    files = list(firmware_dir.rglob("*.c")) + list(firmware_dir.rglob("*.cpp")) + list(firmware_dir.rglob("*.ino"))

    for file_path in files:
        text = file_path.read_text(encoding="utf-8", errors="ignore")
        for match in ANNOTATION_RE.finditer(text):
            function_name = match.group("function")
            if not function_name:
                raise ValueError(f"{file_path}: export requires function=<name>")

            token = match.group("token")
            desc = match.group("desc")
            args = parse_args_spec(match.group("args"))
            safety = parse_safety_spec(match.group("safety"))

            commands.append(
                CommandSpec(
                    token=token,
                    function_name=function_name,
                    description=desc,
                    args=args,
                    safety=safety,
                    synonyms=[token.lower(), desc.lower()],
                    examples=[desc],
                )
            )

    return commands
