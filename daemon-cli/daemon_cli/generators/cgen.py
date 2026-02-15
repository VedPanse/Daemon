from __future__ import annotations

from pathlib import Path

from daemon_cli.models import ArgSpec, CommandSpec


def _ctype(arg_type: str) -> str:
    return {
        "int": "int",
        "float": "float",
        "bool": "int",
        "string": "const char *",
    }.get(arg_type, "float")


def _parser_fn(arg: ArgSpec, argv_index: int, var_name: str) -> list[str]:
    if arg.arg_type == "string":
        lines = [f"    const char *{var_name} = argv[{argv_index}];"]
    elif arg.arg_type in {"int", "bool"}:
        lines = [
            f"    int {var_name} = 0;",
            f"    if (!daemon_parse_int(argv[{argv_index}], &{var_name})) return DAEMON_ERR_BAD_ARGS;",
        ]
    else:
        lines = [
            f"    float {var_name} = 0.0f;",
            f"    if (!daemon_parse_float(argv[{argv_index}], &{var_name})) return DAEMON_ERR_BAD_ARGS;",
        ]

    if arg.minimum is not None:
        lines.append(f"    if ({var_name} < {arg.minimum}) return DAEMON_ERR_RANGE;")
    if arg.maximum is not None:
        lines.append(f"    if ({var_name} > {arg.maximum}) return DAEMON_ERR_RANGE;")
    return lines


def _declare_fn(command: CommandSpec) -> str:
    params = ", ".join([f"{_ctype(arg.arg_type)} {arg.name}" for arg in command.args])
    if not params:
        params = "void"
    return f"void {command.function_name}({params});"


def _dispatch_block(command: CommandSpec) -> str:
    lines = [f'  if (strcmp(token, "{command.token}") == 0) {{']
    lines.append(f"    if (argc != {len(command.args)}) return DAEMON_ERR_BAD_ARGS;")

    call_vars: list[str] = []
    for idx, arg in enumerate(command.args):
        var_name = f"arg_{idx}"
        call_vars.append(var_name)
        lines.extend(_parser_fn(arg, idx, var_name))

    call = ", ".join(call_vars)
    lines.append(f"    {command.function_name}({call});")
    lines.append("    return DAEMON_OK;")
    lines.append("  }")
    return "\n".join(lines)


def write_daemon_entry(generated_dir: Path, commands: list[CommandSpec]) -> None:
    declarations = "\n".join([_declare_fn(cmd) for cmd in commands])
    blocks = "\n\n".join([_dispatch_block(cmd) for cmd in commands if cmd.token != "STOP"])

    content = f'''#include "daemon_runtime.h"

#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

{declarations}

int daemon_entry_dispatch(const char *token, int argc, const char **argv) {{
  if (token == NULL) return DAEMON_ERR_BAD_TOKEN;
  if (strcmp(token, "STOP") == 0) {{
    daemon_runtime_stop();
    return DAEMON_OK;
  }}

{blocks}

  return DAEMON_ERR_BAD_TOKEN;
}}
'''
    (generated_dir / "daemon_entry.c").write_text(content, encoding="utf-8")


