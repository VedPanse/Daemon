#include "daemon_runtime.h"

#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

void daemon_cmd_fwd(float speed);
void daemon_cmd_bwd(float speed);
void daemon_cmd_strafe(const char * dir, float speed);
void daemon_cmd_turn(float degrees);
void daemon_cmd_mecanum(const char * cmd);
void daemon_cmd_stop(void);

int daemon_entry_dispatch(const char *token, int argc, const char **argv) {
  if (token == NULL) return DAEMON_ERR_BAD_TOKEN;
  if (strcmp(token, "STOP") == 0) {
    daemon_runtime_stop();
    return DAEMON_OK;
  }

  if (strcmp(token, "FWD") == 0) {
    if (argc != 1) return DAEMON_ERR_BAD_ARGS;
    float arg_0 = 0.0f;
    if (!daemon_parse_float(argv[0], &arg_0)) return DAEMON_ERR_BAD_ARGS;
    if (arg_0 < 0.0) return DAEMON_ERR_RANGE;
    if (arg_0 > 1.0) return DAEMON_ERR_RANGE;
    daemon_cmd_fwd(arg_0);
    return DAEMON_OK;
  }

  if (strcmp(token, "BWD") == 0) {
    if (argc != 1) return DAEMON_ERR_BAD_ARGS;
    float arg_0 = 0.0f;
    if (!daemon_parse_float(argv[0], &arg_0)) return DAEMON_ERR_BAD_ARGS;
    if (arg_0 < 0.0) return DAEMON_ERR_RANGE;
    if (arg_0 > 1.0) return DAEMON_ERR_RANGE;
    daemon_cmd_bwd(arg_0);
    return DAEMON_OK;
  }

  if (strcmp(token, "STRAFE") == 0) {
    if (argc != 2) return DAEMON_ERR_BAD_ARGS;
    const char *arg_0 = argv[0];
    float arg_1 = 0.0f;
    if (!daemon_parse_float(argv[1], &arg_1)) return DAEMON_ERR_BAD_ARGS;
    if (arg_1 < 0.0) return DAEMON_ERR_RANGE;
    if (arg_1 > 1.0) return DAEMON_ERR_RANGE;
    daemon_cmd_strafe(arg_0, arg_1);
    return DAEMON_OK;
  }

  if (strcmp(token, "TURN") == 0) {
    if (argc != 1) return DAEMON_ERR_BAD_ARGS;
    float arg_0 = 0.0f;
    if (!daemon_parse_float(argv[0], &arg_0)) return DAEMON_ERR_BAD_ARGS;
    if (arg_0 < -180.0) return DAEMON_ERR_RANGE;
    if (arg_0 > 180.0) return DAEMON_ERR_RANGE;
    daemon_cmd_turn(arg_0);
    return DAEMON_OK;
  }

  if (strcmp(token, "MECANUM") == 0) {
    if (argc != 1) return DAEMON_ERR_BAD_ARGS;
    const char *arg_0 = argv[0];
    daemon_cmd_mecanum(arg_0);
    return DAEMON_OK;
  }

  if (strcmp(token, "STOP") == 0) {
    if (argc != 0) return DAEMON_ERR_BAD_ARGS;
    daemon_cmd_stop();
    return DAEMON_OK;
  }

  return DAEMON_ERR_BAD_TOKEN;
}
