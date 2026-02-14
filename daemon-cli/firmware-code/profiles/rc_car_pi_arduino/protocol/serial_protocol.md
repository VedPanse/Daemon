# Serial JSON Protocol

Command message:
```json
{"cmd":"drive.set","throttle":42,"steering":-10}
```

Emergency stop:
```json
{"cmd":"safety.estop"}
```

Telemetry:
```json
{"event":"telemetry.state","battery_v":7.8,"speed_mps":1.2}
```
