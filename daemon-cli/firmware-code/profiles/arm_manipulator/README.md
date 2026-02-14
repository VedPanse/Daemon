# Arm Manipulator Context

Six-DOF manipulator with:
- Joint motor drivers
- Limit switches and current sensing
- Cartesian move planner upstream

Firmware responsibilities:
- Enforce joint soft/hard limits
- Execute queued joint targets
- Emit deterministic motion state telemetry
