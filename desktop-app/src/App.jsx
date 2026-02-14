import { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

const DEFAULT_VERCEL_BASE_URL = "https://daemon-ten-chi.vercel.app";
const DEFAULT_ORCH_BASE_URL = "http://127.0.0.1:5055";
const FRAME_WIDTH = 320;
const FRAME_HEIGHT = 240;
const CAPTURE_INTERVAL_MS = 300;
const INSTRUCTION = "pick the blue cube";

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
  if (!video || !canvas) {
    return null;
  }
  if (video.readyState < 2) {
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

async function postJson(url, body) {
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

  if (!perception?.found || !perception?.bbox) {
    return;
  }

  const sx = w / FRAME_WIDTH;
  const sy = h / FRAME_HEIGHT;
  const { x, y, w: bw, h: bh } = perception.bbox;

  ctx.strokeStyle = "#1f7cff";
  ctx.lineWidth = 3;
  ctx.strokeRect(x * sx, y * sy, bw * sx, bh * sy);

  const label = `blue ${Number(perception.confidence || 0).toFixed(2)}`;
  ctx.font = "14px ui-monospace, SFMono-Regular, Menlo, monospace";
  const tw = ctx.measureText(label).width;
  ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
  ctx.fillRect(x * sx, Math.max(0, y * sy - 22), tw + 14, 20);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(label, x * sx + 7, Math.max(14, y * sy - 8));
}

function App() {
  const videoRef = useRef(null);
  const captureCanvasRef = useRef(null);
  const overlayCanvasRef = useRef(null);
  const streamRef = useRef(null);
  const timerRef = useRef(null);
  const inFlightRef = useRef(false);
  const stateRef = useRef(INITIAL_STATE);

  const [liveEnabled, setLiveEnabled] = useState(false);
  const [sendingFrames, setSendingFrames] = useState(false);
  const [bridgeConnected, setBridgeConnected] = useState(false);
  const [fsmState, setFsmState] = useState(INITIAL_STATE);
  const [perception, setPerception] = useState(null);
  const [lastPlan, setLastPlan] = useState([]);
  const [lastDebug, setLastDebug] = useState(null);
  const [errorText, setErrorText] = useState("");

  const statusText = useMemo(() => {
    if (!liveEnabled) {
      return bridgeConnected ? "idle / connected" : "idle / disconnected";
    }
    return sendingFrames ? "connected / sending frames" : "connected / waiting";
  }, [bridgeConnected, liveEnabled, sendingFrames]);

  useEffect(() => {
    drawOverlay(overlayCanvasRef.current, perception);
  }, [perception]);

  useEffect(() => {
    return () => {
      stopLoop({ sendStop: false });
    };
  }, []);

  const stopLoop = async ({ sendStop }) => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    inFlightRef.current = false;
    setSendingFrames(false);
    setLiveEnabled(false);

    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }

    if (sendStop) {
      try {
        await postJson(`${ORCH_BASE_URL}/stop`, {});
        setBridgeConnected(true);
      } catch (error) {
        setBridgeConnected(false);
        setErrorText(`STOP failed: ${String(error)}`);
      }
    }
  };

  const executeTick = async () => {
    if (inFlightRef.current || !liveEnabled) {
      return;
    }

    inFlightRef.current = true;
    setSendingFrames(true);

    try {
      const frame_jpeg_base64 = await captureFrameBase64(videoRef.current, captureCanvasRef.current);
      if (!frame_jpeg_base64) {
        return;
      }

      const visionPayload = {
        frame_jpeg_base64,
        instruction: INSTRUCTION,
        state: stateRef.current,
        system_manifest: null,
        telemetry_snapshot: null
      };

      const visionResponse = await postJson(`${VERCEL_BASE_URL}/api/vision_step`, visionPayload);
      const nextState = visionResponse?.state || fsmState;
      const nextPlan = Array.isArray(visionResponse?.plan) ? visionResponse.plan : [];

      stateRef.current = nextState;
      setFsmState(nextState);
      setPerception(visionResponse?.perception || null);
      setLastPlan(nextPlan);
      setLastDebug(visionResponse?.debug || null);
      setErrorText("");

      const executeResponse = await postJson(`${ORCH_BASE_URL}/execute_plan`, { plan: nextPlan });
      if (!executeResponse?.ok) {
        throw new Error(executeResponse?.error || "execute_plan returned non-ok response");
      }
      setBridgeConnected(true);

      if (String(nextState?.stage || "").toUpperCase() === "DONE") {
        await stopLoop({ sendStop: false });
      }
    } catch (error) {
      setErrorText(String(error));
      setBridgeConnected(false);
      await stopLoop({ sendStop: true });
    } finally {
      inFlightRef.current = false;
      setSendingFrames(false);
    }
  };

  const startLiveCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480 },
        audio: false
      });

      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) {
        throw new Error("video element is unavailable");
      }

      video.srcObject = stream;
      await video.play();

      if (overlayCanvasRef.current) {
        overlayCanvasRef.current.width = 640;
        overlayCanvasRef.current.height = 480;
      }

      setFsmState(INITIAL_STATE);
      stateRef.current = INITIAL_STATE;
      setPerception(null);
      setLastPlan([]);
      setLastDebug(null);
      setErrorText("");
      setLiveEnabled(true);

      timerRef.current = setInterval(() => {
        executeTick();
      }, CAPTURE_INTERVAL_MS);
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

  return (
    <div className="live-app">
      <header className="header">
        <h1>DAEMON Live Camera</h1>
        <div className="button-row">
          <button onClick={handleLiveToggle} className={liveEnabled ? "btn-live active" : "btn-live"}>
            {liveEnabled ? "Disable Live Camera" : "Enable Live Camera"}
          </button>
          <button onClick={handleStop} className="btn-stop">
            STOP
          </button>
        </div>
      </header>

      <section className="status-bar">
        <span><strong>Status:</strong> {statusText}</span>
        <span><strong>FSM:</strong> {String(fsmState?.stage || "SEARCH")}</span>
        <span><strong>Vision API:</strong> {VERCEL_BASE_URL}</span>
        <span><strong>Orchestrator:</strong> {ORCH_BASE_URL}</span>
      </section>

      {errorText ? <section className="error-box">{errorText}</section> : null}

      <main className="layout">
        <section className="panel video-panel">
          <h2>Live Preview</h2>
          <div className="video-shell">
            <video ref={videoRef} autoPlay muted playsInline className="video" />
            <canvas ref={overlayCanvasRef} className="overlay" />
          </div>
          <canvas ref={captureCanvasRef} className="hidden-canvas" />
          <div className="perception-meta">
            <div>found: {String(Boolean(perception?.found))}</div>
            <div>confidence: {Number(perception?.confidence || 0).toFixed(3)}</div>
            <div>offset_x: {Number(perception?.center_offset_x || 0).toFixed(1)}</div>
            <div>area: {Number(perception?.area || 0).toFixed(1)}</div>
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
