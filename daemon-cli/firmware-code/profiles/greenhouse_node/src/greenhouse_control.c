#include <stdbool.h>
#include <stdint.h>

static float g_target_humidity = 55.0f;
static bool g_pump_enabled = false;

void gh_set_target_humidity(float value) {
    if (value < 35.0f) value = 35.0f;
    if (value > 85.0f) value = 85.0f;
    g_target_humidity = value;
}

void gh_apply_humidity_control(float measured_humidity) {
    const float on_threshold = g_target_humidity - 4.0f;
    const float off_threshold = g_target_humidity + 2.0f;

    if (measured_humidity < on_threshold) g_pump_enabled = true;
    if (measured_humidity > off_threshold) g_pump_enabled = false;
}
