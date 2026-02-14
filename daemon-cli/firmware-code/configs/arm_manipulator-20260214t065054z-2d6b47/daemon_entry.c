#include <stdbool.h>
#include <stddef.h>

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
