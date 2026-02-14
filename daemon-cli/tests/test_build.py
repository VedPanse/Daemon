import tempfile
import unittest
import shutil
from pathlib import Path

from daemon_cli.build import BuildError, run_build
from daemon_cli.schema import validate_manifest_schema


class BuildTests(unittest.TestCase):
    def test_build_generates_required_files(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "main.c").write_text(
                """
                // @daemon:export token=L desc=\"Turn left\" args=\"intensity:int[0..255]\" safety=\"rate_hz=20,watchdog_ms=300,clamp=true\" function=move_left
                void move_left(int intensity) { }
                """,
                encoding="utf-8",
            )

            result = run_build(root)
            generated = Path(result.generated_dir)
            expected = {
                "DAEMON.yml",
                "daemon_entry.c",
                "daemon_runtime.c",
                "daemon_runtime.h",
                "DAEMON_INTEGRATION.md",
            }
            self.assertEqual(set(p.name for p in generated.glob("*")), expected)

            content = (generated / "DAEMON.yml").read_text(encoding="utf-8")
            self.assertIn("daemon_version: '0.1'", content)
            self.assertIn("token: L", content)

    def test_fails_without_annotations(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "main.c").write_text("void foo(void) {}\n", encoding="utf-8")
            with self.assertRaises(BuildError):
                run_build(root)

    def test_fails_when_function_mapping_is_missing(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "main.c").write_text(
                """
                // @daemon:export token=L desc=\"Turn left\" args=\"intensity:int[0..255]\" safety=\"rate_hz=20,watchdog_ms=300,clamp=true\"
                void move_left(int intensity) { }
                """,
                encoding="utf-8",
            )
            with self.assertRaisesRegex(BuildError, "export requires function=<name>"):
                run_build(root)

    def test_build_succeeds_for_manufacturer_examples(self):
        examples_root = Path(__file__).resolve().parent.parent / "examples" / "firmware_manufacturers"
        schema_path = Path(__file__).resolve().parent.parent / "schema" / "daemon.schema.v0_1.json"

        for name in ["skylift_drone", "gripworks_gripper", "linetrace_sensor"]:
            with self.subTest(example=name):
                with tempfile.TemporaryDirectory() as temp_dir:
                    src = examples_root / name
                    dst = Path(temp_dir) / name
                    shutil.copytree(src, dst)
                    result = run_build(dst)
                    generated = Path(result.generated_dir)
                    manifest_path = generated / "DAEMON.yml"
                    self.assertTrue(manifest_path.exists())

                    import yaml

                    manifest = yaml.safe_load(manifest_path.read_text(encoding="utf-8"))
                    validate_manifest_schema(manifest, schema_path)


if __name__ == "__main__":
    unittest.main()
