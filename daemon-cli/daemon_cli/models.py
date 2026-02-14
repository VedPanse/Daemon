from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class ArgSpec:
    name: str
    arg_type: str
    minimum: float | None = None
    maximum: float | None = None
    required: bool = True


@dataclass
class SafetySpec:
    rate_limit_hz: int = 20
    watchdog_ms: int = 500
    clamp: bool = True


@dataclass
class CommandSpec:
    token: str
    function_name: str
    description: str
    args: list[ArgSpec] = field(default_factory=list)
    safety: SafetySpec = field(default_factory=SafetySpec)
    synonyms: list[str] = field(default_factory=list)
    examples: list[str] = field(default_factory=list)


@dataclass
class BuildResult:
    firmware_dir: str
    generated_dir: str
    commands: list[CommandSpec]
    manifest: dict[str, Any]
