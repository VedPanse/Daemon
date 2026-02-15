/* eslint-disable @typescript-eslint/no-explicit-any */
import WebSocket from "ws";
import { buildCriticSystemPrompt, CRITIC_TOOL_SCHEMA, type CriticToolOutput } from "./criticPrompt";

export type VisionRLManagerConfig = {
  // OpenAI Realtime model name, e.g. "gpt-realtime" (or your provisioned realtime model).
  model: string;
  // OpenAI API key. Do NOT put this in a browser bundle. Use in a trusted backend/sidecar.
  apiKey: string;
  // Realtime WebSocket endpoint (defaults to OpenAI's).
  // Example: "wss://api.openai.com/v1/realtime?model=gpt-realtime"
  url?: string;

  // Critic behavior
  task: string;
  successDefinition?: string;
  safetyNotes?: string;

  // Temporal consistency
  successConsecutiveFrames?: number; // default 3
  successConfidenceThreshold?: number; // default 0.9
  successRewardThreshold?: number; // default 0.9

  // Latency / robustness
  requestTimeoutMs?: number; // default 2500
  maxInFlight?: number; // default 1 (drop frames if critic lags)
};

export type FrameInput = {
  jpegBase64: string; // raw base64 (no data: prefix)
  tsMs: number;
  // Optional observation context (helps critic judge progress)
  lastActionText?: string;
  // Optional: include per-step extra context for the critic (kept short)
  hint?: string;
  correlationId?: string;
};

export type CriticResult = CriticToolOutput & {
  // Derived fields
  tsMs: number;
  correlationId?: string;
  // When the manager's temporal filter considers the episode "done".
  success_streak: number;
  success_stable: boolean;
};

export type Transition<S = any, A = any> = {
  s: S;
  a: A;
  r: number;
  s2: S;
  meta: {
    tsMs: number;
    critic: CriticResult;
  };
};

export type RLBuffer<S = any, A = any> = {
  push(t: Transition<S, A>): void;
  size(): number;
  sample?(n: number): Transition<S, A>[];
};

export class RingBuffer<S = any, A = any> implements RLBuffer<S, A> {
  private buf: Array<Transition<S, A> | undefined>;
  private head = 0;
  private count = 0;
  constructor(private readonly capacity: number) {
    this.buf = new Array(capacity);
  }
  push(t: Transition<S, A>): void {
    this.buf[this.head] = t;
    this.head = (this.head + 1) % this.capacity;
    this.count = Math.min(this.capacity, this.count + 1);
  }
  size(): number {
    return this.count;
  }
  sample(n: number): Transition<S, A>[] {
    const out: Transition<S, A>[] = [];
    const k = Math.min(n, this.count);
    for (let i = 0; i < k; i++) {
      const idx = Math.floor(Math.random() * this.count);
      const pos = (this.head - 1 - idx + this.capacity) % this.capacity;
      const v = this.buf[pos];
      if (v) out.push(v);
    }
    return out;
  }
}

type PendingEval = {
  resolve: (r: CriticResult) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  input: FrameInput;
};

/**
 * VisionRLManager
 *
 * Runs a persistent OpenAI Realtime session as a vision-language "critic" (reward function).
 * Intended to run in a trusted backend/sidecar (Node) because the Realtime WS needs auth headers.
 *
 * Dataflow:
 * - You feed frames via `evaluateFrame(frame)` or `ingestFrameLatest(frame)` (drop-when-busy).
 * - The manager calls the Realtime tool `critic_reward` and parses structured reward output.
 * - Temporal filter requires N consecutive high-confidence successes before declaring stable success.
 * - Optional: create (s,a,r,s2) transitions via `recordAction(...)` and internal pairing.
 */
export class VisionRLManager<S = any, A = any> {
  private ws: WebSocket | null = null;
  private sessionReady = false;
  private closed = false;

  private pending: PendingEval[] = [];
  private successStreak = 0;
  private readonly successN: number;
  private readonly successConf: number;
  private readonly successReward: number;
  private readonly timeoutMs: number;
  private readonly maxInFlight: number;

  public readonly buffer: RLBuffer<S, A>;

