import unittest
from pathlib import Path

from daemon_cli.generators.manifest import build_manifest
from daemon_cli.models import ArgSpec, CommandSpec, SafetySpec
from daemon_cli.schema import validate_manifest_schema


class SchemaTests(unittest.TestCase):
    def test_manifest_matches_schema(self):
        commands = [
            CommandSpec(
                token="L",
                function_name="move_left",
                description="Turn left",
                args=[ArgSpec(name="intensity", arg_type="int", minimum=0, maximum=255, required=True)],
                safety=SafetySpec(rate_limit_hz=20, watchdog_ms=300, clamp=True),
                synonyms=["left"],
                examples=["turn left 100"],
            )
        ]
        manifest = build_manifest(Path("demo"), commands)
        schema_path = Path(__file__).resolve().parent.parent / "schema" / "daemon.schema.v0_1.json"
        validate_manifest_schema(manifest, schema_path)


if __name__ == "__main__":
    unittest.main()
