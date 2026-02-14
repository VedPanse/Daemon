from __future__ import annotations

import json
from pathlib import Path


class SchemaValidationError(RuntimeError):
    pass


def load_schema(schema_path: Path) -> dict:
    return json.loads(schema_path.read_text(encoding="utf-8"))


def validate_manifest_schema(manifest: dict, schema_path: Path) -> None:
    try:
        from jsonschema import Draft202012Validator
    except ModuleNotFoundError as exc:
        raise SchemaValidationError(
            "Missing dependency 'jsonschema'. Install with: pip install jsonschema"
        ) from exc

    schema = load_schema(schema_path)
    validator = Draft202012Validator(schema)
    errors = sorted(validator.iter_errors(manifest), key=lambda e: e.path)
    if errors:
        first = errors[0]
        location = ".".join([str(p) for p in first.path]) or "root"
        raise SchemaValidationError(f"Schema validation failed at {location}: {first.message}")
