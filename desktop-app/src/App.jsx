import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

const SERIAL_EVENT = "serial_line";

function parseManifestPayload(rawPayload) {
  const payload = rawPayload.trim();

  try {
    return JSON.parse(payload);
  } catch {
    // Continue to base64 fallback.
  }

  try {
    const decoded = atob(payload);
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

function scoreCommand(part, command) {
  const q = part.toLowerCase();
  let score = 0;

  const tokenWords = (command.token || "").toLowerCase().split("_");
  if (tokenWords.every((word) => q.includes(word))) {
    score += 5;
  }

  if ((command.desc || "").toLowerCase().split(" ").some((word) => word && q.includes(word))) {
    score += 3;
  }

  const synonyms = command.nlp?.synonyms || [];
  for (const synonym of synonyms) {
    if (q.includes(String(synonym).toLowerCase())) {
      score += 4;
    }
  }

  return score;
}

function extractNumbers(text) {
  const matches = text.match(/-?\d+(?:\.\d+)?/g);
  return matches ? matches.map((piece) => Number(piece)) : [];
}

function planCommands(prompt, manifest) {
  const commands = manifest?.commands || [];
  if (!commands.length) {
    return [];
  }

  const normalized = prompt.trim().toLowerCase();
  if (!normalized) {
    return [];
  }

  if (normalized.includes("stop")) {
    return [{ token: "STOP", args: [] }];
  }

  const parts = normalized.split(/\bthen\b|\band then\b|,/).map((part) => part.trim()).filter(Boolean);
  const numbers = extractNumbers(normalized);
  let numberIndex = 0;

  const plan = [];
  for (const part of parts) {
    let best = null;
    for (const command of commands) {
      const score = scoreCommand(part, command);
      if (score > 0 && (!best || score > best.score)) {
        best = { command, score };
      }
    }

    if (!best) {
      continue;
    }

    const args = [];
    for (const arg of best.command.args || []) {
      if (numberIndex < numbers.length) {
        args.push(numbers[numberIndex]);
        numberIndex += 1;
      } else if (arg.min !== null && arg.min !== undefined) {
        args.push(arg.min);
      } else {
        args.push(0);
      }
    }

    plan.push({ token: best.command.token, args });
  }

  return plan;
}

function App() {
  const [ports, setPorts] = useState([]);
  const [selectedPort, setSelectedPort] = useState("");
  const [connectedPort, setConnectedPort] = useState("");
  const [manifest, setManifest] = useState(null);
  const [telemetry, setTelemetry] = useState([]);
  const [wireLog, setWireLog] = useState([]);
  const [chat, setChat] = useState([]);
  const [draft, setDraft] = useState("");
  const [errorText, setErrorText] = useState("");
  const [busy, setBusy] = useState(false);

  const catalog = useMemo(() => manifest?.commands || [], [manifest]);

  const pushLog = (line) => {
    setWireLog((prev) => [...prev.slice(-199), line]);
  };

  const refreshPorts = async () => {
    try {
      const result = await invoke("list_serial_ports");
      setPorts(result);
      if (!selectedPort && result.length > 0) {
        setSelectedPort(result[0].portName);
      }
      setErrorText("");
    } catch (error) {
      setErrorText(String(error));
    }
  };

  useEffect(() => {
    refreshPorts();

    let unlisten;
    listen(SERIAL_EVENT, (event) => {
      const line = String(event.payload || "").trim();
      if (!line) {
        return;
      }

      pushLog(line);

      if (line.startsWith("MANIFEST ")) {
        const payload = line.slice("MANIFEST ".length);
        const parsed = parseManifestPayload(payload);
        if (parsed && Array.isArray(parsed.commands)) {
          setManifest(parsed);
          setChat((prev) => [...prev, { role: "assistant", content: `Manifest loaded (${parsed.commands.length} commands).` }]);
        } else {
          setChat((prev) => [...prev, { role: "assistant", content: "Manifest payload could not be parsed." }]);
        }
      } else if (line.startsWith("TELEMETRY ")) {
        setTelemetry((prev) => [...prev.slice(-99), line.slice("TELEMETRY ".length)]);
      } else if (line.startsWith("ERR ")) {
        setChat((prev) => [...prev, { role: "assistant", content: `Device error: ${line}` }]);
      }
    }).then((cleanup) => {
      unlisten = cleanup;
    });

    invoke("get_connection_status")
      .then((status) => {
        if (status.connected && status.portName) {
          setConnectedPort(status.portName);
        }
      })
      .catch(() => {});

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  const connect = async () => {
    if (!selectedPort) {
      setErrorText("Select a serial port first.");
      return;
    }

    setBusy(true);
    try {
      const status = await invoke("connect_serial", { portName: selectedPort, baudRate: 115200 });
      if (status.connected) {
        setConnectedPort(status.portName || selectedPort);
        setManifest(null);
        setTelemetry([]);
        setWireLog([]);
        await invoke("send_serial_line", { line: "HELLO" });
        await invoke("send_serial_line", { line: "READ_MANIFEST" });
        setChat((prev) => [...prev, { role: "assistant", content: `Connected to ${selectedPort}. Requested manifest.` }]);
      }
      setErrorText("");
    } catch (error) {
      setErrorText(String(error));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await invoke("disconnect_serial");
      setConnectedPort("");
      setManifest(null);
      setTelemetry([]);
      setErrorText("");
    } catch (error) {
      setErrorText(String(error));
    } finally {
      setBusy(false);
    }
  };

  const sendInstruction = async () => {
    const prompt = draft.trim();
    if (!prompt || !connectedPort) {
      return;
    }

    const plan = planCommands(prompt, manifest);

    setChat((prev) => [...prev, { role: "user", content: prompt }]);
    setDraft("");

    if (!plan.length) {
      setChat((prev) => [...prev, { role: "assistant", content: "No matching command found in manifest catalog." }]);
      return;
    }

    const planText = plan.map((step) => `RUN ${step.token}${step.args.length ? ` ${step.args.join(" ")}` : ""}`).join(" | ");
    setChat((prev) => [...prev, { role: "assistant", content: `Plan: ${planText}` }]);

    for (const step of plan) {
      try {
        if (step.token === "STOP") {
          await invoke("send_serial_line", { line: "STOP" });
        } else {
          const line = `RUN ${step.token}${step.args.length ? ` ${step.args.join(" ")}` : ""}`;
          await invoke("send_serial_line", { line });
        }
      } catch (error) {
        setChat((prev) => [...prev, { role: "assistant", content: `Send failed: ${String(error)}` }]);
      }
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <h1>DAEMON Desktop</h1>
        <div className="connect-row">
          <select value={selectedPort} onChange={(event) => setSelectedPort(event.target.value)}>
            {ports.map((port) => (
              <option key={port.portName} value={port.portName}>
                {port.portName} ({port.portType})
              </option>
            ))}
            {!ports.length && <option value="">No serial ports</option>}
          </select>
          <button onClick={refreshPorts} disabled={busy}>Refresh</button>
          {!connectedPort && <button onClick={connect} disabled={busy || !selectedPort}>Connect</button>}
          {connectedPort && <button onClick={disconnect} disabled={busy}>Disconnect</button>}
        </div>
      </header>

      <div className="status-row">
        <span>{connectedPort ? `Connected: ${connectedPort}` : "Disconnected"}</span>
        {errorText && <span className="error">{errorText}</span>}
      </div>

      <main className="grid">
        <section className="panel chat-panel">
          <h2>Chat</h2>
          <div className="chat-log">
            {chat.map((message, idx) => (
              <div key={`${message.role}-${idx}`} className={`msg ${message.role}`}>
                <strong>{message.role === "user" ? "You" : "Agent"}:</strong> {message.content}
              </div>
            ))}
            {!chat.length && <div className="empty">Send a natural language command after connecting.</div>}
          </div>
          <div className="composer">
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Example: go forward 30 then turn left 90"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  sendInstruction();
                }
              }}
            />
            <button onClick={sendInstruction} disabled={!connectedPort}>Send</button>
            <button onClick={() => invoke("send_serial_line", { line: "STOP" })} disabled={!connectedPort}>STOP</button>
          </div>
        </section>

        <section className="panel manifest-panel">
          <h2>Manifest</h2>
          <div className="manifest-list">
            {catalog.map((cmd) => (
              <div key={cmd.token} className="cmd-card">
                <div className="cmd-token">{cmd.token}</div>
                <div className="cmd-desc">{cmd.desc}</div>
                <div className="cmd-args">
                  {(cmd.args || []).length
                    ? cmd.args.map((arg) => `${arg.name}:${arg.type}`).join(", ")
                    : "No args"}
                </div>
              </div>
            ))}
            {!catalog.length && <div className="empty">Manifest not loaded.</div>}
          </div>
        </section>

        <section className="panel telemetry-panel">
          <h2>Telemetry</h2>
          <div className="telemetry-log">
            {telemetry.map((line, idx) => (
              <div key={`${line}-${idx}`}>{line}</div>
            ))}
            {!telemetry.length && <div className="empty">No telemetry yet.</div>}
          </div>
        </section>

        <section className="panel wire-panel">
          <h2>Wire Log</h2>
          <div className="wire-log">
            {wireLog.map((line, idx) => (
              <div key={`${line}-${idx}`}>{line}</div>
            ))}
            {!wireLog.length && <div className="empty">No serial messages yet.</div>}
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;
