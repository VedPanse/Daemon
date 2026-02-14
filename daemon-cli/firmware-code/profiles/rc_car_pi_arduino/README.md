# RC Car (Raspberry Pi + Arduino) Firmware Context

This profile splits responsibilities:
- Raspberry Pi: camera + higher-level planning
- Arduino: deterministic motor + steering control loop
- Serial protocol: newline-delimited JSON commands

Safety goals:
- Deadman timeout if command stream stalls
- Max PWM clamp
- Steering angle clamp
