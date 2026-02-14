# Multi-Manufacturer Composition

## Runtime model
- Manufacturer A (robot base) runs `daemon build` in their own firmware repo and ships a DAEMON node.
- Manufacturer B (arm) does the same in a separate firmware repo.
- End user plugs both devices in and runs orchestrator with both node endpoints.

## Composition
- Orchestrator reads each node manifest at runtime.
- It fuses capabilities into a single command catalog.
- Planner output references node `target` plus token.
- If a token collides across nodes, plan must use explicit target.

## How multiple manufacturers compose
- `skylift_drone` (SkyLift Robotics): drone control (`THROTTLE`, `YAW`, `STOP`) plus drone telemetry keys.
- `gripworks_gripper` (GripWorks): gripper module (`GRIP`, `GRIP_FORCE`) with manipulation telemetry.
- `linetrace_sensor` (LineTrace): telemetry-heavy sensor node (`CALIBRATE`) for line/reflectance streams.
- Composition remains runtime-only through manifests and orchestrator routing; firmware binaries stay separate.

## What is not required
- No firmware merging across manufacturers.
- No shared monolithic binary.
- No cloud dependency for local orchestration and fallback planning.