def write_daemon_runtime(generated_dir: Path, manifest_json: str, command_rate_hz: int, watchdog_ms: int) -> None:
    runtime_h = '''#ifndef DAEMON_RUNTIME_H
#define DAEMON_RUNTIME_H

#include <stdbool.h>
#include <stdint.h>

#define DAEMON_OK 0
#define DAEMON_ERR_BAD_TOKEN 10
#define DAEMON_ERR_BAD_ARGS 11
#define DAEMON_ERR_RANGE 12
#define DAEMON_ERR_RATE_LIMIT 13

void daemon_runtime_init(void);
void daemon_runtime_tick(uint32_t now_ms);
void daemon_runtime_handle_line(const char *line, uint32_t now_ms);
void daemon_runtime_stop(void);
void daemon_runtime_publish_telemetry(const char *key, const char *value);

bool daemon_parse_int(const char *raw, int *value);
bool daemon_parse_float(const char *raw, float *value);
int daemon_entry_dispatch(const char *token, int argc, const char **argv);

#endif
'''
    (generated_dir / "daemon_runtime.h").write_text(runtime_h, encoding="utf-8")

    min_interval = int(1000 / command_rate_hz) if command_rate_hz > 0 else 0
    manifest_c_literal = manifest_json.replace("\\", "\\\\").replace('"', '\\"')

    runtime_c = f'''#include "daemon_runtime.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static uint32_t g_last_cmd_ms = 0;
static uint32_t g_watchdog_ms = {watchdog_ms};
static uint32_t g_min_cmd_interval_ms = {min_interval};

static void daemon_serial_write(const char *line) {{
  // TODO: Replace with board-specific serial write.
  puts(line);
}}

bool daemon_parse_int(const char *raw, int *value) {{
  if (raw == NULL || value == NULL) return false;
  char *end = NULL;
  long parsed = strtol(raw, &end, 10);
  if (end == raw || *end != '\\0') return false;
  *value = (int)parsed;
  return true;
}}

bool daemon_parse_float(const char *raw, float *value) {{
  if (raw == NULL || value == NULL) return false;
  char *end = NULL;
  float parsed = strtof(raw, &end);
  if (end == raw || *end != '\\0') return false;
  *value = parsed;
  return true;
}}

void daemon_runtime_publish_telemetry(const char *key, const char *value) {{
  char line[256];
  snprintf(line, sizeof(line), "TELEMETRY %s=%s", key, value);
  daemon_serial_write(line);
}}

void daemon_runtime_stop(void) {{
  daemon_serial_write("OK");
}}

void daemon_runtime_init(void) {{
  g_last_cmd_ms = 0;
}}

void daemon_runtime_tick(uint32_t now_ms) {{
  if (g_last_cmd_ms > 0 && (now_ms - g_last_cmd_ms) > g_watchdog_ms) {{
    daemon_runtime_stop();
    g_last_cmd_ms = now_ms;
  }}
}}

void daemon_runtime_handle_line(const char *line, uint32_t now_ms) {{
  if (line == NULL) {{
    daemon_serial_write("ERR BAD_REQUEST empty_line");
    return;
  }}

  if (strcmp(line, "HELLO") == 0) {{
    daemon_serial_write("OK");
    return;
  }}

  if (strcmp(line, "READ_MANIFEST") == 0) {{
    daemon_serial_write("MANIFEST {manifest_c_literal}");
    return;
  }}

  if (strcmp(line, "STOP") == 0) {{
    daemon_runtime_stop();
    return;
  }}

  if (strncmp(line, "RUN ", 4) == 0) {{
    if (g_min_cmd_interval_ms > 0 && g_last_cmd_ms > 0 && (now_ms - g_last_cmd_ms) < g_min_cmd_interval_ms) {{
      daemon_serial_write("ERR RATE_LIMIT too_fast");
      return;
    }}

    char mutable_line[256];
    strncpy(mutable_line, line + 4, sizeof(mutable_line) - 1);
    mutable_line[sizeof(mutable_line) - 1] = '\\0';

    const char *argv[16];
    int argc = 0;
    char *save_ptr = NULL;
    char *token = strtok_r(mutable_line, " ", &save_ptr);
    char *piece = NULL;
    while ((piece = strtok_r(NULL, " ", &save_ptr)) != NULL && argc < 16) {{
      argv[argc++] = piece;
    }}

    int result = daemon_entry_dispatch(token, argc, argv);
    if (result == DAEMON_OK) {{
      daemon_serial_write("OK");
      g_last_cmd_ms = now_ms;
    }} else if (result == DAEMON_ERR_BAD_TOKEN) {{
      daemon_serial_write("ERR BAD_TOKEN unknown");
    }} else if (result == DAEMON_ERR_BAD_ARGS) {{
      daemon_serial_write("ERR BAD_ARGS invalid");
    }} else if (result == DAEMON_ERR_RANGE) {{
      daemon_serial_write("ERR RANGE out_of_bounds");
    }} else {{
      daemon_serial_write("ERR INTERNAL dispatch_failed");
    }}
    return;
  }}

  daemon_serial_write("ERR BAD_REQUEST unsupported");
}}
'''
    (generated_dir / "daemon_runtime.c").write_text(runtime_c, encoding="utf-8")
