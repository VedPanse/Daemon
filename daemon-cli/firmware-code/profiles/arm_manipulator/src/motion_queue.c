#include <stdbool.h>

typedef struct {
    float target_deg[6];
    float duration_s;
} motion_segment_t;

bool mq_push(const motion_segment_t *segment);
bool mq_pop(motion_segment_t *segment);
