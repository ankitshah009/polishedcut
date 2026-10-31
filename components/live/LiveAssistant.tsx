"use client";

// "Talk to Argon": a Gemini Live voice session about the current run. Mic audio (16 kHz PCM) streams
// up, Argon's voice (24 kHz PCM) streams down, and a spoken change becomes a director's note through
// the `revise_cut` tool. The browser authenticates with a 5-minute ephemeral token from
// /api/live/token; the API key never leaves the server. See docs/LIVE.md.
import { FunctionResponseScheduling, GoogleGenAI, type LiveServerMessage, type Session } from "@google/genai";
import { Loader2, Mic, MicOff, Radio, Volume2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { LIVE_MODEL, REVISE_CUT, liveConnectConfig, statusUpdate, type LiveTokenResponse } from "@/lib/live";
import type { Run } from "@/lib/schema";
import { cn } from "@/lib/utils";

const IN_RATE = 16_000;
const OUT_RATE = 24_000;
/** Mic frames per message: 100 ms at 16 kHz. */
const CHUNK = 1600;

type Phase = "idle" | "connecting" | "live" | "error";
interface Line {
  role: "you" | "argon" | "tool";
  text: string;
  final: boolean;
}

export interface LiveAssistantProps {
  run: Run;
  className?: string;
}

/* ----------------------------------------------------------------------------------------------
 * Audio helpers
 * -------------------------------------------------------------------------------------------- */

// Posts Float32 mono frames from the mic graph to the main thread, CHUNK frames at a time.
const WORKLET_SOURCE = `
class PcmCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(${CHUNK}); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) { this.port.postMessage(this.buf); this.buf = new Float32Array(${CHUNK}); this.n = 0; }
    }
    return true;
  }
}
registerProcessor("pcm-capture", PcmCapture);
`;

/** Linear resample when the capture context would not run at 16 kHz (Firefox, some Safari builds). */
function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const k = Math.floor(pos);
    const frac = pos - k;
    const a = input[k] ?? 0;
    const b = input[k + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

function floatToPcm16Base64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function pcm16Base64ToFloat(b64: string): Float32Array {
  const bin = atob(b64);
  const out = new Float32Array(bin.length >> 1);
  for (let i = 0; i < out.length; i++) {
    const lo = bin.charCodeAt(i * 2);
    const hi = bin.charCodeAt(i * 2 + 1);
    const v = (hi << 8) | lo;
    out[i] = (v >= 0x8000 ? v - 0x10000 : v) / 0x8000;
  }
  return out;
}

/** Gapless playback of 24 kHz PCM chunks; `clear()` on an interruption drops everything queued. */
class Speaker {
  private ctx: AudioContext;
  private next = 0;
  private playing = new Set<AudioBufferSourceNode>();
  constructor(private onActive: (speaking: boolean) => void) {
    this.ctx = new AudioContext({ sampleRate: OUT_RATE });
  }
  enqueue(b64: string) {
    const samples = pcm16Base64ToFloat(b64);
    if (samples.length === 0) return;
    const buf = this.ctx.createBuffer(1, samples.length, OUT_RATE);
    buf.getChannelData(0).set(samples);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    const at = Math.max(this.ctx.currentTime, this.next);
    src.start(at);
    this.next = at + buf.duration;
    this.playing.add(src);
    this.onActive(true);
    src.onended = () => {
      this.playing.delete(src);
      if (this.playing.size === 0) this.onActive(false);
    };
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }
  clear() {
    for (const s of this.playing) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.playing.clear();
    this.next = 0;
    this.onActive(false);
  }
  async close() {
    this.clear();
    await this.ctx.close().catch(() => undefined);
  }
}

/** The mic graph: getUserMedia -> (AudioWorklet | ScriptProcessor) -> 16 kHz PCM16 base64 frames. */
class Microphone {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private nodes: AudioNode[] = [];
  async start(onFrame: (b64: string) => void) {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ sampleRate: IN_RATE });
    } catch {
      ctx = new AudioContext();
    }
    this.ctx = ctx;
    const rate = ctx.sampleRate;
    const source = ctx.createMediaStreamSource(this.stream);
    const emit = (frames: Float32Array) => onFrame(floatToPcm16Base64(resample(frames, rate, IN_RATE)));
    if (ctx.audioWorklet) {
      const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const worklet = new AudioWorkletNode(ctx, "pcm-capture", { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 });
      worklet.port.onmessage = (e: MessageEvent<Float32Array>) => emit(e.data);
      source.connect(worklet);
      this.nodes.push(source, worklet);
    } else {
      // Deprecated but still the only option where AudioWorklet is missing.
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      proc.onaudioprocess = (e) => emit(new Float32Array(e.inputBuffer.getChannelData(0)));
      source.connect(proc);
      proc.connect(ctx.destination); // a ScriptProcessor only runs while connected to the graph
      this.nodes.push(source, proc);
    }
    if (ctx.state === "suspended") await ctx.resume();
  }
  async stop() {
    for (const n of this.nodes) n.disconnect();
    this.nodes = [];
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    await this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }
}

