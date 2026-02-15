#include "daemon_runtime.h"

#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

void mc_init(void);
void mc_set_drive(int throttle_percent, int steering_percent);
void mc_emergency_stop(void);

int daemon_entry_dispatch(const char *token, int argc, const char **argv) {
  if (token == NULL) return DAEMON_ERR_BAD_TOKEN;
  if (strcmp(token, "STOP") == 0) {
    daemon_runtime_stop();
    return DAEMON_OK;
  }

  if (strcmp(token, "INIT") == 0) {
    if (argc != 0) return DAEMON_ERR_BAD_ARGS;
    mc_init();
    return DAEMON_OK;
  }

  if (strcmp(token, "DRIVE") == 0) {
    if (argc != 2) return DAEMON_ERR_BAD_ARGS;
    int arg_0 = 0;
    if (!daemon_parse_int(argv[0], &arg_0)) return DAEMON_ERR_BAD_ARGS;
    if (arg_0 < -100.0) return DAEMON_ERR_RANGE;
    if (arg_0 > 100.0) return DAEMON_ERR_RANGE;
    int arg_1 = 0;
    if (!daemon_parse_int(argv[1], &arg_1)) return DAEMON_ERR_BAD_ARGS;
    if (arg_1 < -100.0) return DAEMON_ERR_RANGE;
    if (arg_1 > 100.0) return DAEMON_ERR_RANGE;
    mc_set_drive(arg_0, arg_1);
    return DAEMON_OK;
  }

  if (strcmp(token, "ESTOP") == 0) {
    if (argc != 0) return DAEMON_ERR_BAD_ARGS;
    mc_emergency_stop();
    return DAEMON_OK;
  }

  return DAEMON_ERR_BAD_TOKEN;
}
