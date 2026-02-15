#include <AFMotor.h>
#include <string.h>

AF_DCMotor FL(1);
AF_DCMotor FR(4);
AF_DCMotor RL(2);
AF_DCMotor RR(3);

int speedVal = 180;

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

// DAEMON export wrappers: keep primitive motor routines unchanged while exposing
// stable NLP-friendly command tokens for generated manifests/dispatchers.
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
void daemon_cmd_strafe(const char* dir, float speed) {
  (void)speed;
  if (dir && (strcmp(dir, "L") == 0 || strcmp(dir, "l") == 0)) {
    strafeLeft();
    return;
  }
  if (dir && (strcmp(dir, "R") == 0 || strcmp(dir, "r") == 0)) {
    strafeRight();
    return;
  }
  stopAll();
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
void daemon_cmd_mecanum(const char* cmd) {
  if (!cmd || !cmd[0]) {
    stopAll();
    return;
  }
  char c = cmd[0];
  if (c == 'F') forward();
  else if (c == 'B') backward();
  else if (c == 'L') strafeLeft();
  else if (c == 'R') strafeRight();
  else if (c == 'Q') rotateLeft();
  else if (c == 'E') rotateRight();
  else stopAll();
}

// @daemon:export token=STOP desc="Stop all motors" args="" safety="rate_hz=30,watchdog_ms=1200,clamp=true" function=daemon_cmd_stop
void daemon_cmd_stop() {
  stopAll();
}

void setup() {
  Serial.begin(9600);
  stopAll();
}

void loop() {
  if (Serial.available()) {
    char cmd = Serial.read();

    if(cmd=='F') forward();
    else if(cmd=='B') backward();
    else if(cmd=='L') strafeLeft();
    else if(cmd=='R') strafeRight();
    else if(cmd=='Q') rotateLeft();
    else if(cmd=='E') rotateRight();
    else if(cmd=='S') stopAll();
  }
}
