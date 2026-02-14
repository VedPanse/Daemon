# SkyLift Robotics Drone Controller

This example models manufacturer firmware for a drone-like controller node.

Exported controls:
- `THROTTLE(p)` for normalized throttle `[0..1]`
- `YAW(deg)` for heading adjustment `[-180..180]`
- `STOP()` for explicit motor stop command token

Telemetry ideas (documented in source comments): `altitude_m`, `yaw_deg`.
