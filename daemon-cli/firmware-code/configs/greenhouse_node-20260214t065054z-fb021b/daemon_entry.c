#include <stdbool.h>
#include <stdint.h>

static float g_target_humidity_pct = 55.0f;
static bool g_irrigation_override = false;
static uint32_t g_irrigation_override_until_s = 0;

static float clampf(float value, float lo, float hi) {
    if (value < lo) return lo;
    if (value > hi) return hi;
    return value;
}

void daemon_set_target_humidity(float humidity_pct) {
    g_target_humidity_pct = clampf(humidity_pct, 35.0f, 85.0f);
}

void daemon_set_irrigation_override(bool enabled, uint32_t duration_s, uint32_t now_s) {
    g_irrigation_override = enabled;
    g_irrigation_override_until_s = now_s + duration_s;
}

bool daemon_should_run_pump(float measured_humidity_pct, uint32_t now_s) {
    if (g_irrigation_override && now_s < g_irrigation_override_until_s) {
        return true;
    }
    return measured_humidity_pct < (g_target_humidity_pct - 4.0f);
}
