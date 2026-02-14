import { useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import "./App.css";

const DEFAULT_VERCEL_BASE_URL = "https://daemon-ten-chi.vercel.app";
const DEFAULT_ORCH_BASE_URL = "http://127.0.0.1:5055";
const FRAME_WIDTH = 320;
const FRAME_HEIGHT = 240;
const DEFAULT_CAPTURE_INTERVAL_MS = 300;
const STATUS_POLL_MS = 2000;
const RUNTIME_IS_TAURI = isTauri();

const VERCEL_BASE_URL = import.meta.env.VITE_VERCEL_BASE_URL || DEFAULT_VERCEL_BASE_URL;
const ORCH_BASE_URL = import.meta.env.VITE_ORCHESTRATOR_BASE_URL || DEFAULT_ORCH_BASE_URL;

const INITIAL_STATE = {
  stage: "SEARCH",
  scan_dir: 1,
  scan_ticks: 0,
  capabilities: {
    base_target: "base",
    arm_target: "arm",
    base_turn_token: "TURN",
    base_fwd_token: "FWD",
    arm_grip_token: "GRIP"
  }
};

const DEFAULT_PROMPT = "pick up the banana";

function nowStamp() {
  return new Date().toLocaleTimeString();
}

async function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const full = String(reader.result || "");
      const base64 = full.includes(",") ? full.split(",")[1] : full;
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function captureFrameBase64(video, canvas) {
  if (!video || !canvas || video.readyState < 2) {
    return null;
  }

  canvas.width = FRAME_WIDTH;
  canvas.height = FRAME_HEIGHT;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    return null;
  }

  ctx.drawImage(video, 0, 0, FRAME_WIDTH, FRAME_HEIGHT);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.6));
  if (!blob) {
    return null;
  }

  return blobToBase64(blob);
}

async function postVisionJson(url, body) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data?.error || data?.message || `HTTP ${resp.status}`);
  }

  return data;
}

function drawOverlay(canvas, perception) {
  if (!canvas) {
    return;
  }

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }

  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const target = perception?.selected_target || (perception?.found ? { bbox: perception?.bbox, confidence: perception?.confidence } : null);
  if (!target?.bbox) {
    return;
  }
  const { x, y, w: bw, h: bh } = target.bbox;
  const normalized = bw <= 1 && bh <= 1;
  const sx = normalized ? w : w / FRAME_WIDTH;
  const sy = normalized ? h : h / FRAME_HEIGHT;

  ctx.strokeStyle = "#4f8ff8";
  ctx.lineWidth = 2;
  ctx.strokeRect(x * sx, y * sy, bw * sx, bh * sy);

  const labelText = target?.label ? String(target.label) : "target";
  const label = `${labelText} ${Number(target?.confidence || 0).toFixed(2)}`;
  ctx.font = "13px ui-monospace, SFMono-Regular, Menlo, monospace";
  const tw = ctx.measureText(label).width;
  ctx.fillStyle = "rgba(13, 18, 24, 0.74)";
  ctx.fillRect(x * sx, Math.max(0, y * sy - 20), tw + 12, 18);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(label, x * sx + 6, Math.max(12, y * sy - 7));
}

async function orchestratorStatus(orchestratorBaseUrl) {
  if (RUNTIME_IS_TAURI) {
    try {
      return await invoke("orchestrator_status", { orchestratorBaseUrl });
    } catch (error) {
      throw new Error(`Tauri proxy GET ${orchestratorBaseUrl}/status failed: ${String(error)}`);
    }
  }

  const resp = await fetch(`${orchestratorBaseUrl}/status`);
  if (!resp.ok) {
    throw new Error(`GET ${orchestratorBaseUrl}/status failed: HTTP ${resp.status}`);
  }
  return resp.json();
}

