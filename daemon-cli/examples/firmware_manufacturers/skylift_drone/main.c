#include <stdint.h>

static float g_throttle = 0.0f;
static float g_yaw_deg = 0.0f;

// Telemetry keys (future): altitude_m, yaw_deg
// @daemon:export token=THROTTLE desc="Set drone throttle" args="p:float[0..1]" safety="rate_hz=25,watchdog_ms=300,clamp=true" function=set_throttle
void set_throttle(float p) {
    g_throttle = p;
}

// @daemon:export token=YAW desc="Yaw drone heading" args="deg:float[-180..180]" safety="rate_hz=20,watchdog_ms=300,clamp=true" function=yaw_to
void yaw_to(float deg) {
    g_yaw_deg = deg;
}

// @daemon:export token=STOP desc="Stop propellers" args="" safety="rate_hz=10,watchdog_ms=300,clamp=true" function=stop_motors
void stop_motors(void) {
    g_throttle = 0.0f;
}