  private pendingAction:
    | {
        s: S;
        a: A;
        tsMs: number;
      }
    | null = null;

  // Callbacks
  public onCriticResult: ((r: CriticResult) => void) | null = null;
  public onInterrupt: ((reason: string, r: CriticResult) => void) | null = null;
  public onError: ((err: Error) => void) | null = null;

  constructor(public readonly cfg: VisionRLManagerConfig, opts?: { buffer?: RLBuffer<S, A> }) {
    this.buffer = opts?.buffer ?? new RingBuffer<S, A>(50_000);
    this.successN = Math.max(1, cfg.successConsecutiveFrames ?? 3);
    this.successConf = cfg.successConfidenceThreshold ?? 0.9;
    this.successReward = cfg.successRewardThreshold ?? 0.9;
    this.timeoutMs = cfg.requestTimeoutMs ?? 2500;
    this.maxInFlight = Math.max(1, cfg.maxInFlight ?? 1);
  }

  private url(): string {
    const base = this.cfg.url?.trim() || "wss://api.openai.com/v1/realtime";
    // If caller provided a full URL with model already, keep it.
    if (base.includes("model=")) return base;
    const join = base.includes("?") ? "&" : "?";
    return `${base}${join}model=${encodeURIComponent(this.cfg.model)}`;
  }

