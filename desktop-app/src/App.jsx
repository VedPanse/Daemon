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

const DEFAULT_PROMPT = "pick up the banana";

function nowStamp() {
  return new Date().toLocaleTimeString();
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

async function postVisionJson(url, body, correlationId) {
  const base = String(url || "").replace(/\/+$/, "");
  const endpoint = `${base}/api/vision_step`;

  // WKWebView networking (Tauri) can throw `TypeError: Load failed` even when the
  // endpoint is reachable. Proxy through Rust to make failures debuggable.
  if (RUNTIME_IS_TAURI) {
    try {
      return await invoke("vision_step", {
        visionBaseUrl: base,
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
  const [orchestratorBaseUrl, setOrchestratorBaseUrl] = useState(ORCH_BASE_URL);
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

    // Submit should trigger action immediately without requiring Single Step.
    await executeSingleVisionStep({ executePlan: !dryRun });
  };

  useEffect(() => {
    appliedPromptRef.current = taskPrompt.trim() || DEFAULT_PROMPT;
  }, [taskPrompt]);

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
        httpHost: "127.0.0.1"
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
    // auto: prefer remote if we have a snapshot URL or MJPEG URL.
    if (String(cameraSnapshotUrl || "").trim() || String(cameraMjpegUrl || "").trim()) return "remote";
    return "local";
  }, [cameraMode, cameraSnapshotUrl, cameraMjpegUrl]);

  const ensureCamera = async () => {
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
          httpHost: "127.0.0.1"
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

  const executeSingleVisionStep = async ({ executePlan }) => {
    if (inFlightRef.current) {
      return;
    }

    if (!appliedPromptRef.current.trim()) {
      setErrorText("Task prompt is required.");
      return;
    }

    inFlightRef.current = true;
    setSendingFrames(true);

    try {
      await ensureCamera();
      const frame_jpeg_base64 =
        effectiveCameraMode === "remote"
          ? await fetchSnapshotBase64(cameraSnapshotUrl)
          : await captureFrameBase64(videoRef.current, captureCanvasRef.current);
      if (!frame_jpeg_base64) {
        throw new Error("camera frame unavailable");
      }

      const instructionToSend = appliedPromptRef.current.trim();
      const correlationId = makeCorrelationId();
      const visionPayload = {
        frame_jpeg_base64,
        instruction: instructionToSend,
        correlation_id: correlationId,
        system_manifest: systemManifest,
        state: stateRef.current
      };
      appendTrace("vision.step.request", {
        correlationId,
        executePlan,
        dryRun,
        instruction: instructionToSend,
        stateStage: String(stateRef.current?.stage || "SEARCH")
      });
      setLastSentInstruction(instructionToSend);

      const visionResponse = await postVisionJson(VERCEL_BASE_URL, visionPayload, correlationId);
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
    } catch (error) {
      const msg = String(error);
      setErrorText(msg);
      setOrchestratorReachable(false);
      setLastOrchestratorError(msg);
      setLastActionText("STEP FAILED");
      setLastActionTimestamp(nowStamp());
      appendTrace("vision.step.error", { error: msg, visionBaseUrl: VERCEL_BASE_URL });

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
        <label>Hardware / Orchestrator</label>
        <div className="prompt-row">
          <textarea
            value={nodeEndpoints}
            onChange={(event) => setNodeEndpoints(event.target.value)}
            rows={3}
            style={{ flex: 1, minWidth: 320 }}
            placeholder={"base=vporto26.local:8765\narm=127.0.0.1:7778"}
          />
          <button className="secondary" onClick={probeNodes} disabled={hardwareBusy || !RUNTIME_IS_TAURI}>Probe</button>
          <button className="secondary" onClick={startOrchestrator} disabled={hardwareBusy || !RUNTIME_IS_TAURI}>
            Start Orchestrator
          </button>
          <button className="ghost" onClick={stopOrchestratorProcess} disabled={hardwareBusy || !RUNTIME_IS_TAURI}>Stop</button>
        </div>
        <div className="note" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <span>camera:</span>
          <select value={cameraMode} onChange={(event) => setCameraMode(event.target.value)}>
            <option value="auto">auto</option>
            <option value="local">local webcam</option>
            <option value="remote">robot camera</option>
          </select>
          <span>snapshot_url</span>
          <input
            value={cameraSnapshotUrl}
            onChange={(event) => setCameraSnapshotUrl(event.target.value)}
            placeholder="http://vporto26.local:8081/snapshot.jpg"
            style={{ width: 360 }}
          />
          <span>mjpeg_url</span>
          <input
            value={cameraMjpegUrl}
            onChange={(event) => setCameraMjpegUrl(event.target.value)}
            placeholder="http://vporto26.local:8081/stream.mjpg"
            style={{ width: 320 }}
          />
          <span>mode={effectiveCameraMode}</span>
        </div>
        <div className="note" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <span>caps:</span>
          <span>base_target</span>
          <input
            value={capabilities.base_target}
            onChange={(event) => setCapabilities((prev) => ({ ...prev, base_target: event.target.value }))}
            style={{ width: 90 }}
          />
          <span>base_fwd_token</span>
          <input
            value={capabilities.base_fwd_token}
            onChange={(event) => setCapabilities((prev) => ({ ...prev, base_fwd_token: event.target.value }))}
            style={{ width: 90 }}
          />
          <span>base_turn_token</span>
          <input
            value={capabilities.base_turn_token}
            onChange={(event) => setCapabilities((prev) => ({ ...prev, base_turn_token: event.target.value }))}
            style={{ width: 90 }}
          />
        </div>
        <div className="note" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <span>orchestrator:</span>
          <input
            value={orchestratorBaseUrl}
            onChange={(event) => setOrchestratorBaseUrl(event.target.value)}
            style={{ width: 320 }}
          />
          <span>{orchestratorProc?.running ? `pid=${orchestratorProc.pid}` : "not running (app can still talk to an external orchestrator)"}</span>
        </div>
        {nodeProbeResults.length ? <pre>{JSON.stringify(nodeProbeResults, null, 2)}</pre> : null}
      </section>

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
                void applyPrompt();
              }
            }}
            placeholder="pick up the banana"
          />
          <button className="secondary" onClick={() => void applyPrompt()} disabled={!draftReady}>Send</button>
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
        <div><strong>Orchestrator:</strong> {orchestratorBaseUrl}</div>
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

      <section className="panel">
        <h2>Submit Trace</h2>
        <div className="controls" style={{ justifyContent: "flex-start" }}>
          <button className="secondary" onClick={() => setTraceLog([])}>Clear UI Trace</button>
          <button className="secondary" onClick={refreshBackendAuditLog} disabled={!RUNTIME_IS_TAURI}>
            Refresh Backend Audit
          </button>
        </div>
        <pre>{traceLog.length ? traceLog.map((x) => JSON.stringify(x)).join("\n") : "No trace events yet."}</pre>
      </section>

      <section className="panel">
        <h2>Tauri Backend Audit Log</h2>
        <pre>{backendAuditLog || "No backend audit lines yet."}</pre>
      </section>

      {lastOrchestratorError ? <section className="error">Last orchestrator error: {lastOrchestratorError}</section> : null}
      {errorText ? <section className="error">{errorText}</section> : null}

      <main className="grid">
        <section className="panel video-panel">
          <h2>Live Camera</h2>
          <div className="video-shell">
            {effectiveCameraMode === "remote" ? (
              <img
                ref={remoteImgRef}
                className="video"
                alt="robot camera"
                src={(cameraMjpegUrl || cameraSnapshotUrl || "").trim()}
              />
            ) : (
              <video ref={videoRef} autoPlay muted playsInline className="video" />
            )}
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
