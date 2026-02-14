#include "daemon_runtime.h"

#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

void calibrate(int level);

int daemon_entry_dispatch(const char *token, int argc, const char **argv) {
  if (token == NULL) return DAEMON_ERR_BAD_TOKEN;
  if (strcmp(token, "STOP") == 0) {
    daemon_runtime_stop();
    return DAEMON_OK;
  }

  if (strcmp(token, "CALIBRATE") == 0) {
    if (argc != 1) return DAEMON_ERR_BAD_ARGS;
    int arg_0 = 0;
    if (!daemon_parse_int(argv[0], &arg_0)) return DAEMON_ERR_BAD_ARGS;
    if (arg_0 < 0.0) return DAEMON_ERR_RANGE;
    if (arg_0 > 3.0) return DAEMON_ERR_RANGE;
    calibrate(arg_0);
    return DAEMON_OK;
  }

  return DAEMON_ERR_BAD_TOKEN;
}