  async connect(): Promise<void> {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.closed = false;
    this.sessionReady = false;

    const ws = new WebSocket(this.url(), {
      headers: {
        Authorization: `Bearer ${this.cfg.apiKey}`,
        "OpenAI-Beta": "realtime=v1"
      }
    });
    this.ws = ws;

    ws.on("open", () => {
      // session.update sets global instructions + tool schema. We'll send once.
      const instructions = buildCriticSystemPrompt({
        task: this.cfg.task,
        successDefinition: this.cfg.successDefinition,
        safetyNotes: this.cfg.safetyNotes
      });

      const msg = {
        type: "session.update",
        session: {
          modalities: ["text"],
          instructions,
          temperature: 0,
          tools: [CRITIC_TOOL_SCHEMA],
          tool_choice: { type: "function", name: "critic_reward" }
        }
      };
      ws.send(JSON.stringify(msg));
    });

    ws.on("message", (raw) => {
      try {
        const txt = typeof raw === "string" ? raw : raw.toString("utf8");
        const evt = JSON.parse(txt);
        this.handleEvent(evt);
      } catch (e: any) {
        this.onError?.(e instanceof Error ? e : new Error(String(e)));
      }
    });

    ws.on("error", (err) => {
      this.onError?.(err instanceof Error ? err : new Error(String(err)));
    });

    ws.on("close", () => {
      this.sessionReady = false;
      this.ws = null;
      if (!this.closed) {
        this.onError?.(new Error("Realtime WS closed unexpectedly"));
      }
      // Reject any pending evals.
      for (const p of this.pending.splice(0)) {
        clearTimeout(p.timer);
        p.reject(new Error("Realtime WS closed"));
      }
    });

    // Wait until session is confirmed/ready.
    await this.waitForSessionReady();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.sessionReady = false;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
    }
    this.ws = null;
    for (const p of this.pending.splice(0)) {
      clearTimeout(p.timer);
      p.reject(new Error("closed"));
    }
  }

  private waitForSessionReady(): Promise<void> {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (this.sessionReady) return resolve();
        if (!this.ws) return reject(new Error("WS not connected"));
        if (Date.now() - start > 2000) return reject(new Error("Timed out waiting for session ready"));
        setTimeout(tick, 30);
      };
      tick();
    });
  }

  /**
   * Evaluate a single frame (may queue if multiple in flight).
   * For low-latency RL, prefer `ingestFrameLatest` which drops frames when busy.
   */
  async evaluateFrame(input: FrameInput): Promise<CriticResult> {
    await this.connect();
    if (!this.ws) throw new Error("WS not connected");

    if (this.pending.length >= this.maxInFlight) {
      throw new Error(`critic_backpressure: in_flight=${this.pending.length} max=${this.maxInFlight}`);
    }

    const msg = this.buildResponseCreate(input);
    this.ws.send(JSON.stringify(msg));

    return await new Promise<CriticResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Remove from pending list on timeout.
        const idx = this.pending.findIndex((p) => p.resolve === resolve);
        if (idx >= 0) this.pending.splice(idx, 1);
        reject(new Error("critic_timeout"));
      }, this.timeoutMs);
      this.pending.push({ resolve, reject, timer, input });
    });
  }

  /**
   * Drop-when-busy mode: only keep the latest frame if the critic is lagging.
   * Returns void; results are delivered via `onCriticResult`.
   */
  ingestFrameLatest(input: FrameInput): void {
    if (this.pending.length >= this.maxInFlight) {
      // Drop frame. For RL stability, we prefer skipping over backlog.
      return;
    }
    void this.evaluateFrame(input)
      .then((r) => this.onCriticResult?.(r))
      .catch((e) => this.onError?.(e instanceof Error ? e : new Error(String(e))));
  }

  /**
   * Record an executed action so we can form (s,a,r,s2) once the next critic result arrives.
   * Call this when you send a robot command.
   */
  recordAction(s: S, a: A, tsMs: number): void {
    this.pendingAction = { s, a, tsMs };
  }

  /**
   * Call this with your next-state snapshot after the action, alongside the critic result.
   * If a pending action exists, pushes a transition into the buffer.
   */
  maybePushTransition(s2: S, critic: CriticResult): void {
    if (!this.pendingAction) return;
    const { s, a, tsMs } = this.pendingAction;
    this.pendingAction = null;
    this.buffer.push({
      s,
      a,
      r: critic.reward,
      s2,
      meta: { tsMs: tsMs, critic }
    });
  }

  private buildResponseCreate(input: FrameInput): any {
    const goal = this.cfg.task.trim();
    const sys = buildCriticSystemPrompt({
      task: goal,
      successDefinition: this.cfg.successDefinition,
      safetyNotes: this.cfg.safetyNotes
    });

    const userTextParts: string[] = [];
    userTextParts.push(`Goal: ${goal}`);
    if (input.lastActionText) userTextParts.push(`Last action: ${input.lastActionText}`);
    if (input.hint) userTextParts.push(`Hint: ${input.hint}`);
    userTextParts.push("Evaluate THIS frame only.");
    userTextParts.push("If the robot/target is not clearly visible, be conservative and do not claim success.");
    const userText = userTextParts.join("\n");

    const dataUrl = `data:image/jpeg;base64,${input.jpegBase64}`;
    const responseCreate = {
      type: "response.create",
      response: {
        // Avoid growing a giant conversation at 5 FPS.
        conversation: "none",
        modalities: ["text"],
        instructions: sys,
        temperature: 0,
        tools: [CRITIC_TOOL_SCHEMA],
        tool_choice: { type: "function", name: "critic_reward" },
        metadata: {
          correlation_id: input.correlationId || null,
          ts_ms: input.tsMs
        },
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: userText },
              { type: "input_image", image_url: dataUrl }
            ]
          }
        ]
      }
    };
    return responseCreate;
  }

  private handleEvent(evt: any): void {
    const typ = String(evt?.type || "");

    // Session ready events (names can vary across revisions; accept a few).
    if (typ === "session.created" || typ === "session.updated") {
      this.sessionReady = true;
      return;
    }

    if (typ === "error") {
      const msg = String(evt?.error?.message || "realtime_error");
      // Reject the oldest pending request (latest-only mode relies on in-order completion).
      const p = this.pending.shift();
      if (p) {
        clearTimeout(p.timer);
        p.reject(new Error(msg));
      }
      this.onError?.(new Error(msg));
      return;
    }

    // Tool call arguments finish event: contains the JSON string for function args.
    // We resolve the oldest pending request (we only allow maxInFlight small).
    if (typ === "response.function_call_arguments.done") {
      const argsStr = String(evt?.arguments || "");
      let parsed: any = null;
      try {
        parsed = JSON.parse(argsStr);
      } catch {
        // Sometimes models return non-JSON; fail closed.
        parsed = null;
      }
      const p = this.pending.shift();
      if (!p) return;
      clearTimeout(p.timer);

      const out = this.normalizeCritic(parsed, p.input);
      p.resolve(out);

      // Safety interrupt path.
      if (out.critical_failure) {
        this.onInterrupt?.(out.critical_failure_reason || "critical_failure", out);
      }

      return;
    }
  }

  private normalizeCritic(raw: any, input: FrameInput): CriticResult {
    const safeStr = (v: any, d = ""): string => (typeof v === "string" && v.trim() ? v : d);
    const safeNum = (v: any, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
    const safeBool = (v: any, d = false): boolean => (typeof v === "boolean" ? v : d);
    const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));

    const reward = clamp(safeNum(raw?.reward, 0), -1, 1);
    const success = safeBool(raw?.success, false);
    const conf = clamp(safeNum(raw?.success_confidence, 0), 0, 1);
    const critical = safeBool(raw?.critical_failure, false);

    const successThisFrame = Boolean(success && conf >= this.successConf && reward >= this.successReward);
    this.successStreak = successThisFrame ? this.successStreak + 1 : 0;
    const stable = this.successStreak >= this.successN;

    // Enforce fail-closed: never allow stable success if confidence is low.
    const out: CriticResult = {
      describe: safeStr(raw?.describe, "unknown"),
      evaluate: safeStr(raw?.evaluate, ""),
      reward,
      success: success && conf >= 0.5, // still require some minimum confidence for raw success flag
      success_confidence: conf,
      critical_failure: critical,
      critical_failure_reason: safeStr(raw?.critical_failure_reason, ""),
      failure_modes: Array.isArray(raw?.failure_modes) ? raw.failure_modes.map(String) : ["uncertain"],
      robot_bbox: raw?.robot_bbox ?? null,
      target_bbox: raw?.target_bbox ?? null,
      notes_short: safeStr(raw?.notes_short, ""),
      tsMs: input.tsMs,
      correlationId: input.correlationId,
      success_streak: this.successStreak,
      success_stable: stable
    };
    return out;
  }
}

