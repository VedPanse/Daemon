#include <string.h>

static char g_grip_state[8] = "open";
static float g_grip_force_n = 0.0f;

// Telemetry keys (future): grip_state, grip_force_n
// @daemon:export token=GRIP desc="Set gripper state" args="state:string[open..close]" safety="rate_hz=15,watchdog_ms=400,clamp=true" function=set_grip
void set_grip(const char *state) {
    if (state == 0) {
        return;
    }
    if (strcmp(state, "close") == 0) {
        strcpy(g_grip_state, "close");
    } else {
        strcpy(g_grip_state, "open");
    }
}

// @daemon:export token=GRIP_FORCE desc="Set gripper force" args="n:float[0..40]" safety="rate_hz=15,watchdog_ms=400,clamp=true" function=set_grip_force
void set_grip_force(float n) {
    g_grip_force_n = n;
}
