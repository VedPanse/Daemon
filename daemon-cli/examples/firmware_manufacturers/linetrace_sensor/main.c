#include <stdint.h>

static int g_calibration = 0;

// Telemetry keys (future): line_left, line_right, reflectance
// @daemon:export token=CALIBRATE desc="Calibrate line sensor" args="level:int[0..3]" safety="rate_hz=5,watchdog_ms=800,clamp=true" function=calibrate
void calibrate(int level) {
    g_calibration = level;
}