/* ----------------------------------------------------------------------------------------------
 * Component
 * -------------------------------------------------------------------------------------------- */

function describeError(err: unknown): string {
  if (err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "PermissionDeniedError")) {
    return "Microphone access was denied. Allow the mic for this site and try again.";
  }
  if (err instanceof DOMException && err.name === "NotFoundError") return "No microphone was found on this device.";
  return err instanceof Error ? err.message : String(err);
}

export function LiveAssistant({ run, className }: LiveAssistantProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [narrate, setNarrate] = useState(true);
  const [lines, setLines] = useState<Line[]>([]);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);

  const session = useRef<Session | null>(null);
  const mic = useRef<Microphone | null>(null);
  const speaker = useRef<Speaker | null>(null);
  const closing = useRef(false);
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  }, [run]);
  const transcriptEnd = useRef<HTMLDivElement | null>(null);

  const append = useCallback((role: Line["role"], text: string, final = false) => {
    if (!text) return;
    setLines((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === role && !last.final) {
        return [...prev.slice(0, -1), { role, text: last.text + text, final }];
      }
      return [...prev, { role, text, final }].slice(-40);
    });
  }, []);

  const finalize = useCallback(() => {
    setLines((prev) => prev.map((l) => (l.final ? l : { ...l, final: true })));
  }, []);

  const teardown = useCallback(async () => {
    closing.current = true;
    const s = session.current;
    session.current = null;
    try {
      s?.close();
    } catch {
      /* socket already gone */
    }
    await mic.current?.stop();
    mic.current = null;
    await speaker.current?.close();
    speaker.current = null;
    setSpeaking(false);
    closing.current = false;
  }, []);

  const stop = useCallback(async () => {
    await teardown();
    setPhase("idle");
    finalize();
  }, [teardown, finalize]);

  /** The `revise_cut` tool: POST the note, then tell the model what happened. */
  const handleToolCall = useCallback(
    async (msg: NonNullable<LiveServerMessage["toolCall"]>) => {
      const s = session.current;
      if (!s) return;
      for (const call of msg.functionCalls ?? []) {
        if (call.name !== REVISE_CUT) {
          s.sendToolResponse({ functionResponses: { id: call.id, name: call.name, response: { error: `unknown function ${call.name}` } } });
          continue;
        }
        const note = String((call.args as { note?: unknown } | undefined)?.note ?? "").trim();
        append("tool", `Director's note: ${note || "(empty)"}`, true);
        let response: Record<string, unknown>;
        try {
          const res = await fetch(`/api/runs/${encodeURIComponent(runRef.current.id)}/revise`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ note }),
          });
          if (res.status === 202) {
            response = { ok: true, result: "Note accepted. Argon is re-cutting now; a new version will appear when it is ready." };
          } else {
            const body = (await res.json().catch(() => null)) as { error?: string } | null;
            response = {
              ok: false,
              error: res.status === 409 ? "The run is still busy; the note can be applied when this version finishes." : body?.error ?? `HTTP ${res.status}`,
            };
          }
        } catch (err) {
          response = { ok: false, error: `could not reach the server: ${describeError(err)}` };
        }
        append("tool", response.ok ? "Note accepted — re-cutting." : `Not applied: ${String(response.error)}`, true);
        session.current?.sendToolResponse({
          functionResponses: { id: call.id, name: call.name, response, scheduling: FunctionResponseScheduling.INTERRUPT },
        });
      }
    },
    [append],
  );

  const onMessage = useCallback(
    (msg: LiveServerMessage) => {
      const content = msg.serverContent;
      if (content) {
        if (content.interrupted) speaker.current?.clear();
        for (const part of content.modelTurn?.parts ?? []) {
          if (part.inlineData?.data) speaker.current?.enqueue(part.inlineData.data);
        }
        if (content.inputTranscription?.text) append("you", content.inputTranscription.text);
        if (content.outputTranscription?.text) append("argon", content.outputTranscription.text);
        if (content.turnComplete) finalize();
      }
      if (msg.toolCall) void handleToolCall(msg.toolCall);
      if (msg.goAway) append("tool", `Session ends in ${msg.goAway.timeLeft ?? "a moment"}.`, true);
    },
    [append, finalize, handleToolCall],
  );

  const start = useCallback(async () => {
    setError(null);
    setLines([]);
    setOpen(true);
    setPhase("connecting");
    try {
      // 1. Mic first: the permission prompt is the slow, user-visible step.
      const m = new Microphone();
      mic.current = m;
      let frames: string[] = [];
      let live: Session | null = null;
      await m.start((b64) => {
        if (live) live.sendRealtimeInput({ audio: { data: b64, mimeType: `audio/pcm;rate=${IN_RATE}` } });
        else if (frames.length < 20) frames.push(b64); // keep up to 2 s spoken while connecting
      });

      // 2. A token for this run; the server summarises the run into the system instruction.
      const res = await fetch("/api/live/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: run.id }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `token request failed (HTTP ${res.status})`);
      }
      const tok = (await res.json()) as LiveTokenResponse;
      setExpiresAt(tok.expiresAt);

      // 3. Connect with the ephemeral token. Same config as the one locked into the token.
      speaker.current = new Speaker(setSpeaking);
      const ai = new GoogleGenAI({ apiKey: tok.token, httpOptions: { apiVersion: "v1alpha" } });
      const s = await ai.live.connect({
        model: tok.model || LIVE_MODEL,
        config: liveConnectConfig(tok.systemInstruction),
        callbacks: {
          onopen: () => setPhase("live"),
          onmessage: onMessage,
          onerror: (e) => {
            setError(e.message || "The live connection failed.");
            setPhase("error");
          },
          onclose: (e) => {
            if (closing.current) return;
            setPhase((p) => (p === "error" ? p : "idle"));
            if (e.reason && !closing.current) setError(e.reason);
            void teardown();
          },
        },
      });
      session.current = s;
      live = s;
      for (const b64 of frames) s.sendRealtimeInput({ audio: { data: b64, mimeType: `audio/pcm;rate=${IN_RATE}` } });
      frames = [];
      setPhase("live");
      s.sendRealtimeInput({ text: "Say hello in one short sentence and tell me where the cut stands." });
    } catch (err) {
      await teardown();
      setError(describeError(err));
      setPhase("error");
    }
  }, [run.id, onMessage, teardown]);

  // Narrate mode: a short editor-originated turn whenever the run moves on.
  const narrateKey = `${run.status}:${run.iterations.length}`;
  const lastKey = useRef(narrateKey);
  useEffect(() => {
    if (lastKey.current === narrateKey) return;
    lastKey.current = narrateKey;
    if (phase !== "live" || !narrate) return;
    try {
      session.current?.sendRealtimeInput({ text: statusUpdate(run) });
    } catch {
      /* socket closed between renders */
    }
  }, [narrateKey, phase, narrate, run]);

  // Clean disconnect on unmount.
  useEffect(() => {
    return () => {
      void teardown();
    };
  }, [teardown]);

  // Keep the transcript scrolled to the newest line.
  useEffect(() => {
    transcriptEnd.current?.scrollIntoView({ block: "end" });
  }, [lines]);

  const live = phase === "live";
  const busy = phase === "connecting";

  return (
    <div className={cn("relative shrink-0", className)}>
      <button
        type="button"
        onClick={() => (live || busy ? setOpen((o) => !o) : void start())}
        aria-pressed={live}
        aria-label={live ? "Argon is listening. Open the live transcript" : "Talk to Argon"}
        className={cn(
          "inline-flex h-8 items-center gap-2 rounded-lg border px-3 text-sm font-medium transition-colors",
          live ? "border-success/40 bg-success/15 text-success hover:bg-success/25" : "bg-panel-2 text-foreground hover:bg-accent",
          phase === "error" && "border-fail/40 text-fail",
        )}
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : live ? <Radio className="size-4" /> : <Mic className="size-4" />}
        <span className="hidden sm:inline">{live ? "Listening" : busy ? "Connecting…" : "Talk to Argon"}</span>
        {live && speaking && <Volume2 className="size-3.5 animate-pulse" aria-label="Argon is speaking" />}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Argon voice assistant"
          className="absolute right-0 top-full z-40 mt-2 flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border bg-panel shadow-tile"
        >
          <div className="flex items-center gap-2 border-b px-3 py-2">
            <span className={cn("size-2 rounded-full", live ? (speaking ? "bg-success animate-pulse" : "bg-success") : busy ? "bg-amber animate-pulse" : "bg-muted-foreground/40")} />
            <span className="text-xs font-medium">{live ? (speaking ? "Argon is speaking" : "Argon is listening") : busy ? "Connecting to Gemini Live" : "Not connected"}</span>
            <span className="flex-1" />
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground" title="Speak a one-line update whenever the run changes status">
              <input type="checkbox" className="accent-primary" checked={narrate} onChange={(e) => setNarrate(e.target.checked)} />
              Narrate
            </label>
            <button type="button" onClick={() => setOpen(false)} className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Hide transcript">
              <X className="size-3.5" />
            </button>
          </div>

          <div className="max-h-64 min-h-24 overflow-y-auto px-3 py-2 text-sm">
            {lines.length === 0 && !error && (
              <p className="text-xs text-muted-foreground">
                {live
                  ? "Ask how the cut is going, or give a note like “tighten the opening and drop the second caption”."
                  : "Requesting the microphone and a session token…"}
              </p>
            )}
            {lines.map((l, i) => (
              <p
                key={i}
                className={cn(
                  "mb-1.5 leading-snug",
                  l.role === "you" && "text-foreground",
                  l.role === "argon" && "text-muted-foreground",
                  l.role === "tool" && "rounded-md bg-accent/60 px-2 py-1 text-xs text-foreground",
                )}
              >
                {l.role !== "tool" && <span className="mr-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">{l.role === "you" ? "You" : "Argon"}</span>}
                {l.text}
                {!l.final && l.role !== "tool" && <span className="ml-0.5 inline-block w-1 animate-pulse">▍</span>}
              </p>
            ))}
            {error && (
              <p role="alert" className="mt-1 rounded-md bg-fail/10 px-2 py-1.5 text-xs text-fail ring-1 ring-fail/25">
                {error}
                {/credits/i.test(error) && (
                  <>
                    {" "}
                    <a href="https://aistudio.google.com/billing" target="_blank" rel="noreferrer" className="underline">
                      Open billing
                    </a>
                  </>
                )}
              </p>
            )}
            <div ref={transcriptEnd} />
          </div>

          <div className="flex items-center gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
            <span className="min-w-0 flex-1 truncate">
              {live && expiresAt ? `${LIVE_MODEL} · session until ${new Date(expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : LIVE_MODEL}
            </span>
            {live || busy ? (
              <button type="button" onClick={() => void stop()} className="inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs font-medium text-foreground hover:bg-accent">
                <MicOff className="size-3.5" />
                Stop
              </button>
            ) : (
              <button type="button" onClick={() => void start()} className="inline-flex h-7 items-center gap-1.5 rounded-md bg-primary px-2 text-xs font-medium text-primary-foreground hover:brightness-105">
                <Mic className="size-3.5" />
                {phase === "error" ? "Try again" : "Start"}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default LiveAssistant;
