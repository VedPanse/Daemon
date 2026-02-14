import tempfile
import unittest
from pathlib import Path

from daemon_cli.build import BuildError, run_build


class BuildTests(unittest.TestCase):
    def test_build_generates_required_files(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "main.c").write_text(
                """
                // @daemon:export token=L desc=\"Turn left\" args=\"intensity:int[0..255]\" safety=\"rate_hz=20,watchdog_ms=300,clamp=true\"
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


if __name__ == "__main__":
    unittest.main()
