import tempfile
import unittest
from pathlib import Path

from daemon_cli.parsers.annotation import discover_annotated_exports, parse_args_spec, parse_safety_spec


class AnnotationParserTests(unittest.TestCase):
    def test_parse_args_spec(self):
        args = parse_args_spec("intensity:int[0..255],speed:float[-1.5..2.5]")
        self.assertEqual(len(args), 2)
        self.assertEqual(args[0].name, "intensity")
        self.assertEqual(args[0].arg_type, "int")
        self.assertEqual(args[0].minimum, 0)
        self.assertEqual(args[0].maximum, 255)

    def test_parse_safety_spec(self):
        safety = parse_safety_spec("rate_hz=20,watchdog_ms=300,clamp=true")
        self.assertEqual(safety.rate_limit_hz, 20)
        self.assertEqual(safety.watchdog_ms, 300)
        self.assertTrue(safety.clamp)

    def test_discover_annotated_exports(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "main.c").write_text(
                """
                // @daemon:export token=L desc=\"Turn left\" args=\"intensity:int[0..255]\" safety=\"rate_hz=20,watchdog_ms=300,clamp=true\"
                void move_left(int intensity) { }
                """,
                encoding="utf-8",
            )

            commands = discover_annotated_exports(root)
            self.assertEqual(len(commands), 1)
            self.assertEqual(commands[0].token, "L")
            self.assertEqual(commands[0].function_name, "move_left")


if __name__ == "__main__":
    unittest.main()
