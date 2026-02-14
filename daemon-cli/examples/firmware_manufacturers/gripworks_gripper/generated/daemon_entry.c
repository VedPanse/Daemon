#include "daemon_runtime.h"

#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

void set_grip(const char * state);
void set_grip_force(float n);

int daemon_entry_dispatch(const char *token, int argc, const char **argv) {
  if (token == NULL) return DAEMON_ERR_BAD_TOKEN;
  if (strcmp(token, "STOP") == 0) {
    daemon_runtime_stop();
    return DAEMON_OK;
  }

  if (strcmp(token, "GRIP") == 0) {
    if (argc != 1) return DAEMON_ERR_BAD_ARGS;
    const char *arg_0 = argv[0];
    set_grip(arg_0);
    return DAEMON_OK;
  }

  if (strcmp(token, "GRIP_FORCE") == 0) {
    if (argc != 1) return DAEMON_ERR_BAD_ARGS;
    float arg_0 = 0.0f;
    if (!daemon_parse_float(argv[0], &arg_0)) return DAEMON_ERR_BAD_ARGS;
    if (arg_0 < 0.0) return DAEMON_ERR_RANGE;
    if (arg_0 > 40.0) return DAEMON_ERR_RANGE;
    set_grip_force(arg_0);
    return DAEMON_OK;
  }

  return DAEMON_ERR_BAD_TOKEN;
}