/**
 * React-side frame capture helper (hook-ish utility):
 *
 * You can use this from the frontend to sample frames at ~5 FPS and send them
 * to your backend/sidecar that runs VisionRLManager.
 *
 * NOTE: This file is Node-oriented (imports `ws`). If you want this helper in the browser,
 * copy it into a browser-only module and remove Node deps.
 */
export function startRafFrameSampler(params: {
  videoEl: HTMLVideoElement;
  canvasEl: HTMLCanvasElement;
  fps: number;
  jpegQuality?: number; // 0..1
  onFrame: (jpegBase64: string, tsMs: number) => void;
}): { stop: () => void } {
  const { videoEl, canvasEl, fps, onFrame } = params;
  const q = params.jpegQuality ?? 0.75;
  const intervalMs = Math.max(1, Math.floor(1000 / Math.max(1, fps)));

  const ctx = canvasEl.getContext("2d", { willReadFrequently: false });
  if (!ctx) throw new Error("canvas 2d ctx unavailable");

  let raf = 0;
  let stopped = false;
  let lastMs = 0;

  const tick = (t: number) => {
    if (stopped) return;
    const now = Date.now();
    if (now - lastMs >= intervalMs) {
      lastMs = now;
      const w = videoEl.videoWidth || 1280;
      const h = videoEl.videoHeight || 720;
      if (w > 0 && h > 0) {
        if (canvasEl.width !== w) canvasEl.width = w;
        if (canvasEl.height !== h) canvasEl.height = h;
        ctx.drawImage(videoEl, 0, 0, w, h);
        const dataUrl = canvasEl.toDataURL("image/jpeg", q);
        const b64 = dataUrl.split(",")[1] || "";
        if (b64) onFrame(b64, now);
      }
    }
    raf = requestAnimationFrame(tick);
  };

  raf = requestAnimationFrame(tick);
  return {
    stop: () => {
      stopped = true;
      try {
        cancelAnimationFrame(raf);
      } catch {
        // ignore
      }
    }
  };
}

