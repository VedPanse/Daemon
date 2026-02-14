import { useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import "./App.css";

const DEFAULT_VERCEL_BASE_URL = "https://daemon-ten-chi.vercel.app";
const DEFAULT_ORCH_BASE_URL = "http://127.0.0.1:5055";
const FRAME_WIDTH = 320;
const FRAME_HEIGHT = 240;
const DEFAULT_CAPTURE_INTERVAL_MS = 180;
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

function drawOverlay(canvas, perception, debug) {
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

  const objects = Array.isArray(perception?.objects) ? perception.objects : [];
  const target = perception?.selected_target || (perception?.found ? { bbox: perception?.bbox, confidence: perception?.confidence, label: "target" } : null);

  const toCanvasRect = (bbox) => {
    if (!bbox) {
      return null;
    }
    const normalized = bbox.w <= 1 && bbox.h <= 1 && bbox.x <= 1 && bbox.y <= 1;
    const sx = normalized ? w : w / FRAME_WIDTH;
    const sy = normalized ? h : h / FRAME_HEIGHT;
    return { x: bbox.x * sx, y: bbox.y * sy, w: bbox.w * sx, h: bbox.h * sy };
  };

  for (const obj of objects) {
    const rect = toCanvasRect(obj?.bbox);
    if (!rect) continue;
    ctx.strokeStyle = "rgba(90, 180, 255, 0.7)";
    ctx.lineWidth = 1.25;
    ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
  }

  if (target?.bbox) {
    const rect = toCanvasRect(target.bbox);
    if (rect) {
      ctx.strokeStyle = "#4f8ff8";
      ctx.lineWidth = 3;
      ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);

      const labelText = target?.label ? String(target.label) : "target";
      const label = `${labelText} ${Number(target?.confidence || 0).toFixed(2)}`;
      ctx.font = "13px ui-monospace, SFMono-Regular, Menlo, monospace";
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = "rgba(13, 18, 24, 0.84)";
      ctx.fillRect(rect.x, Math.max(0, rect.y - 20), tw + 12, 18);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(label, rect.x + 6, Math.max(12, rect.y - 7));
    }
  }

  const branch = String(debug?.policy_branch || "NONE");
  const source = String(debug?.perception_source || "none");
  const selectedLabel = target?.label ? String(target.label) : "-";
  const selectedConfidence = Number(target?.confidence || 0).toFixed(2);
  const hudLines = [
    `branch: ${branch}`,
    `target: ${selectedLabel}`,
    `conf: ${selectedConfidence}`,
    `source: ${source}`
  ];

  ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, monospace";
  const hudWidth = Math.max(...hudLines.map((line) => ctx.measureText(line).width)) + 12;
  const hudHeight = hudLines.length * 16 + 8;
  ctx.fillStyle = "rgba(10, 12, 15, 0.68)";
  ctx.fillRect(8, 8, hudWidth, hudHeight);
  ctx.fillStyle = "#ffffff";
  hudLines.forEach((line, idx) => {
    ctx.fillText(line, 14, 24 + idx * 16);
  });
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
  const liveEnabledRef = useRef(false);
  const loopIntervalRef = useRef(DEFAULT_CAPTURE_INTERVAL_MS);
  const inFlightRef = useRef(false);
  const stateRef = useRef(INITIAL_STATE);
  const appliedPromptRef = useRef(DEFAULT_PROMPT);

  const [taskPrompt, setTaskPrompt] = useState(DEFAULT_PROMPT);
  const [draftPrompt, setDraftPrompt] = useState(DEFAULT_PROMPT);
  const [captureIntervalMs, setCaptureIntervalMs] = useState(DEFAULT_CAPTURE_INTERVAL_MS);
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
  const [lastSentInstruction, setLastSentInstruction] = useState("");
  const [errorText, setErrorText] = useState("");
  const [chartSeries, setChartSeries] = useState([]);

  const promptReady = taskPrompt.trim().length > 0;
  const draftReady = draftPrompt.trim().length > 0;

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
    return `Applied prompt: "${taskPrompt}". Edit text and click Send to update behavior on the next frame.`;
  }, [taskPrompt]);

  const applyPrompt = () => {
    const next = draftPrompt.trim();
    if (!next) {
      setErrorText("Task prompt is required.");
      return;
    }
    setTaskPrompt(next);
    appliedPromptRef.current = next;
    setErrorText("");
  };

  useEffect(() => {
    appliedPromptRef.current = taskPrompt.trim() || DEFAULT_PROMPT;
  }, [taskPrompt]);

  useEffect(() => {
    drawOverlay(overlayCanvasRef.current, perception, lastDebug);
  }, [perception, lastDebug]);

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
      clearTimeout(liveTimerRef.current);
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
    liveEnabledRef.current = false;
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

      const instructionToSend = appliedPromptRef.current.trim();
      const visionPayload = {
        frame_jpeg_base64,
        instruction: instructionToSend,
        state: stateRef.current
      };
      setLastSentInstruction(instructionToSend);

      const visionResponse = await postVisionJson(`${VERCEL_BASE_URL}/api/vision_step`, visionPayload);
      const nextState = visionResponse?.state || stateRef.current;
      const nextPlan = Array.isArray(visionResponse?.plan) ? visionResponse.plan : [];

      stateRef.current = nextState;
      setFsmState(nextState);
      setPerception(visionResponse?.perception || null);
      setLastPlan(nextPlan);
      setLastDebug(visionResponse?.debug || null);
      const suggestedInterval = Number(nextState?.perf_ctx?.recommended_interval_ms || DEFAULT_CAPTURE_INTERVAL_MS);
      const boundedInterval = Math.max(80, Math.min(600, suggestedInterval));
      loopIntervalRef.current = boundedInterval;
      setCaptureIntervalMs(boundedInterval);

      const verification = visionResponse?.debug?.verification || {};
      const learning = visionResponse?.debug?.learning || {};
      const totalLatency = Number(visionResponse?.debug?.timings_ms?.total || 0);
      setChartSeries((prev) => {
        const next = [
          ...prev,
          {
            t: Date.now(),
            verification_conf: Number(verification?.confidence || 0),
            latency_ms: totalLatency,
            on_track_ratio:
              Number(learning?.frames || 0) > 0 ? Number(learning?.on_track_frames || 0) / Number(learning?.frames || 1) : 0,
            false_switches: Number(learning?.false_switches || 0),
            recovery_count: Number(learning?.recovery_count || 0)
          }
        ];
        return next.slice(-120);
      });
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
      setChartSeries([]);
      setErrorText("");
      setLiveEnabled(true);
      liveEnabledRef.current = true;
      loopIntervalRef.current = DEFAULT_CAPTURE_INTERVAL_MS;
      setCaptureIntervalMs(DEFAULT_CAPTURE_INTERVAL_MS);

      const loop = async () => {
        if (!liveEnabledRef.current) {
          return;
        }
        await executeSingleVisionStep({ executePlan: !dryRun });
        if (liveEnabledRef.current) {
          liveTimerRef.current = setTimeout(loop, loopIntervalRef.current);
        }
      };
      await loop();
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
            value={draftPrompt}
            onChange={(event) => setDraftPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                applyPrompt();
              }
            }}
            placeholder="pick up the banana"
          />
          <button className="secondary" onClick={applyPrompt} disabled={!draftReady}>Send</button>
          <button
            className="ghost"
            onClick={() => {
              setDraftPrompt(DEFAULT_PROMPT);
              setTaskPrompt(DEFAULT_PROMPT);
            }}
          >
            Reset
          </button>
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
        <div><strong>Loop ms:</strong> {captureIntervalMs}</div>
        <div><strong>FPS:</strong> {captureIntervalMs > 0 ? (1000 / captureIntervalMs).toFixed(1) : "-"}</div>
        <div><strong>Verify:</strong> {String(lastDebug?.verification?.status || "unknown")}</div>
        <div><strong>Last action:</strong> {lastActionText || "-"}</div>
        <div><strong>At:</strong> {lastActionTimestamp || "-"}</div>
        <div><strong>Vision API:</strong> {VERCEL_BASE_URL}</div>
        <div><strong>Applied instruction:</strong> {taskPrompt}</div>
        <div><strong>Last sent instruction:</strong> {lastSentInstruction || "-"}</div>
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

        <section className="panel">
          <h2>Learning + Verification Chart</h2>
          <svg viewBox="0 0 600 220" width="100%" height="220" role="img" aria-label="learning chart">
            <rect x="0" y="0" width="600" height="220" fill="#0d1117" />
            {(() => {
              if (!chartSeries.length) {
                return <text x="20" y="30" fill="#9fb3c8" fontSize="14">No data yet</text>;
              }
              const mapPoints = (arr, valueFn, min, max) =>
                arr
                  .map((d, i) => {
                    const x = (i / Math.max(1, arr.length - 1)) * 580 + 10;
                    const v = valueFn(d);
                    const y = 200 - ((Math.max(min, Math.min(max, v)) - min) / Math.max(1e-6, max - min)) * 170;
                    return `${x},${y}`;
                  })
                  .join(" ");
              const latencyMax = Math.max(200, ...chartSeries.map((d) => d.latency_ms));
              const pVerify = mapPoints(chartSeries, (d) => d.verification_conf, 0, 1);
              const pLatency = mapPoints(chartSeries, (d) => d.latency_ms, 0, latencyMax);
              const pOnTrack = mapPoints(chartSeries, (d) => d.on_track_ratio, 0, 1);
              return (
                <>
                  <polyline points={pVerify} fill="none" stroke="#7dd3fc" strokeWidth="2" />
                  <polyline points={pOnTrack} fill="none" stroke="#86efac" strokeWidth="2" />
                  <polyline points={pLatency} fill="none" stroke="#fca5a5" strokeWidth="2" />
                  <text x="12" y="18" fill="#7dd3fc" fontSize="12">verification confidence</text>
                  <text x="220" y="18" fill="#86efac" fontSize="12">on_track ratio</text>
                  <text x="360" y="18" fill="#fca5a5" fontSize="12">latency ms</text>
                </>
              );
            })()}
          </svg>
          <div className="metrics">
            <span>false_switches: {Number(lastDebug?.learning?.false_switches || 0)}</span>
            <span>recovery_count: {Number(lastDebug?.learning?.recovery_count || 0)}</span>
            <span>avg_latency_ms: {Number(lastDebug?.learning?.avg_latency_ms || 0).toFixed(1)}</span>
            <span>confidence_floor: {Number(lastDebug?.learning?.confidence_floor || 0).toFixed(3)}</span>
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;
