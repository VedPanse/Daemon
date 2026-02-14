#include "motor_controller.h"

static int16_t g_last_throttle = 0;
static int16_t g_last_steering = 0;
static uint16_t g_deadman_ticks = 0;

void mc_init(void) {
    g_last_throttle = 0;
    g_last_steering = 0;
    g_deadman_ticks = 0;
}

void mc_set_drive(int16_t throttle_percent, int16_t steering_percent) {
    if (throttle_percent > 100) throttle_percent = 100;
    if (throttle_percent < -100) throttle_percent = -100;
    if (steering_percent > 100) steering_percent = 100;
    if (steering_percent < -100) steering_percent = -100;

    g_last_throttle = throttle_percent;
    g_last_steering = steering_percent;
    g_deadman_ticks = 0;
}

void mc_emergency_stop(void) {
    g_last_throttle = 0;
}

void mc_tick_10ms(void) {
    g_deadman_ticks++;
    if (g_deadman_ticks > 50) {
        mc_emergency_stop();
    }
}
