# Desktop Reference Notes

This sprint does not modify `desktop-app/`.

Desktop consumers should:
1. Open transport with serial line protocol v1.
2. Send `HELLO`, then `READ_MANIFEST`.
3. Parse `MANIFEST <json>`.
4. Send only catalog-safe `RUN <TOKEN> <args>` and `STOP`.
5. Display `OK`, `ERR ...`, and `TELEMETRY ...`.
