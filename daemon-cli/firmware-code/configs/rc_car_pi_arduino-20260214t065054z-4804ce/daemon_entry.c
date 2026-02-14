#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

typedef struct {
    int throttle_pct;
    int steering_pct;
    bool estop;
} daemon_state_t;

static daemon_state_t g_state = {0, 0, false};

static int clamp_i32(int value, int lo, int hi) {
    if (value < lo) return lo;
    if (value > hi) return hi;
    return value;
}

static void daemon_drive_set(int throttle_pct, int steering_pct) {
    if (g_state.estop) return;
    g_state.throttle_pct = clamp_i32(throttle_pct, -100, 100);
    g_state.steering_pct = clamp_i32(steering_pct, -100, 100);
    // TODO: map throttle/steering to PWM + servo outputs for platform wiring.
}

static void daemon_drive_brake(void) {
    g_state.throttle_pct = 0;
}

static void daemon_camera_snapshot(void) {
    // TODO: signal Raspberry Pi camera service over UART/SPI/shared memory.
}

static void daemon_emergency_stop(void) {
    g_state.estop = true;
    g_state.throttle_pct = 0;
}

void daemon_clear_estop(void) {
    g_state.estop = false;
}

int daemon_dispatch_command(const char *cmd, int a, int b) {
    if (strcmp(cmd, "drive.set") == 0) {
        daemon_drive_set(a, b);
        return 0;
    }
    if (strcmp(cmd, "drive.brake") == 0) {
        daemon_drive_brake();
        return 0;
    }
    if (strcmp(cmd, "camera.snapshot") == 0) {
        daemon_camera_snapshot();
        return 0;
    }
    if (strcmp(cmd, "safety.estop") == 0) {
        daemon_emergency_stop();
        return 0;
    }
    return -1;
}

void daemon_emit_state_telemetry(void) {
    printf(
        "{\"event\":\"telemetry.state\",\"throttle_pct\":%d,\"steering_pct\":%d}\n",
        g_state.throttle_pct,
        g_state.steering_pct
    );
}
