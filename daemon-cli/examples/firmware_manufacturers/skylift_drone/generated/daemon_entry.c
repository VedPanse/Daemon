#include "daemon_runtime.h"

#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

void set_throttle(float p);
void yaw_to(float deg);
void stop_motors(void);

int daemon_entry_dispatch(const char *token, int argc, const char **argv) {
  if (token == NULL) return DAEMON_ERR_BAD_TOKEN;
  if (strcmp(token, "STOP") == 0) {
    daemon_runtime_stop();
    return DAEMON_OK;
  }

  if (strcmp(token, "THROTTLE") == 0) {
    if (argc != 1) return DAEMON_ERR_BAD_ARGS;
    float arg_0 = 0.0f;
    if (!daemon_parse_float(argv[0], &arg_0)) return DAEMON_ERR_BAD_ARGS;
    if (arg_0 < 0.0) return DAEMON_ERR_RANGE;
    if (arg_0 > 1.0) return DAEMON_ERR_RANGE;
    set_throttle(arg_0);
    return DAEMON_OK;
  }

  if (strcmp(token, "YAW") == 0) {
    if (argc != 1) return DAEMON_ERR_BAD_ARGS;
    float arg_0 = 0.0f;
    if (!daemon_parse_float(argv[0], &arg_0)) return DAEMON_ERR_BAD_ARGS;
    if (arg_0 < -180.0) return DAEMON_ERR_RANGE;
    if (arg_0 > 180.0) return DAEMON_ERR_RANGE;
    yaw_to(arg_0);
    return DAEMON_OK;
  }

  if (strcmp(token, "STOP") == 0) {
    if (argc != 0) return DAEMON_ERR_BAD_ARGS;
    stop_motors();
    return DAEMON_OK;
  }

  return DAEMON_ERR_BAD_TOKEN;
}
