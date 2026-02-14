#ifndef MOTOR_CONTROLLER_H
#define MOTOR_CONTROLLER_H

#include <stdint.h>

void mc_init(void);
void mc_set_drive(int16_t throttle_percent, int16_t steering_percent);
void mc_emergency_stop(void);
void mc_tick_10ms(void);

#endif
