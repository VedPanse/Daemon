import { useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import "./App.css";

const DEFAULT_VERCEL_BASE_URL = "https://daemon-ten-chi.vercel.app";
const DEFAULT_ORCH_BASE_URL = "http://127.0.0.1:5055";
const DEFAULT_PI_BRAIN_BASE_URL = "http://vporto26.local:8090";
const FRAME_WIDTH = 640;
const FRAME_HEIGHT = 480;
const DEFAULT_CAPTURE_INTERVAL_MS = 180;
const STATUS_POLL_MS = 2000;
const RUNTIME_IS_TAURI = isTauri();

const VERCEL_BASE_URL = import.meta.env.VITE_VERCEL_BASE_URL || DEFAULT_VERCEL_BASE_URL;
const PI_BRAIN_BASE_URL = import.meta.env.VITE_PI_BRAIN_BASE_URL || DEFAULT_PI_BRAIN_BASE_URL;
const ORCH_BASE_URL = import.meta.env.VITE_ORCHESTRATOR_BASE_URL || DEFAULT_ORCH_BASE_URL;
const REMOTE_CAMERA_SNAPSHOT_URL = import.meta.env.VITE_REMOTE_CAMERA_SNAPSHOT_URL || "";
const REMOTE_CAMERA_MJPEG_URL = import.meta.env.VITE_REMOTE_CAMERA_MJPEG_URL || "";

const INITIAL_STATE = {
  stage: "SEARCH",
  scan_dir: 1,
  scan_ticks: 0,
  capabilities: {
    base_target: "base",
    arm_target: "arm",
    base_turn_token: "TURN",
    base_fwd_token: "FWD",
    base_strafe_token: "STRAFE",
    arm_grip_token: "GRIP"
  }
};

const DEFAULT_PROMPT = "move forward then backward";

function readLocalStorage(key) {
  try {
    return globalThis?.localStorage?.getItem(key);
  } catch {
    return null;
  }
}

function readPromptWithMigration(key) {
  const v = readLocalStorage(key);
  if (!v) return null;
  // Migrate the old demo default to the new default without overriding real user prompts.
  if (String(v).trim() === "pick up the banana") return null;
  return v;
}

function nowStamp() {
  return new Date().toLocaleTimeString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeCorrelationId() {
  try {
    if (globalThis.crypto?.randomUUID) {
      return `ui-${globalThis.crypto.randomUUID()}`;
    }
  } catch {
    // ignore
  }
  return `ui-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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

function manifestTokens(systemManifest) {
  const tokens = new Set();
  const nodes = Array.isArray(systemManifest?.nodes) ? systemManifest.nodes : [];
  for (const node of nodes) {
    const cmds = Array.isArray(node?.commands) ? node.commands : [];
    for (const cmd of cmds) {
      const tok = cmd?.token;
      if (typeof tok === "string" && tok.trim()) tokens.add(tok.trim());
    }
  }
  return tokens;
}

async function fetchSnapshotBase64(snapshotUrl) {
  const url = String(snapshotUrl || "").trim();
  if (!url) {
    return null;
  }
  const resp = await fetch(`${url}${url.includes("?") ? "&" : "?"}ts=${Date.now()}`, { cache: "no-store" });
  if (!resp.ok) {
    throw new Error(`Camera snapshot fetch failed: HTTP ${resp.status}`);
  }
  const blob = await resp.blob();
  return blobToBase64(blob);
}

async function postVisionJson(url, path, body, correlationId) {
  const base = String(url || "").replace(/\/+$/, "");
  const normalizedPath = String(path || "").startsWith("/") ? String(path || "") : `/${String(path || "")}`;
  const endpoint = `${base}${normalizedPath}`;

  // WKWebView networking (Tauri) can throw `TypeError: Load failed` even when the
  // endpoint is reachable. Proxy through Rust to make failures debuggable.
  if (RUNTIME_IS_TAURI) {
    try {
      return await invoke("vision_step", {
        visionBaseUrl: base,
        path: normalizedPath,
        payload: body,
        correlationId
      });
    } catch (error) {
      throw new Error(`Tauri proxy POST ${endpoint} failed: ${String(error)}`);
    }
  }

  let resp;
  try {
    resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Correlation-Id": correlationId
      },
      body: JSON.stringify(body)
    });
  } catch (error) {
    throw new Error(`POST ${endpoint} failed: ${String(error)}`);
  }

  const raw = await resp.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = {};
  }
  if (!resp.ok) {
    const msg = data?.message || data?.error || raw || `HTTP ${resp.status}`;
    const code = data?.error ? String(data.error) : null;
    throw new Error(code && data?.message ? `${code}: ${msg}` : msg);
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

async function orchestratorExecutePlan(orchestratorBaseUrl, plan, correlationId) {
  if (RUNTIME_IS_TAURI) {
    try {
      return await invoke("orchestrator_execute_plan", { orchestratorBaseUrl, plan, correlationId });
    } catch (error) {
      throw new Error(`Tauri proxy POST ${orchestratorBaseUrl}/execute_plan failed: ${String(error)}`);
    }
  }

  const resp = await fetch(`${orchestratorBaseUrl}/execute_plan`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-Id": correlationId
    },
    body: JSON.stringify({ plan, correlation_id: correlationId })
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
  const remoteImgRef = useRef(null);
  const captureCanvasRef = useRef(null);
  const overlayCanvasRef = useRef(null);
  const streamRef = useRef(null);
  const liveTimerRef = useRef(null);
  const liveEnabledRef = useRef(false);
  const criticTimerRef = useRef(null);
  const criticEnabledRef = useRef(false);
  const criticInFlightRef = useRef(false);
  const criticLoopFnRef = useRef(null);
  const criticQualStreakRef = useRef(0);
  const loopIntervalRef = useRef(DEFAULT_CAPTURE_INTERVAL_MS);
  const inFlightRef = useRef(false);
  const pendingStepRef = useRef(null);
  const stateRef = useRef(INITIAL_STATE);
  const appliedPromptRef = useRef(DEFAULT_PROMPT);

  const [taskPrompt, setTaskPrompt] = useState(readPromptWithMigration("daemon.taskPrompt") || DEFAULT_PROMPT);
  const [draftPrompt, setDraftPrompt] = useState(readPromptWithMigration("daemon.draftPrompt") || DEFAULT_PROMPT);
  const [captureIntervalMs, setCaptureIntervalMs] = useState(DEFAULT_CAPTURE_INTERVAL_MS);
  const [debugMode, setDebugMode] = useState(readLocalStorage("daemon.debugMode") === "1");
  const [liveEnabled, setLiveEnabled] = useState(false);
  const [sendingFrames, setSendingFrames] = useState(false);
  const [dryRun, setDryRun] = useState(false);
  const [visionMode, setVisionMode] = useState(() => {
    const stored = readLocalStorage("daemon.visionMode");
    if (stored === "pi" || stored === "cloud") return stored;
    const env = import.meta.env.VITE_VISION_MODE;
    if (env === "pi" || env === "cloud") return env;
    // Default to cloud in Tauri so camera preview + critic work out-of-the-box.
    return RUNTIME_IS_TAURI ? "cloud" : "pi";
  }); // pi | cloud

  const [criticEnabled, setCriticEnabled] = useState(false);
  const [criticError, setCriticError] = useState("");
  const [criticResult, setCriticResult] = useState(null);
  const [criticDoneText, setCriticDoneText] = useState("");
  const [criticModel, setCriticModel] = useState("gpt-5.2");
  const [criticSuccessN, setCriticSuccessN] = useState(2);
  const [criticConfTh, setCriticConfTh] = useState(0.4);
  const [criticRewardTh, setCriticRewardTh] = useState(0.1);
  const [rlIterations, setRlIterations] = useState([]);

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
  const [orchestratorBaseUrl, setOrchestratorBaseUrl] = useState(readLocalStorage("daemon.orchestratorBaseUrl") || ORCH_BASE_URL);
  // Default to 8766 because 8765 is commonly used by the legacy JSON mecanum bridge.
  const [nodeEndpoints, setNodeEndpoints] = useState("base=vporto26.local:8766");
  const [orchestratorProc, setOrchestratorProc] = useState({ running: false, pid: null, httpBaseUrl: null, args: null });
  const [nodeProbeResults, setNodeProbeResults] = useState([]);
  const [hardwareBusy, setHardwareBusy] = useState(false);
  const [capabilities, setCapabilities] = useState(INITIAL_STATE.capabilities);
  const [systemManifest, setSystemManifest] = useState(null);
  const [cameraMode, setCameraMode] = useState("auto"); // auto | local | remote
  const [cameraSnapshotUrl, setCameraSnapshotUrl] = useState(REMOTE_CAMERA_SNAPSHOT_URL);
  const [cameraMjpegUrl, setCameraMjpegUrl] = useState(REMOTE_CAMERA_MJPEG_URL);
  const [traceLog, setTraceLog] = useState([]);
  const [backendAuditLog, setBackendAuditLog] = useState("");
  const traceSeqRef = useRef(0);

  const persistTraceToFile = async (entry) => {
    if (!RUNTIME_IS_TAURI) {
      return;
    }
    try {
      await invoke("write_debug_log", { fileName: "ui_trace.jsonl", payload: entry });
      const event = String(entry?.event || "");
      if (event.startsWith("vision.")) {
        await invoke("write_debug_log", { fileName: "vision_trace.jsonl", payload: entry });
      } else if (event.startsWith("orchestrator.")) {
        await invoke("write_debug_log", { fileName: "orchestrator_trace.jsonl", payload: entry });
      } else if (event.startsWith("critic.")) {
        await invoke("write_debug_log", { fileName: "critic_trace.jsonl", payload: entry });
      }
    } catch {
      // Ignore logging failures.
    }
  };

  const appendTrace = (event, payload = {}) => {
    const entry = {
      id: traceSeqRef.current++,
      ts: new Date().toISOString(),
      event,
      payload
    };
    setTraceLog((prev) => [...prev, entry].slice(-200));
    void persistTraceToFile(entry);
    // Keep browser devtools useful while also rendering logs in-app.
    console.log("[DAEMON_TRACE]", entry);
  };

  const refreshBackendAuditLog = async () => {
    if (!RUNTIME_IS_TAURI) {
      return;
    }
    try {
      const text = await invoke("read_debug_log", { fileName: "backend_audit.jsonl", tailLines: 250 });
      setBackendAuditLog(String(text || ""));
    } catch {
      // Ignore: optional diagnostics.
    }
  };

  const promptReady = taskPrompt.trim().length > 0;
  const draftReady = draftPrompt.trim().length > 0;
  const criticPromptReady = promptReady || draftReady;

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

  const resetSessionStateForPrompt = () => {
    const seeded = { ...INITIAL_STATE, capabilities: { ...capabilities } };
    setFsmState(seeded);
    stateRef.current = seeded;
    setPerception(null);
    setLastPlan([]);
    setLastDebug(null);
    setChartSeries([]);
  };

  const applyPrompt = async () => {
    const next = draftPrompt.trim();
    if (!next) {
      setErrorText("Task prompt is required.");
      return;
    }
    setTaskPrompt(next);
    appliedPromptRef.current = next;
    resetSessionStateForPrompt();
    appendTrace("prompt.apply", { prompt: next });
    setErrorText("");

    // Submit should trigger action immediately without requiring Single Step,
    // unless a continuous loop (critic) is already commanding hardware.
    if (!criticEnabledRef.current) {
      await executeSingleVisionStep({ executePlan: !dryRun });
    } else {
      appendTrace("prompt.apply.deferred", { reason: "critic_running" });
      // Make Send feel responsive while Critic is running: schedule a near-immediate tick.
      try {
        if (criticTimerRef.current) {
          clearTimeout(criticTimerRef.current);
          criticTimerRef.current = null;
        }
        if (typeof criticLoopFnRef.current === "function") {
          criticTimerRef.current = setTimeout(criticLoopFnRef.current, 30);
        }
      } catch {
        // ignore
      }
    }
  };

  useEffect(() => {
    appliedPromptRef.current = taskPrompt.trim() || DEFAULT_PROMPT;
  }, [taskPrompt]);

  useEffect(() => {
    try {
      globalThis?.localStorage?.setItem("daemon.visionMode", String(visionMode || ""));
      globalThis?.localStorage?.setItem("daemon.orchestratorBaseUrl", String(orchestratorBaseUrl || ""));
      globalThis?.localStorage?.setItem("daemon.taskPrompt", String(taskPrompt || ""));
      globalThis?.localStorage?.setItem("daemon.draftPrompt", String(draftPrompt || ""));
      globalThis?.localStorage?.setItem("daemon.debugMode", debugMode ? "1" : "0");
    } catch {
      // ignore
    }
  }, [visionMode, orchestratorBaseUrl, taskPrompt, draftPrompt, debugMode]);

  useEffect(() => {
    refreshBackendAuditLog();
  }, []);

  useEffect(() => {
    drawOverlay(overlayCanvasRef.current, perception, lastDebug);
  }, [perception, lastDebug]);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      // If the orchestrator isn't expected to be running, don't spam an error.
      // The desktop app can still talk to an external orchestrator if the user starts it manually.
      const shouldReportOrchError = Boolean(orchestratorProc?.running) || orchestratorBaseUrl.trim() !== ORCH_BASE_URL.trim();
      try {
        const status = await orchestratorStatus(orchestratorBaseUrl);
        if (!cancelled) {
          setOrchestratorReachable(true);
          setLastOrchestratorError("");
          setSystemManifest(status?.system_manifest || null);

          // Auto-discover camera services from the orchestrator manifest if present.
          if (cameraMode === "auto" && !REMOTE_CAMERA_SNAPSHOT_URL && !REMOTE_CAMERA_MJPEG_URL) {
            const nodes = Array.isArray(status?.system_manifest?.nodes) ? status.system_manifest.nodes : [];
            const camNode = nodes.find((n) => n?.services?.camera);
            const svc = camNode?.services?.camera || null;
            const snap = String(svc?.snapshot_url || "").trim();
            const mjpeg = String(svc?.mjpeg_url || "").trim();
            if (snap && !cameraSnapshotUrl) setCameraSnapshotUrl(snap);
            if (mjpeg && !cameraMjpegUrl) setCameraMjpegUrl(mjpeg);
          }
        }
      } catch (error) {
        if (!cancelled) {
          setOrchestratorReachable(false);
          setLastOrchestratorError(shouldReportOrchError ? String(error) : "");
          setSystemManifest(null);
        }
      }

      if (RUNTIME_IS_TAURI && !cancelled) {
        try {
          const proc = await invoke("orchestrator_process_status");
          setOrchestratorProc(proc);
          // If the app is managing an orchestrator, keep the UI base URL pinned to the actual chosen port.
          if (proc?.running && proc?.httpBaseUrl && String(proc.httpBaseUrl) !== String(orchestratorBaseUrl)) {
            setOrchestratorBaseUrl(String(proc.httpBaseUrl));
          }
        } catch {
          // Ignore.
        }
      }
    };

    poll();
    const interval = setInterval(poll, STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [orchestratorBaseUrl, cameraMode, cameraSnapshotUrl, cameraMjpegUrl]);

  const parseNodeEndpoints = () => {
    return nodeEndpoints
      .split(/\r?\n|,/)
      .map((line) => line.trim())
      .filter(Boolean);
  };

  const probeNodesInternal = async (endpoints) => {
    const results = [];
    for (const entry of endpoints) {
      const match = entry.match(/^[^=]+=([^:]+):(\d+)$/);
      if (!match) {
        results.push({ entry, ok: false, error: "Expected format alias=host:port" });
        continue;
      }
      const host = match[1];
      const port = Number.parseInt(match[2], 10);
      const resp = await invoke("node_probe", { host, port });
      results.push({ entry, ...resp });
    }

    setNodeProbeResults(results);
    const firstOk = results.find((item) => item?.ok);
    if (firstOk) {
      const alias = String(firstOk.entry || "").split("=", 1)[0] || "base";
      const tokens = Array.isArray(firstOk.tokens) ? firstOk.tokens.map((t) => String(t).toUpperCase()) : [];
      setCapabilities((prev) => ({
        ...prev,
        base_target: alias,
        base_fwd_token: tokens.includes("FWD") ? "FWD" : prev.base_fwd_token,
        base_turn_token: tokens.includes("TURN") ? "TURN" : prev.base_turn_token,
        base_strafe_token: tokens.includes("STRAFE") ? "STRAFE" : prev.base_strafe_token
      }));
    }

    return results;
  };

  const probeNodes = async () => {
    if (!RUNTIME_IS_TAURI) {
      setErrorText("Node probe requires Tauri runtime.");
      return;
    }

    setHardwareBusy(true);
    const endpoints = parseNodeEndpoints();
    appendTrace("nodes.probe.start", { endpoints });
    try {
      const results = await probeNodesInternal(endpoints);
      setErrorText("");
      appendTrace("nodes.probe.result", { results });
    } catch (error) {
      appendTrace("nodes.probe.error", { error: String(error) });
      setErrorText(`Probe failed: ${String(error)}`);
    } finally {
      setHardwareBusy(false);
    }
  };

  const startOrchestrator = async () => {
    if (!RUNTIME_IS_TAURI) {
      setErrorText("Starting orchestrator requires Tauri runtime.");
      return;
    }

    setHardwareBusy(true);
    appendTrace("orchestrator.spawn.start", { nodes: parseNodeEndpoints() });
    try {
      const nodes = parseNodeEndpoints();
      const proc = await invoke("orchestrator_spawn", {
        nodes,
        httpPort: 5055,
        httpHost: "127.0.0.1",
        stepTimeoutS: 4.0
      });
      setOrchestratorProc(proc);
      if (proc?.httpBaseUrl) {
        setOrchestratorBaseUrl(proc.httpBaseUrl);
      }
      appendTrace("orchestrator.spawn.ok", { proc });
      await refreshBackendAuditLog();
      setErrorText("");
    } catch (error) {
      appendTrace("orchestrator.spawn.error", { error: String(error) });
      setErrorText(`Start orchestrator failed: ${String(error)}`);
    } finally {
      setHardwareBusy(false);
    }
  };

  const stopOrchestratorProcess = async () => {
    if (!RUNTIME_IS_TAURI) {
      setErrorText("Stopping orchestrator requires Tauri runtime.");
      return;
    }

    setHardwareBusy(true);
    appendTrace("orchestrator.process_stop.start", {});
    try {
      const proc = await invoke("orchestrator_stop_process");
      setOrchestratorProc(proc);
      appendTrace("orchestrator.process_stop.ok", { proc });
      await refreshBackendAuditLog();
      setErrorText("");
    } catch (error) {
      appendTrace("orchestrator.process_stop.error", { error: String(error) });
      setErrorText(`Stop orchestrator failed: ${String(error)}`);
    } finally {
      setHardwareBusy(false);
    }
  };

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

  const effectiveCameraMode = useMemo(() => {
    if (cameraMode === "local") return "local";
    if (cameraMode === "remote") return "remote";
    // auto: prefer remote only if we have a usable snapshot URL (MJPEG is for preview only).
    if (String(cameraSnapshotUrl || "").trim()) return "remote";
    return "local";
  }, [cameraMode, cameraSnapshotUrl, cameraMjpegUrl]);

  const ensureCamera = async ({ force } = {}) => {
    // In Pi-brain mode, the planner can run without the laptop camera; only force camera for preview/critic.
    if (visionMode === "pi" && !force) return;
    if (effectiveCameraMode === "remote") {
      return;
    }
    if (streamRef.current && videoRef.current?.srcObject) {
      return;
    }

    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
      const origin = typeof window !== "undefined" ? window.location?.origin : "unknown";
      const secure = typeof window !== "undefined" ? Boolean(window.isSecureContext) : false;
      throw new Error(
        [
          "Camera API unavailable (navigator.mediaDevices.getUserMedia missing).",
          `origin=${origin}`,
          `secureContext=${secure}`,
          "If you're running the Tauri desktop app on macOS, you likely need to rebuild after adding NSCameraUsageDescription (see src-tauri/infoplist/InfoPlist.strings).",
          "If you're running in a browser, use https or localhost and avoid file://."
        ].join(" ")
      );
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
    if (effectiveCameraMode === "local") {
      releaseCamera();
    }

    if (!sendStop) {
      return;
    }

    try {
      await orchestratorStop(orchestratorBaseUrl);
      setOrchestratorReachable(true);
      setLastOrchestratorError("");
      setLastActionText("STOP OK");
      setLastActionTimestamp(nowStamp());
      appendTrace("orchestrator.stop.ok", { orchestratorBaseUrl });
      await refreshBackendAuditLog();
    } catch (error) {
      const msg = String(error);
      setOrchestratorReachable(false);
      setLastOrchestratorError(msg);
      setLastActionText("STOP FAILED");
      setLastActionTimestamp(nowStamp());
      setErrorText(`STOP failed: ${msg}`);
      appendTrace("orchestrator.stop.error", { orchestratorBaseUrl, error: msg });
    }
  };

  useEffect(() => {
    return () => {
      stopLoop({ sendStop: false });
    };
  }, []);

  useEffect(() => {
    if (!RUNTIME_IS_TAURI) {
      return;
    }
    let cancelled = false;
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    const bootstrap = async () => {
      try {
        const nodes = parseNodeEndpoints();
        appendTrace("bootstrap.start", { nodes });
        const proc = await invoke("orchestrator_spawn", {
          nodes,
          httpPort: 5055,
          httpHost: "127.0.0.1",
          stepTimeoutS: 4.0
        });
        if (cancelled) return;
        setOrchestratorProc(proc);
        if (proc?.httpBaseUrl) {
          setOrchestratorBaseUrl(proc.httpBaseUrl);
        }
        appendTrace("bootstrap.orchestrator.ok", { proc });

        for (let attempt = 1; attempt <= 5; attempt += 1) {
          if (cancelled) return;
          const results = await probeNodesInternal(nodes).catch((error) => {
            appendTrace("bootstrap.probe.error", { attempt, error: String(error) });
            return [];
          });
          const ok = Array.isArray(results) && results.some((r) => r?.ok);
          appendTrace("bootstrap.probe.attempt", { attempt, ok, results });
          if (ok) {
            setErrorText("");
            break;
          }
          await delay(1500);
        }
      } catch (error) {
        appendTrace("bootstrap.error", { error: String(error) });
      } finally {
        await refreshBackendAuditLog();
      }
    };

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  const executeSingleVisionStep = async (
    { executePlan, frameJpegBase64Override = null, correlationIdOverride = null, _macroStopRetry = true } = {}
  ) => {
    if (inFlightRef.current) {
      pendingStepRef.current = { executePlan, frameJpegBase64Override, correlationIdOverride };
      appendTrace("vision.step.queued", { executePlan: Boolean(executePlan), reason: "in_flight" });
      return;
    }

    if (!appliedPromptRef.current.trim()) {
      setErrorText("Task prompt is required.");
      return;
    }

    inFlightRef.current = true;
    pendingStepRef.current = null;
    setSendingFrames(true);

    try {
      await ensureCamera();

      const instructionToSend = appliedPromptRef.current.trim();
      const correlationId = String(correlationIdOverride || makeCorrelationId());
      let manifestForVision = systemManifest;
      if (visionMode !== "pi") {
        // Avoid cloud vision failures caused by stale/empty manifests (common when you're talking to the wrong orchestrator port).
        if (!manifestForVision) {
          try {
            const status = await orchestratorStatus(orchestratorBaseUrl);
            manifestForVision = status?.system_manifest || null;
            setSystemManifest(manifestForVision);
          } catch {
            // keep null; we'll error below with a clearer message.
          }
        }
        const toks = manifestTokens(manifestForVision);
        const expected = String(capabilities?.base_fwd_token || "FWD").trim() || "FWD";
        if (!toks.has(expected)) {
          throw new Error(
            `Orchestrator system_manifest is missing required token '${expected}'. ` +
              `This usually means you are pointing at the wrong orchestrator (stale process / wrong port) or base is disconnected. ` +
              `Fix: check ${orchestratorBaseUrl}/status and ensure base is connected and lists '${expected}'.`
          );
        }
      }
      const camera_meta =
        visionMode === "pi"
          ? { source: "pi_internal" }
          : {
              source: effectiveCameraMode,
              ...(effectiveCameraMode === "remote"
                ? {
                    snapshot_url: String(cameraSnapshotUrl || "").trim() || null,
                    mjpeg_url: String(cameraMjpegUrl || "").trim() || null
                  }
                : {})
            };
      const visionPayload = {
        instruction: instructionToSend,
        correlation_id: correlationId,
        system_manifest: manifestForVision,
        camera_meta,
        state: stateRef.current
      };
      let capturedFrame = null;
      if (visionMode !== "pi") {
        const frame_jpeg_base64 =
          frameJpegBase64Override ||
          (await (() => {
            if (effectiveCameraMode !== "remote") {
              return captureFrameBase64(videoRef.current, captureCanvasRef.current);
            }
            const snapUrl = String(cameraSnapshotUrl || "").trim();
            if (!snapUrl) {
              throw new Error("robot camera selected but snapshot_url is empty");
            }
            return fetchSnapshotBase64(snapUrl);
          })());
        if (!frame_jpeg_base64) {
          throw new Error("camera frame unavailable");
        }
        capturedFrame = frame_jpeg_base64;
        visionPayload.frame_jpeg_base64 = frame_jpeg_base64;
      }
      appendTrace("vision.step.request", {
        correlationId,
        executePlan,
        dryRun,
        instruction: instructionToSend,
        camera_meta,
        stateStage: String(stateRef.current?.stage || "SEARCH")
      });
      setLastSentInstruction(instructionToSend);

      const visionBaseUrl = visionMode === "pi" ? orchestratorBaseUrl : VERCEL_BASE_URL;
      const visionPath = visionMode === "pi" ? "/pi_vision_step" : "/api/vision_step";
      let visionResponse = await postVisionJson(visionBaseUrl, visionPath, visionPayload, correlationId);
      // If the state machine thinks it already emitted the motion macro, it can return STOP forever.
      // Auto-reset and retry once to make "Send" behave like "do it again".
      if (
        _macroStopRetry &&
        executePlan &&
        Array.isArray(visionResponse?.plan) &&
        visionResponse.plan.length === 1 &&
        String(visionResponse.plan[0]?.type || "") === "STOP" &&
        String(visionResponse?.debug?.notes || "").includes("motion macro already emitted")
      ) {
        appendTrace("vision.step.autoreset", { reason: "macro_already_emitted_stop", correlationId });
        const seeded = { ...INITIAL_STATE, capabilities: { ...capabilities } };
        stateRef.current = seeded;
        setFsmState(seeded);
        setPerception(null);
        setLastPlan([]);
        setLastDebug(null);
        setChartSeries([]);
        const retryCorrelationId = `${correlationId}-r1`;
        const retryPayload = {
          ...visionPayload,
          correlation_id: retryCorrelationId,
          state: seeded
        };
        if (capturedFrame) retryPayload.frame_jpeg_base64 = capturedFrame;
        visionResponse = await postVisionJson(visionBaseUrl, visionPath, retryPayload, retryCorrelationId);
      }

      const nextState = visionResponse?.state || stateRef.current;
      const nextPlan = Array.isArray(visionResponse?.plan) ? visionResponse.plan : [];
      const planCorrelationId = String(visionResponse?.correlation_id || correlationId);
      appendTrace("vision.step.response", {
        correlationId: planCorrelationId,
        stage: String(nextState?.stage || ""),
        planLength: nextPlan.length,
        plan: nextPlan,
        debug: visionResponse?.debug || null
      });

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
        appendTrace("orchestrator.execute_plan.request", {
          correlationId: planCorrelationId,
          orchestratorBaseUrl,
          planLength: nextPlan.length,
          plan: nextPlan
        });
        const response = await orchestratorExecutePlan(orchestratorBaseUrl, nextPlan, planCorrelationId);
        if (!response?.ok) {
          throw new Error(response?.error || "execute_plan returned non-ok response");
        }
        setOrchestratorReachable(true);
        setLastOrchestratorError("");
        setLastActionText("EXECUTE_PLAN OK");
        appendTrace("orchestrator.execute_plan.ok", { correlationId: planCorrelationId, response });
        await refreshBackendAuditLog();
      } else {
        setLastActionText("DRY RUN: plan generated only");
        appendTrace("orchestrator.execute_plan.skipped", { dryRun: true, planLength: nextPlan.length });
      }

      setLastActionTimestamp(nowStamp());

      if (String(nextState?.stage || "").toUpperCase() === "DONE" && liveEnabled) {
        await stopLoop({ sendStop: false });
      }
      return { ok: true, correlationId: planCorrelationId, plan: nextPlan };
    } catch (error) {
      const msg = String(error);
      setErrorText(msg);
      setOrchestratorReachable(false);
      setLastOrchestratorError(msg);
      setLastActionText("STEP FAILED");
      setLastActionTimestamp(nowStamp());
      appendTrace("vision.step.error", {
        error: msg,
        visionMode,
        visionBaseUrl: visionMode === "pi" ? PI_BRAIN_BASE_URL : VERCEL_BASE_URL
      });

      if (liveEnabled) {
        await stopLoop({ sendStop: true });
      }
      return { ok: false, error: msg };
    } finally {
      inFlightRef.current = false;
      setSendingFrames(false);
      const pending = pendingStepRef.current;
      if (pending) {
        // Keep the latest queued step; schedule it in a safe place depending on mode.
        if (!liveEnabledRef.current && !criticEnabledRef.current) {
          pendingStepRef.current = null;
          setTimeout(() => {
            void executeSingleVisionStep({ ...pending, _macroStopRetry: true });
          }, 20);
        } else if (criticEnabledRef.current) {
          // Let the critic loop drive execution; just nudge it.
          try {
            if (typeof criticLoopFnRef.current === "function") {
              if (criticTimerRef.current) clearTimeout(criticTimerRef.current);
              criticTimerRef.current = setTimeout(criticLoopFnRef.current, 50);
            }
          } catch {
            // ignore
          }
        }
      }
    }
  };

  const startLiveCamera = async () => {
    try {
      await ensureCamera();
      const seeded = { ...INITIAL_STATE, capabilities };
      setFsmState(seeded);
      stateRef.current = seeded;
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
      setErrorText(`${visionMode === "pi" ? "Loop start failed" : "Camera start failed"}: ${String(error)}`);
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

  const stopCriticLoop = async () => {
    criticEnabledRef.current = false;
    criticQualStreakRef.current = 0;
    setCriticEnabled(false);
    if (criticTimerRef.current) {
      clearTimeout(criticTimerRef.current);
      criticTimerRef.current = null;
    }
    criticLoopFnRef.current = null;
    if (RUNTIME_IS_TAURI) {
      try {
        await invoke("critic_stop");
      } catch {
        // ignore
      }
    }
  };

  const startCriticLoop = async () => {
    if (!RUNTIME_IS_TAURI) {
      setCriticError("Critic monitor requires Tauri runtime (backend holds OPENAI_API_KEY).");
      return;
    }
    const task = (taskPrompt || "").trim() || (draftPrompt || "").trim();
    if (!task) {
      setCriticError("Task prompt is required.");
      return;
    }

    setCriticError("");
    setCriticResult(null);
    setCriticDoneText("");
    criticQualStreakRef.current = 0;
    setRlIterations([]);
    setCriticEnabled(true);
    criticEnabledRef.current = true;

    // Stop the existing live loop so we don't double-execute robot actions.
    if (liveEnabledRef.current) {
      await stopLoop({ sendStop: false });
    }

    // Critical: if the last run left the policy in MOTION_ONLY with a macro already emitted,
    // the critic loop would only ever execute STOP. Reset so the first tick emits a fresh plan.
    resetSessionStateForPrompt();

    try {
      await ensureCamera({ force: true });
    } catch (error) {
      await stopCriticLoop();
      setCriticError(String(error));
      return;
    }

    try {
      await invoke("critic_spawn", {
        // Provide both camelCase + snake_case keys to avoid relying on implicit case conversion.
        orchestratorBaseUrl,
        orchestrator_base_url: orchestratorBaseUrl,
        task,
        model: criticModel,
        successConsecutiveFrames: Number(criticSuccessN),
        success_consecutive_frames: Number(criticSuccessN),
        successConfidenceThreshold: Number(criticConfTh),
        success_confidence_threshold: Number(criticConfTh),
        successRewardThreshold: Number(criticRewardTh),
        success_reward_threshold: Number(criticRewardTh)
      });
    } catch (error) {
      await stopCriticLoop();
      setCriticError(String(error));
      return;
    }

    const loop = async () => {
      if (!criticEnabledRef.current) return;
      if (criticInFlightRef.current) {
        criticTimerRef.current = setTimeout(loop, 200);
        return;
      }
      criticInFlightRef.current = true;

      try {
        const frame0 = await (() => {
          if (effectiveCameraMode !== "remote") {
            return captureFrameBase64(videoRef.current, captureCanvasRef.current);
          }
          const snapUrl = String(cameraSnapshotUrl || "").trim();
          if (!snapUrl) {
            throw new Error("robot camera selected but snapshot_url is empty");
          }
          return fetchSnapshotBase64(snapUrl);
        })();
        if (!frame0) {
          throw new Error("camera frame unavailable");
        }

        const correlationId = makeCorrelationId();

        // Execute robot commands according to the task prompt (policy -> plan -> orchestrator).
        const exec = await executeSingleVisionStep({
          executePlan: true,
          frameJpegBase64Override: frame0,
          correlationIdOverride: correlationId
        });

        const planForTiming = Array.isArray(exec?.plan) && exec.plan.length ? exec.plan : Array.isArray(lastPlan) ? lastPlan : [];
        const totalDurMs = planForTiming
          .filter((s) => s && s.type === "RUN" && Number(s.duration_ms || 0) > 0)
          .reduce((acc, s) => acc + Number(s.duration_ms || 0), 0);

        const capture = async () => {
          if (effectiveCameraMode !== "remote") {
            return captureFrameBase64(videoRef.current, captureCanvasRef.current);
          }
          const snapUrl = String(cameraSnapshotUrl || "").trim();
          if (!snapUrl) {
            throw new Error("robot camera selected but snapshot_url is empty");
          }
          return fetchSnapshotBase64(snapUrl);
        };

        // Capture post-action frames across the full plan window (helps detect left->right sequences).
        const postFrames = [];
        if (totalDurMs > 0) {
          const sampleTimes = [0.25, 0.6, 1.0].map((p) => Math.max(250, Math.min(3200, Math.round(totalDurMs * p))));
          let elapsed = 0;
          for (const t of sampleTimes) {
            const wait = Math.max(250, t - elapsed);
            await sleep(wait);
            elapsed += wait;
            postFrames.push(await capture());
          }
        } else {
          await sleep(700);
          postFrames.push(await capture());
          await sleep(700);
          postFrames.push(await capture());
        }

        const taskOverride = (taskPrompt || "").trim() || (draftPrompt || "").trim();
        const framesJpegBase64 = [frame0, ...postFrames].filter(Boolean);
        const result = await invoke("critic_step", {
          framesJpegBase64,
          frames_jpeg_base64: framesJpegBase64,
          lastActionText,
          last_action_text: lastActionText,
          executedPlan: exec?.plan || lastPlan,
          executed_plan: exec?.plan || lastPlan,
          taskOverride,
          task_override: taskOverride,
          correlationId,
          correlation_id: correlationId
        });
        setCriticResult(result);
        setLastDebug((prev) => ({ ...(prev || {}), critic: result }));

        appendTrace("critic.step.response", {
          correlationId,
          reward: Number(result?.reward || 0),
          conf: Number(result?.successConfidence || 0),
          success: Boolean(result?.success),
          streak: Number(result?.successStreak || 0),
          stable: Boolean(result?.successStable),
          motionScore: Number(result?.motionScore || 0),
          motionGate: Boolean(result?.motionGate)
        });

        // Record iteration outcome for the streamlined UI.
        setRlIterations((prev) => {
          const nextIdx = prev.length + 1;
          const failureModes = Array.isArray(result?.failureModes) ? result.failureModes : [];
          const qualifies =
            Number(result?.successConfidence || 0) >= Number(criticConfTh) &&
            Number(result?.reward || 0) >= Number(criticRewardTh) &&
            !Boolean(result?.motionGate) &&
            !Boolean(result?.criticalFailure) &&
            !failureModes.includes("uncertain") &&
            !failureModes.includes("not_visible") &&
            !failureModes.includes("target_not_visible");
          const entry = {
            i: nextIdx,
            ts: new Date().toISOString(),
            qualifies,
            reward: Number(result?.reward || 0),
            conf: Number(result?.successConfidence || 0),
            success: Boolean(result?.success),
            stable: Boolean(result?.successStable),
            motionScore: Number(result?.motionScore || 0),
            motionGate: Boolean(result?.motionGate),
            failureModes
          };
          return [...prev, entry].slice(-100);
        });

        const failureModes = Array.isArray(result?.failureModes) ? result.failureModes : [];
        const failClosed = failureModes.includes("uncertain") || failureModes.includes("not_visible") || failureModes.includes("target_not_visible");
        const qualifies =
          Number(result?.successConfidence || 0) >= Number(criticConfTh) &&
          Number(result?.reward || 0) >= Number(criticRewardTh) &&
          !Boolean(result?.motionGate) &&
          !Boolean(result?.criticalFailure) &&
          !failClosed;

        criticQualStreakRef.current = qualifies ? criticQualStreakRef.current + 1 : 0;
        const streak = Math.max(Number(result?.successStreak || 0), criticQualStreakRef.current);
        const stable = Boolean(result?.successStable) || criticQualStreakRef.current >= Number(criticSuccessN);

        if (stable) {
          // Make stopping atomic even if React batching delays state updates.
          criticEnabledRef.current = false;
          if (criticTimerRef.current) {
            clearTimeout(criticTimerRef.current);
            criticTimerRef.current = null;
          }
          setCriticEnabled(false);
          setCriticDoneText(`Trained: success stable (streak=${streak}/${Number(criticSuccessN)}).`);
          await stopCriticLoop();
          appendTrace("critic.done", { reason: "success_stable", streak, n: Number(criticSuccessN) });
          return;
        }
      } catch (error) {
        setCriticError(String(error));
        await stopCriticLoop();
        return;
      } finally {
        criticInFlightRef.current = false;
      }

      // Each tick hits vision + orchestrator + OpenAI; keep it moderate.
      if (criticEnabledRef.current) {
        criticTimerRef.current = setTimeout(loop, 450);
      }
    };

    criticLoopFnRef.current = loop;
    criticTimerRef.current = setTimeout(loop, 80);
  };

  return (
    <div className="studio">
      <div className="hero" style={{ alignItems: "flex-end" }}>
        <div>
          <p className="eyebrow">DAEMON</p>
          <h1>Reinforcement Learning (Physical Robot)</h1>
          <p className="sub">Set a task, then press Start Reinforcement Learning. The system will iterate until the success condition is stable.</p>
        </div>
        <div className={orchestratorReachable ? "health ok" : "health bad"}>
          <span className="dot" />
          <span>{orchestratorReachable ? "Robot Connected" : "Robot Disconnected"}</span>
        </div>
      </div>

      {!orchestratorReachable ? (
        <section className="error" style={{ display: "flex", gap: 12, alignItems: "center", justifyContent: "space-between" }}>
          <div>
            Robot connection lost. Reseat/tighten Ethernet (or USB), wait for link lights, then retry.
          </div>
          <button className="secondary" onClick={probeNodes} disabled={!RUNTIME_IS_TAURI || hardwareBusy}>
            Retry
          </button>
        </section>
      ) : null}

      <section className="prompt-card">
        <label htmlFor="taskPrompt">Task</label>
        <div className="prompt-row">
          <input
            id="taskPrompt"
            value={draftPrompt}
            onChange={(event) => setDraftPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void applyPrompt();
              }
            }}
            placeholder={DEFAULT_PROMPT}
          />
          <button className="secondary" onClick={() => void applyPrompt()} disabled={!draftReady}>
            Set Task
          </button>
          <button className="ghost" onClick={() => { setDraftPrompt(DEFAULT_PROMPT); setTaskPrompt(DEFAULT_PROMPT); }}>
            Reset
          </button>
        </div>
      </section>

      <section className="controls" style={{ justifyContent: "space-between" }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button
            className={criticEnabled ? "primary active" : "primary"}
            onClick={() => (criticEnabled ? void stopCriticLoop() : void startCriticLoop())}
            disabled={!criticPromptReady || !RUNTIME_IS_TAURI || !orchestratorReachable}
            title="Runs the autonomy loop: execute -> watch -> judge -> repeat until stable success."
          >
            {criticEnabled ? "Stop Reinforcement Learning" : "Start Reinforcement Learning"}
          </button>
          <button className="panic" onClick={handleStop}>STOP</button>
        </div>
        <label className="toggle">
          <input type="checkbox" checked={debugMode} onChange={(e) => setDebugMode(Boolean(e.target.checked))} />
          <span>Debug Mode</span>
        </label>
      </section>

      <main className="grid">
        <section className="panel video-panel">
          <h2>Camera</h2>
          <div className="video-shell">
            {effectiveCameraMode === "remote" ? (
              <img ref={remoteImgRef} className="video" alt="robot camera" src={(cameraMjpegUrl || cameraSnapshotUrl || "").trim()} />
            ) : (
              <video ref={videoRef} autoPlay muted playsInline className="video" />
            )}
            <canvas ref={overlayCanvasRef} className="overlay" />
          </div>
          <canvas ref={captureCanvasRef} className="hidden-canvas" />
        </section>

        <section className="panel">
          <h2>Reinforcement Learning</h2>
          {criticError ? <div className="error">RL: {criticError}</div> : null}
          {criticDoneText ? (
            <div className="note" style={{ border: "1px solid rgba(134,239,172,0.45)", background: "rgba(134,239,172,0.08)", padding: 12, borderRadius: 12 }}>
              <strong>{criticDoneText}</strong>
            </div>
          ) : null}
          <div className="metrics" style={{ marginTop: 10 }}>
            <span>running: {String(Boolean(criticEnabled))}</span>
            <span>iterations: {rlIterations.length}</span>
            <span>reward&gt;= {criticRewardTh}</span>
            <span>conf&gt;= {criticConfTh}</span>
            <span>N= {criticSuccessN}</span>
          </div>

          <div style={{ marginTop: 12 }}>
            <div className="note">Iterations (latest first):</div>
            <pre style={{ maxHeight: 320, overflow: "auto" }}>
              {rlIterations.length
                ? [...rlIterations]
                    .slice()
                    .reverse()
                    .map((it) => {
                      const tag = it.qualifies ? "SUCCESS" : "FAIL";
                      return `iter ${it.i}: ${tag}  reward=${it.reward.toFixed(2)} conf=${it.conf.toFixed(2)} motion=${it.motionScore.toFixed(3)}${it.motionGate ? " gated" : ""}`;
                    })
                    .join("\n")
                : "No iterations yet. Click Start Reinforcement Learning."}
            </pre>
          </div>

          {debugMode ? (
            <>
              <div className="note" style={{ marginTop: 12 }}>
                Debug: critic raw JSON
              </div>
              <pre style={{ maxHeight: 260, overflow: "auto" }}>
                {criticResult ? JSON.stringify(criticResult, null, 2) : "No critic results yet."}
              </pre>
            </>
          ) : null}
        </section>
      </main>

      {debugMode ? (
        <>
          {lastOrchestratorError ? <section className="error">Last orchestrator error: {lastOrchestratorError}</section> : null}
          {errorText ? <section className="error">{errorText}</section> : null}

          <section className="panel">
            <h2>Debug: System</h2>
            <div className="note" style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <span>orchestrator:</span>
              <code>{orchestratorBaseUrl}</code>
              <span>vision:</span>
              <code>{visionMode}</code>
              <span>camera:</span>
              <code>{effectiveCameraMode}</code>
            </div>
            <pre>{JSON.stringify({ state: fsmState, perception, lastPlan, lastDebug }, null, 2)}</pre>
          </section>

          <section className="panel">
            <h2>Debug: Trace</h2>
            <div className="controls" style={{ justifyContent: "flex-start" }}>
              <button className="secondary" onClick={() => setTraceLog([])}>Clear UI Trace</button>
              <button className="secondary" onClick={refreshBackendAuditLog} disabled={!RUNTIME_IS_TAURI}>
                Refresh Backend Audit
              </button>
            </div>
            <pre style={{ maxHeight: 360, overflow: "auto" }}>{traceLog.length ? traceLog.map((x) => JSON.stringify(x)).join("\n") : "No trace events yet."}</pre>
          </section>

          <section className="panel">
            <h2>Debug: Backend Audit</h2>
            <pre style={{ maxHeight: 360, overflow: "auto" }}>{backendAuditLog || "No backend audit lines yet."}</pre>
          </section>
        </>
      ) : null}
    </div>
  );
}

export default App;
