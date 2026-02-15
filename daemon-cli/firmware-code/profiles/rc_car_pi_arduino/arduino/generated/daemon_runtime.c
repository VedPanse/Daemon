#include "daemon_runtime.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static uint32_t g_last_cmd_ms = 0;
static uint32_t g_watchdog_ms = 600;
static uint32_t g_min_cmd_interval_ms = 500;

static void daemon_serial_write(const char *line) {
  // TODO: Replace with board-specific serial write.
  puts(line);
}

bool daemon_parse_int(const char *raw, int *value) {
  if (raw == NULL || value == NULL) return false;
  char *end = NULL;
  long parsed = strtol(raw, &end, 10);
  if (end == raw || *end != '\0') return false;
  *value = (int)parsed;
  return true;
}

bool daemon_parse_float(const char *raw, float *value) {
  if (raw == NULL || value == NULL) return false;
  char *end = NULL;
  float parsed = strtof(raw, &end);
  if (end == raw || *end != '\0') return false;
  *value = parsed;
  return true;
}

void daemon_runtime_publish_telemetry(const char *key, const char *value) {
  char line[256];
  snprintf(line, sizeof(line), "TELEMETRY %s=%s", key, value);
  daemon_serial_write(line);
}

void daemon_runtime_stop(void) {
  daemon_serial_write("OK");
}

void daemon_runtime_init(void) {
  g_last_cmd_ms = 0;
}

void daemon_runtime_tick(uint32_t now_ms) {
  if (g_last_cmd_ms > 0 && (now_ms - g_last_cmd_ms) > g_watchdog_ms) {
    daemon_runtime_stop();
    g_last_cmd_ms = now_ms;
  }
}

void daemon_runtime_handle_line(const char *line, uint32_t now_ms) {
  if (line == NULL) {
    daemon_serial_write("ERR BAD_REQUEST empty_line");
    return;
  }

  if (strcmp(line, "HELLO") == 0) {
    daemon_serial_write("OK");
    return;
  }

  if (strcmp(line, "READ_MANIFEST") == 0) {
    daemon_serial_write("MANIFEST {\"daemon_version\":\"0.1\",\"device\":{\"name\":\"arduino\",\"version\":\"0.1.0\",\"node_id\":\"arduino\"},\"commands\":[{\"token\":\"INIT\",\"description\":\"Initialize motor controller state\",\"args\":[],\"safety\":{\"rate_limit_hz\":2,\"watchdog_ms\":2000,\"clamp\":true},\"nlp\":{\"synonyms\":[\"init\",\"initialize motor controller state\"],\"examples\":[\"Initialize motor controller state\"]}},{\"token\":\"DRIVE\",\"description\":\"Set drive throttle/steering percent\",\"args\":[{\"name\":\"throttle_percent\",\"type\":\"int\",\"min\":-100.0,\"max\":100.0,\"required\":true},{\"name\":\"steering_percent\",\"type\":\"int\",\"min\":-100.0,\"max\":100.0,\"required\":true}],\"safety\":{\"rate_limit_hz\":20,\"watchdog_ms\":600,\"clamp\":true},\"nlp\":{\"synonyms\":[\"drive\",\"set drive throttle/steering percent\"],\"examples\":[\"Set drive throttle/steering percent\"]}},{\"token\":\"ESTOP\",\"description\":\"Emergency stop\",\"args\":[],\"safety\":{\"rate_limit_hz\":10,\"watchdog_ms\":1000,\"clamp\":true},\"nlp\":{\"synonyms\":[\"estop\",\"emergency stop\"],\"examples\":[\"Emergency stop\"]}}],\"telemetry\":{\"keys\":[{\"name\":\"uptime_ms\",\"type\":\"int\",\"unit\":\"ms\"},{\"name\":\"last_token\",\"type\":\"string\"}]},\"transport\":{\"type\":\"serial-line-v1\"}}");
    return;
  }

  if (strcmp(line, "STOP") == 0) {
    daemon_runtime_stop();
    return;
  }

  if (strncmp(line, "RUN ", 4) == 0) {
    if (g_min_cmd_interval_ms > 0 && g_last_cmd_ms > 0 && (now_ms - g_last_cmd_ms) < g_min_cmd_interval_ms) {
      daemon_serial_write("ERR RATE_LIMIT too_fast");
      return;
    }

    char mutable_line[256];
    strncpy(mutable_line, line + 4, sizeof(mutable_line) - 1);
    mutable_line[sizeof(mutable_line) - 1] = '\0';

    const char *argv[16];
    int argc = 0;
    char *save_ptr = NULL;
    char *token = strtok_r(mutable_line, " ", &save_ptr);
    char *piece = NULL;
    while ((piece = strtok_r(NULL, " ", &save_ptr)) != NULL && argc < 16) {
      argv[argc++] = piece;
    }

    int result = daemon_entry_dispatch(token, argc, argv);
    if (result == DAEMON_OK) {
      daemon_serial_write("OK");
      g_last_cmd_ms = now_ms;
    } else if (result == DAEMON_ERR_BAD_TOKEN) {
      daemon_serial_write("ERR BAD_TOKEN unknown");
    } else if (result == DAEMON_ERR_BAD_ARGS) {
      daemon_serial_write("ERR BAD_ARGS invalid");
    } else if (result == DAEMON_ERR_RANGE) {
      daemon_serial_write("ERR RANGE out_of_bounds");
    } else {
      daemon_serial_write("ERR INTERNAL dispatch_failed");
    }
    return;
  }

  daemon_serial_write("ERR BAD_REQUEST unsupported");
}