async function orchestratorExecutePlan(orchestratorBaseUrl, plan) {
  if (RUNTIME_IS_TAURI) {
    try {
      return await invoke("orchestrator_execute_plan", { orchestratorBaseUrl, plan });
    } catch (error) {
      throw new Error(`Tauri proxy POST ${orchestratorBaseUrl}/execute_plan failed: ${String(error)}`);
    }
  }

  const resp = await fetch(`${orchestratorBaseUrl}/execute_plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plan })
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data?.error || `POST ${orchestratorBaseUrl}/execute_plan failed: HTTP ${resp.status}`);
  }
  return data;
}

async function orchestratorStop(orchestratorBaseUrl) {
  if (RUNTIME_IS_TAURI) {
    try {
      return await invoke("orchestrator_stop", { orchestratorBaseUrl });
    } catch (error) {
      throw new Error(`Tauri proxy POST ${orchestratorBaseUrl}/stop failed: ${String(error)}`);
    }
  }

  const resp = await fetch(`${orchestratorBaseUrl}/stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({})
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data?.error || `POST ${orchestratorBaseUrl}/stop failed: HTTP ${resp.status}`);
  }
  return data;
}

function App() {
  const videoRef = useRef(null);
  const captureCanvasRef = useRef(null);
  const overlayCanvasRef = useRef(null);
  const streamRef = useRef(null);
  const liveTimerRef = useRef(null);
  const inFlightRef = useRef(false);
  const stateRef = useRef(INITIAL_STATE);

  const [taskPrompt, setTaskPrompt] = useState(DEFAULT_PROMPT);
  const [captureIntervalMs] = useState(DEFAULT_CAPTURE_INTERVAL_MS);
  const [liveEnabled, setLiveEnabled] = useState(false);
  const [sendingFrames, setSendingFrames] = useState(false);
  const [dryRun, setDryRun] = useState(false);

  const [fsmState, setFsmState] = useState(INITIAL_STATE);
  const [perception, setPerception] = useState(null);
  const [lastPlan, setLastPlan] = useState([]);
  const [lastDebug, setLastDebug] = useState(null);

  const [orchestratorReachable, setOrchestratorReachable] = useState(false);
  const [lastOrchestratorError, setLastOrchestratorError] = useState("");
  const [lastActionText, setLastActionText] = useState("idle");
  const [lastActionTimestamp, setLastActionTimestamp] = useState("");
  const [errorText, setErrorText] = useState("");

  const promptReady = taskPrompt.trim().length > 0;

  const statusText = useMemo(() => {
    if (!liveEnabled) {
      return sendingFrames ? "single-step in progress" : "idle";
    }
    return sendingFrames ? "live loop active" : "live loop waiting";
  }, [liveEnabled, sendingFrames]);

  const capabilityNote = useMemo(() => {
    if (!taskPrompt.trim()) {
      return "Enter a task prompt to start.";
    }
    return "Live instruction is sent on every frame. Edit mid-run to change behavior on the next frame.";
  }, [taskPrompt]);

  useEffect(() => {
    drawOverlay(overlayCanvasRef.current, perception);
  }, [perception]);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        await orchestratorStatus(ORCH_BASE_URL);
        if (!cancelled) {
          setOrchestratorReachable(true);
          setLastOrchestratorError("");
        }
      } catch (error) {
        if (!cancelled) {
          setOrchestratorReachable(false);
          setLastOrchestratorError(String(error));
        }
      }
    };

    poll();
    const interval = setInterval(poll, STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const clearLiveTimer = () => {
    if (liveTimerRef.current) {
      clearInterval(liveTimerRef.current);
      liveTimerRef.current = null;
    }
  };

  const releaseCamera = () => {
    if (!streamRef.current) {
      return;
    }
    for (const track of streamRef.current.getTracks()) {
      track.stop();
    }
    streamRef.current = null;
  };

  const ensureCamera = async () => {
    if (streamRef.current && videoRef.current?.srcObject) {
      return;
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480 },
      audio: false
    });

    streamRef.current = stream;
    const video = videoRef.current;
    if (!video) {
      throw new Error("video element unavailable");
    }

    video.srcObject = stream;
    await video.play();

    if (overlayCanvasRef.current) {
      overlayCanvasRef.current.width = 640;
      overlayCanvasRef.current.height = 480;
    }
  };

  const stopLoop = async ({ sendStop }) => {
    clearLiveTimer();
    inFlightRef.current = false;
    setSendingFrames(false);
    setLiveEnabled(false);
    releaseCamera();

    if (!sendStop) {
      return;
    }

    try {
      await orchestratorStop(ORCH_BASE_URL);
      setOrchestratorReachable(true);
      setLastOrchestratorError("");
      setLastActionText("STOP OK");
      setLastActionTimestamp(nowStamp());
    } catch (error) {
      const msg = String(error);
      setOrchestratorReachable(false);
      setLastOrchestratorError(msg);
      setLastActionText("STOP FAILED");
      setLastActionTimestamp(nowStamp());
      setErrorText(`STOP failed: ${msg}`);
    }
  };

  useEffect(() => {
    return () => {
      stopLoop({ sendStop: false });
    };
  }, []);

  const executeSingleVisionStep = async ({ executePlan }) => {
    if (inFlightRef.current) {
      return;
    }

    if (!promptReady) {
      setErrorText("Task prompt is required.");
      return;
    }

    inFlightRef.current = true;
    setSendingFrames(true);

    try {
      await ensureCamera();
      const frame_jpeg_base64 = await captureFrameBase64(videoRef.current, captureCanvasRef.current);
      if (!frame_jpeg_base64) {
        throw new Error("camera frame unavailable");
      }

      const visionPayload = {
        frame_jpeg_base64,
        instruction: taskPrompt.trim(),
        state: stateRef.current,
        system_manifest: null,
        telemetry_snapshot: null
      };

      const visionResponse = await postVisionJson(`${VERCEL_BASE_URL}/api/vision_step`, visionPayload);
      const nextState = visionResponse?.state || stateRef.current;
      const nextPlan = Array.isArray(visionResponse?.plan) ? visionResponse.plan : [];

      stateRef.current = nextState;
      setFsmState(nextState);
      setPerception(visionResponse?.perception || null);
      setLastPlan(nextPlan);
      setLastDebug(visionResponse?.debug || null);
      setErrorText("");

      if (executePlan) {
        const response = await orchestratorExecutePlan(ORCH_BASE_URL, nextPlan);
        if (!response?.ok) {
          throw new Error(response?.error || "execute_plan returned non-ok response");
        }
        setOrchestratorReachable(true);
        setLastOrchestratorError("");
        setLastActionText("EXECUTE_PLAN OK");
      } else {
        setLastActionText("DRY RUN: plan generated only");
      }

      setLastActionTimestamp(nowStamp());

      if (String(nextState?.stage || "").toUpperCase() === "DONE" && liveEnabled) {
        await stopLoop({ sendStop: false });
      }
    } catch (error) {
      const msg = String(error);
      setErrorText(msg);
      setOrchestratorReachable(false);
      setLastOrchestratorError(msg);
      setLastActionText("STEP FAILED");
      setLastActionTimestamp(nowStamp());

      if (liveEnabled) {
        await stopLoop({ sendStop: true });
      }
    } finally {
      inFlightRef.current = false;
      setSendingFrames(false);
    }
  };

  const startLiveCamera = async () => {
    try {
      await ensureCamera();
      setFsmState(INITIAL_STATE);
      stateRef.current = INITIAL_STATE;
      setPerception(null);
      setLastPlan([]);
      setLastDebug(null);
      setErrorText("");
      setLiveEnabled(true);

      liveTimerRef.current = setInterval(() => {
        executeSingleVisionStep({ executePlan: !dryRun });
      }, captureIntervalMs);
    } catch (error) {
      setErrorText(`Camera start failed: ${String(error)}`);
      await stopLoop({ sendStop: false });
    }
  };

  const handleLiveToggle = async () => {
    if (liveEnabled) {
      await stopLoop({ sendStop: false });
      return;
    }
    await startLiveCamera();
  };

  const handleStop = async () => {
    await stopLoop({ sendStop: true });
  };

  const handleSingleStep = async () => {
    await executeSingleVisionStep({ executePlan: !dryRun });
  };

  return (
    <div className="studio">
      <div className="hero">
        <div>
          <p className="eyebrow">DAEMON Control Studio</p>
          <h1>Natural-Language Robot Control</h1>
          <p className="sub">Write the task in plain language. The app loops camera perception + plan execution in real time.</p>
        </div>
        <div className={orchestratorReachable ? "health ok" : "health bad"}>
          <span className="dot" />
          <span>{orchestratorReachable ? "Orchestrator Online" : "Orchestrator Offline"}</span>
        </div>
      </div>

      <section className="prompt-card">
        <label htmlFor="taskPrompt">Task Prompt</label>
        <div className="prompt-row">
          <input
            id="taskPrompt"
            value={taskPrompt}
            onChange={(event) => setTaskPrompt(event.target.value)}
            placeholder="pick up the banana"
          />
          <button className="ghost" onClick={() => setTaskPrompt(DEFAULT_PROMPT)}>Reset</button>
        </div>
        <p className="note">{capabilityNote}</p>
      </section>

      <section className="controls">
        <button className={liveEnabled ? "primary active" : "primary"} onClick={handleLiveToggle} disabled={!promptReady}>
          {liveEnabled ? "Stop Live Loop" : "Enable Live Camera"}
        </button>
        <button className="secondary" onClick={handleSingleStep} disabled={!promptReady}>Single Step</button>
        <button className="panic" onClick={handleStop}>STOP</button>
        <label className="toggle">
          <input type="checkbox" checked={dryRun} onChange={(event) => setDryRun(event.target.checked)} />
          <span>Dry Run</span>
        </label>
      </section>

      <section className="meta-grid">
        <div><strong>Runtime:</strong> {RUNTIME_IS_TAURI ? "Tauri" : "Browser fallback"}</div>
        <div><strong>Status:</strong> {statusText}</div>
        <div><strong>FSM:</strong> {String(fsmState?.stage || "SEARCH")}</div>
        <div><strong>Last action:</strong> {lastActionText || "-"}</div>
        <div><strong>At:</strong> {lastActionTimestamp || "-"}</div>
        <div><strong>Vision API:</strong> {VERCEL_BASE_URL}</div>
      </section>

      {lastOrchestratorError ? <section className="error">Last orchestrator error: {lastOrchestratorError}</section> : null}
      {errorText ? <section className="error">{errorText}</section> : null}

      <main className="grid">
        <section className="panel video-panel">
          <h2>Live Camera</h2>
          <div className="video-shell">
            <video ref={videoRef} autoPlay muted playsInline className="video" />
            <canvas ref={overlayCanvasRef} className="overlay" />
          </div>
          <canvas ref={captureCanvasRef} className="hidden-canvas" />
          <div className="metrics">
            <span>found: {String(Boolean(perception?.found))}</span>
            <span>confidence: {Number(perception?.confidence || 0).toFixed(3)}</span>
            <span>offset_x: {Number(perception?.offset_x || perception?.center_offset_x || 0).toFixed(3)}</span>
            <span>area: {Number(perception?.area || 0).toFixed(1)}</span>
          </div>
        </section>

        <section className="panel">
          <h2>Perception + State</h2>
          <pre>{JSON.stringify({ state: fsmState, perception, debug: lastDebug }, null, 2)}</pre>
        </section>

        <section className="panel">
          <h2>Last Plan</h2>
          <pre>{JSON.stringify(lastPlan, null, 2)}</pre>
        </section>
      </main>
    </div>
  );
}

export default App;
