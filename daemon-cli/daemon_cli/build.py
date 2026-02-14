from __future__ import annotations

from pathlib import Path

from daemon_cli.generators import (
    build_manifest,
    manifest_json_compact,
    write_daemon_entry,
    write_daemon_runtime,
    write_integration_doc,
    write_manifest_yaml,
)
from daemon_cli.models import BuildResult
from daemon_cli.parsers import discover_annotated_exports
from daemon_cli.schema import SchemaValidationError, validate_manifest_schema


class BuildError(RuntimeError):
    pass


def _validate_token_uniqueness(tokens: list[str]) -> None:
    if len(tokens) != len(set(tokens)):
        raise BuildError("Duplicate command tokens found in annotations.")


def run_build(firmware_dir: Path) -> BuildResult:
    if not firmware_dir.exists() or not firmware_dir.is_dir():
        raise BuildError(f"Firmware directory not found: {firmware_dir}")

    commands = discover_annotated_exports(firmware_dir)
    if not commands:
        raise BuildError(
            "No exports found. Add annotations in source files using: "
            "// @daemon:export token=<TOKEN> desc=\"<DESC>\" args=\"<ARG_SPEC>\" safety=\"<SAFETY_SPEC>\""
        )

    tokens = [c.token for c in commands]
    _validate_token_uniqueness(tokens)

    generated_dir = firmware_dir / "generated"
    generated_dir.mkdir(parents=True, exist_ok=True)
    for existing in generated_dir.glob("*"):
        if existing.is_file():
            existing.unlink()

    manifest = build_manifest(firmware_dir, commands)
    schema_path = Path(__file__).resolve().parent.parent / "schema" / "daemon.schema.v0_1.json"

    try:
        validate_manifest_schema(manifest, schema_path)
    except SchemaValidationError as exc:
        raise BuildError(str(exc)) from exc

    write_manifest_yaml(manifest, generated_dir / "DAEMON.yml")
    write_daemon_entry(generated_dir, commands)

    default_rate_hz = min(c.safety.rate_limit_hz for c in commands)
    default_watchdog = min(c.safety.watchdog_ms for c in commands)
    write_daemon_runtime(
        generated_dir,
        manifest_json_compact(manifest),
        command_rate_hz=default_rate_hz,
        watchdog_ms=default_watchdog,
    )
    write_integration_doc(generated_dir)

    return BuildResult(
        firmware_dir=str(firmware_dir),
        generated_dir=str(generated_dir),
        commands=commands,
        manifest=manifest,
    )


def run_clean(firmware_dir: Path) -> Path:
    generated_dir = firmware_dir / "generated"
    if generated_dir.exists():
        for path in generated_dir.glob("*"):
            if path.is_file():
                path.unlink()
        generated_dir.rmdir()
    return generated_dir
