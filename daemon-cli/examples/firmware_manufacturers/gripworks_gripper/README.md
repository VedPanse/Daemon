# GripWorks Gripper Module

This example models manufacturer firmware for a gripper-only end-effector module.

Exported controls:
- `GRIP(state)` for gripper state
- `GRIP_FORCE(n)` for force setpoint in newtons `[0..40]`

Telemetry ideas (documented in source comments): `grip_state`, `grip_force_n`.
