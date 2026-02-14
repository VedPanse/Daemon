#include <stdint.h>

static int g_left = 0;
static int g_speed = 0;

// @daemon:export token=L desc="Turn left" args="intensity:int[0..255]" safety="rate_hz=20,watchdog_ms=300,clamp=true"
void move_left(int intensity) {
  g_left = intensity;
}

// @daemon:export token=FWD desc="Move forward" args="speed:int[0..100]" safety="rate_hz=10,watchdog_ms=500,clamp=true"
void move_forward(int speed) {
  g_speed = speed;
}

int main(void) {
  while (1) {
  }
  return 0;
}
