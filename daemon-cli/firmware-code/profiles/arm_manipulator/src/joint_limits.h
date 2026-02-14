#ifndef JOINT_LIMITS_H
#define JOINT_LIMITS_H

typedef struct {
    float min_deg;
    float max_deg;
    float max_vel_deg_s;
} joint_limit_t;

extern const joint_limit_t JOINT_LIMITS[6];

#endif
