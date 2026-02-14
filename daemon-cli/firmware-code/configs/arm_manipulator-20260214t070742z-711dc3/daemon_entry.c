#include <stdbool.h>
#include <stddef.h>
#include <string.h>

typedef struct {
    float min_deg;
    float max_deg;
} limit_t;

static const limit_t JOINT_LIMITS[6] = {
    {-170.0f, 170.0f},
    {-120.0f, 120.0f},
    {-170.0f, 170.0f},
    {-190.0f, 190.0f},
    {-120.0f, 120.0f},
    {-360.0f, 360.0f},
};

static bool within_limits(size_t joint_id, float angle_deg) {
    if (joint_id >= 6) return false;
    return angle_deg >= JOINT_LIMITS[joint_id].min_deg && angle_deg <= JOINT_LIMITS[joint_id].max_deg;
}

int daemon_arm_move_joint(size_t joint_id, float angle_deg, float duration_s) {
    if (!within_limits(joint_id, angle_deg)) return -1;
    if (duration_s <= 0.0f || duration_s > 10.0f) return -2;
    // TODO: enqueue segment and stream progress telemetry.
    return 0;
}

int daemon_arm_home(void) {
    // TODO: run deterministic homing sequence with limit-switch checks.
    return 0;
}

int daemon_arm_stop(void) {
    // TODO: clear queued segments and disable motor outputs safely.
    return 0;
}

int daemon_dispatch_command(const char *cmd, size_t joint_id, float angle_deg, float duration_s) {
    if (strcmp(cmd, "arm.home") == 0) return daemon_arm_home();
    if (strcmp(cmd, "arm.stop") == 0) return daemon_arm_stop();
    if (strcmp(cmd, "arm.move_joint") == 0) return daemon_arm_move_joint(joint_id, angle_deg, duration_s);
    return -1;
}
