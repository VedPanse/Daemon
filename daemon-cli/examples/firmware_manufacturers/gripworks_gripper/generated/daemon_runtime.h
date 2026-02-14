#ifndef DAEMON_RUNTIME_H
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
