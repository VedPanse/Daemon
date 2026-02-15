#include <AFMotor.h>
#include <ctype.h>
#include <string.h>

AF_DCMotor FL(1);
AF_DCMotor FR(4);
AF_DCMotor RL(2);
AF_DCMotor RR(3);

int speedVal = 180;

void runPrimitive(char cmd) {
  switch (cmd) {
    case 'F':
      forward();
      break;
    case 'B':
      backward();
      break;
    case 'L':
      strafeLeft();
      break;
    case 'R':
      strafeRight();
      break;
    case 'Q':
      rotateLeft();
      break;
    case 'E':
      rotateRight();
      break;
    default:
      stopAll();
      break;
  }
}

void stopAll() {
  FL.run(RELEASE);
  FR.run(RELEASE);
  RL.run(RELEASE);
  RR.run(RELEASE);
}

void setAllSpeed(int spd){
  FL.setSpeed(spd);
  FR.setSpeed(spd);
  RL.setSpeed(spd);
  RR.setSpeed(spd);
}

void forward(){
  setAllSpeed(speedVal);
  FL.run(FORWARD);
  FR.run(BACKWARD);
  RL.run(BACKWARD);
  RR.run(FORWARD);
}

void backward(){
  setAllSpeed(speedVal);
  FL.run(BACKWARD);
  FR.run(FORWARD);
  RL.run(FORWARD);
  RR.run(BACKWARD);
}

void strafeLeft(){
  setAllSpeed(speedVal);
  FL.run(FORWARD);
  FR.run(FORWARD);
  RL.run(FORWARD);
  RR.run(FORWARD);
}

void strafeRight(){
  setAllSpeed(speedVal);
  FL.run(BACKWARD);
  FR.run(BACKWARD);
  RL.run(BACKWARD);
  RR.run(BACKWARD);
}

void rotateLeft(){
  setAllSpeed(speedVal);
  FL.run(BACKWARD);
  FR.run(BACKWARD);
  RL.run(FORWARD);
  RR.run(FORWARD);
}

void rotateRight(){
  setAllSpeed(speedVal);
  FL.run(FORWARD);
  FR.run(FORWARD);
  RL.run(BACKWARD);
  RR.run(BACKWARD);
}

void leftFront(){
  setAllSpeed(speedVal);
  FL.run(RELEASE);
  FR.run(BACKWARD);
  RL.run(BACKWARD);
  RR.run(RELEASE);
}

void rightFront(){
  setAllSpeed(speedVal);
  FL.run(FORWARD);
  FR.run(RELEASE);
  RL.run(RELEASE);
  RR.run(FORWARD);
}

void leftRear(){
  setAllSpeed(speedVal);
  FL.run(BACKWARD);
  FR.run(RELEASE);
  RL.run(RELEASE);
  RR.run(BACKWARD);
}

void rightRear(){
  setAllSpeed(speedVal);
  FL.run(RELEASE);
  FR.run(FORWARD);
  RL.run(FORWARD);
  RR.run(RELEASE);
}

void frontAxleLeftTurn(){
  setAllSpeed(speedVal);
  FL.run(RELEASE);
  FR.run(RELEASE);
  RL.run(BACKWARD);
  RR.run(FORWARD);
}

void frontAxleRightTurn(){
  setAllSpeed(speedVal);
  FL.run(RELEASE);
  FR.run(RELEASE);
  RL.run(FORWARD);
  RR.run(BACKWARD);
}

void rearAxleleftTurn(){
  setAllSpeed(speedVal);
  FL.run(BACKWARD);
  FR.run(BACKWARD);
  RL.run(RELEASE);
  RR.run(RELEASE);
}

void rearAxleRightTurn(){
  setAllSpeed(speedVal);
  FL.run(FORWARD);
  FR.run(FORWARD);
  RL.run(RELEASE);
  RR.run(RELEASE);
}

// @daemon:export token=FWD desc="Move forward" args="speed:float[0..1]" safety="rate_hz=20,watchdog_ms=1200,clamp=true" function=daemon_cmd_fwd
void daemon_cmd_fwd(float speed) {
  (void)speed;
  forward();
}

// @daemon:export token=BWD desc="Move backward" args="speed:float[0..1]" safety="rate_hz=20,watchdog_ms=1200,clamp=true" function=daemon_cmd_bwd
void daemon_cmd_bwd(float speed) {
  (void)speed;
  backward();
}

// @daemon:export token=STRAFE desc="Strafe left/right" args="dir:string,speed:float[0..1]" safety="rate_hz=20,watchdog_ms=1200,clamp=true" function=daemon_cmd_strafe
void daemon_cmd_strafe(const char *dir, float speed) {
  (void)speed;
  if (dir == NULL || dir[0] == '\0') {
    stopAll();
    return;
  }
  char d = (char)toupper((unsigned char)dir[0]);
  if (d == 'L') {
    strafeLeft();
  } else if (d == 'R') {
    strafeRight();
  } else {
    stopAll();
  }
}

// @daemon:export token=TURN desc="Rotate in place by signed degrees" args="degrees:float[-180..180]" safety="rate_hz=20,watchdog_ms=1200,clamp=true" function=daemon_cmd_turn
void daemon_cmd_turn(float degrees) {
  if (degrees < 0) {
    rotateLeft();
  } else if (degrees > 0) {
    rotateRight();
  } else {
    stopAll();
  }
}

// @daemon:export token=MECANUM desc="Direct primitive command (F,B,L,R,Q,E,S)" args="cmd:string" safety="rate_hz=30,watchdog_ms=1200,clamp=true" function=daemon_cmd_mecanum
void daemon_cmd_mecanum(const char *cmd) {
  if (cmd == NULL || cmd[0] == '\0') {
    stopAll();
    return;
  }
  runPrimitive((char)toupper((unsigned char)cmd[0]));
}

// @daemon:export token=STOP desc="Stop all motors" args="" safety="rate_hz=30,watchdog_ms=1200,clamp=true" function=daemon_cmd_stop
void daemon_cmd_stop(void) {
  stopAll();
}

void setup() {
  Serial.begin(9600);
  stopAll();
}

void loop() {
  if (Serial.available()) {
    char cmd = Serial.read();
    runPrimitive((char)toupper((unsigned char)cmd));
  }
}
