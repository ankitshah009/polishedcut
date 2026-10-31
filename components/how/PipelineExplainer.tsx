"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import type { Check, Cut, PatchOp, Run } from "@/lib/schema";

type StageId = "transcribe" | "draft" | "render" | "watch" | "patch";

const STAGES: { id: StageId; name: string; who: string; out: string }[] = [
  { id: "transcribe", name: "Transcribe", who: "gemini-3.5-transcribe", out: "words with timestamps" },
  { id: "draft", name: "Draft", who: "gemini-4-argon", out: "edit decision list" },
  { id: "render", name: "Render", who: "ffmpeg", out: "mp4" },
  { id: "watch", name: "Watch", who: "gemini-4-argon", out: "timestamped checks" },
  { id: "patch", name: "Patch", who: "gemini-4-argon", out: "patch ops" },
];

interface Example {
  source: "live" | "static";
  brief: string;
  words: { text: string; start: number; end: number }[];
  cuts: Cut[];
  checks: Check[];
  patches: PatchOp[];
  versions: number;
}

const STATIC: Example = {
  source: "static",
  brief: "30-second recap of the keynote. Open on the product reveal, caption the key line.",
  words: [
    { text: "Today", start: 12.4, end: 12.8 },
    { text: "we're", start: 12.8, end: 13.0 },
    { text: "shipping", start: 13.0, end: 13.5 },
    { text: "Argon", start: 13.5, end: 14.1 },
  ],
  cuts: [
    { id: "c1", clipId: "clip1", srcIn: 12.4, srcOut: 18.9, reason: "Product reveal opens the recap" },
    { id: "c2", clipId: "clip2", srcIn: 40.2, srcOut: 51.0, reason: "Live demo, strongest reaction" },
    { id: "c3", clipId: "clip1", srcIn: 88.0, srcOut: 97.5, reason: "Closing line" },
  ],
  checks: [
    { name: "brief: opens on the product reveal", passed: true, at: 0.4, note: "" },
    { name: "cut lands mid-word", passed: false, at: 17.3, note: "c2 starts on 'and-' — trim 0.3s" },
  ],
  patches: [{ op: "trim", cutId: "c2", srcIn: 40.5, srcOut: 51.0 }],
  versions: 2,
};

function fromRun(run: Run): Example | null {
  const its = run.iterations;
  if (!its.length) return null;
  const crit = its.find((i) => i.critique && i.critique.checks.some((c) => !c.passed))?.critique ?? its[0].critique;
  const words = run.clips.flatMap((c) => c.transcript).slice(0, 12);
  return {
    source: "live",
    brief: run.brief,
    words: words.length ? words : STATIC.words,
    cuts: its[0].edl.cuts,
    checks: crit?.checks ?? [],
    patches: crit?.patches ?? [],
    versions: its.length,
  };
}

const t = (s: number | null | undefined) => (s == null ? "" : `${s.toFixed(1)}s`);

export default function PipelineExplainer() {
  const [active, setActive] = useState<StageId>("watch");
  const [ex, setEx] = useState<Example>(STATIC);
  const reduce = useReducedMotion();

  useEffect(() => {
    let off = false;
    fetch("/api/runs")
      .then((r) => (r.ok ? r.json() : []))
      .then((runs: Run[]) => {
        const done = runs
          .filter((r) => r.status === "done" && r.iterations.length)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const e = done.length ? fromRun(done[0]) : null;
        if (!off && e) setEx(e);
      })
      .catch(() => {});
    return () => {
      off = true;
    };
  }, []);

  return (
    <section className="mt-14">
      <div className="relative">
        <ol className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {STAGES.map((s, i) => {
            const on = s.id === active;
            const loop = s.id === "render" || s.id === "watch" || s.id === "patch";
            return (
              <motion.li
                key={s.id}
                initial={reduce ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.08, duration: 0.35 }}
              >
                <button
                  type="button"
                  onClick={() => setActive(s.id)}
                  aria-pressed={on}
                  className={`group relative w-full rounded-lg border px-4 py-4 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent ${
                    on ? "border-accent bg-card" : "border-line bg-panel hover:border-line-strong"
                  }`}
                >
                  <span className="font-mono text-xs text-faint">{i + 1}</span>
                  <span className={`mt-1 block font-serif text-2xl ${on ? "text-fg" : "text-dim"}`}>{s.name}</span>
                  <span className="mt-2 block font-mono text-[11px] text-faint">{s.who}</span>
                  <span className="mt-3 block text-[13px] text-dim">{s.out}</span>
                  {loop && <span className="absolute right-3 top-3 h-1.5 w-1.5 rounded-full bg-accent/70" />}
                </button>
              </motion.li>
            );
          })}
        </ol>

        {/* loop arrow: Patch back to Render (columns 3 to 5) */}
        <div className="hidden grid-cols-5 gap-3 sm:grid" aria-hidden>
          <motion.div
            className="relative col-span-3 col-start-3 h-10 rounded-b-2xl border-x-2 border-b-2 border-dashed border-accent"
            style={{ marginLeft: "calc(50% / 3)", marginRight: "calc(50% / 3)", transformOrigin: "top" }}
            initial={reduce ? false : { scaleY: 0, opacity: 0 }}
            animate={{ scaleY: 1, opacity: 1 }}
            transition={{ delay: 0.5, duration: 0.5 }}
          >
            <span className="absolute -left-[7px] -top-1 h-0 w-0 border-x-[6px] border-b-[9px] border-x-transparent border-b-accent" />
            <span className="absolute -bottom-3 left-1/2 -translate-x-1/2 whitespace-nowrap bg-bg px-3 text-[13px] text-dim">
              Re-render with patches until every check passes, up to 3 versions
            </span>
          </motion.div>
        </div>
      </div>

      <div className="mt-8 rounded-xl border border-line bg-panel">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-5 py-3">
          <span className="text-sm text-dim">
            {ex.source === "live" ? "From your latest finished run" : "Example data (no finished run yet)"}
          </span>
          <span className="max-w-[60ch] truncate text-sm text-faint">Brief: {ex.brief}</span>
        </div>
        <AnimatePresence mode="wait">
          <motion.div
            key={active}
            initial={reduce ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? undefined : { opacity: 0, y: -6 }}
            transition={{ duration: 0.2 }}
            className="p-5"
          >
            <Detail stage={active} ex={ex} />
          </motion.div>
        </AnimatePresence>
      </div>
    </section>
  );
}

function Detail({ stage, ex }: { stage: StageId; ex: Example }) {
  if (stage === "transcribe")
    return (
      <Frame text="Every clip is transcribed to words with start and end times, so Argon can cut on word boundaries.">
        <div className="flex flex-wrap gap-2">
          {ex.words.map((w, i) => (
            <span key={i} className="rounded border border-line bg-card px-2 py-1 text-sm">
              {w.text} <span className="font-mono text-[11px] text-faint">{t(w.start)}</span>
            </span>
          ))}
        </div>
      </Frame>
    );
  if (stage === "draft")
    return (
      <Frame text="Argon reads the brief, the transcripts and the clips themselves, then returns an EDL: which source ranges to use, in what order, and why.">
        <table className="w-full text-left text-sm">
          <thead className="text-faint">
            <tr>
              <th className="py-1 pr-4 font-normal">Cut</th>
              <th className="py-1 pr-4 font-normal">Clip</th>
              <th className="py-1 pr-4 font-normal">Source range</th>
              <th className="py-1 font-normal">Reason</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {ex.cuts.slice(0, 8).map((c) => (
              <tr key={c.id}>
                <td className="py-2 pr-4 font-mono text-accent">{c.id}</td>
                <td className="py-2 pr-4 font-mono text-dim">{c.clipId}</td>
                <td className="py-2 pr-4 font-mono">
                  {t(c.srcIn)} – {t(c.srcOut)}
                </td>
                <td className="py-2 text-dim">{c.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Frame>
    );
  if (stage === "render")
    return (
      <Frame text={`ffmpeg turns the EDL into a real video file. This run produced ${ex.versions} version${ex.versions === 1 ? "" : "s"}.`}>
        <div className="flex h-10 overflow-hidden rounded border border-line">
          {ex.cuts.slice(0, 12).map((c, i) => (
            <div
              key={c.id}
              style={{ flexGrow: Math.max(0.5, c.srcOut - c.srcIn) }}
              className={`flex items-center border-r border-line px-2 font-mono text-[11px] ${i % 2 ? "bg-card" : "bg-raised"}`}
            >
              {c.id}
            </div>
          ))}
        </div>
      </Frame>
    );
  if (stage === "watch")
    return (
      <Frame text="Argon watches the rendered mp4, not the EDL, and grades it. Failures carry a timestamp on the output timeline.">
        <ul className="space-y-2">
          {ex.checks.slice(0, 6).map((c, i) => (
            <li key={i} className="flex gap-3 rounded border border-line bg-card px-3 py-2 text-sm">
              <span className={c.passed ? "text-ok" : "text-bad"}>{c.passed ? "Pass" : "Fail"}</span>
              <span className="font-mono text-faint">{t(c.at)}</span>
              <span className="flex-1">
                {c.name}
                {c.note && <span className="block text-dim">{c.note}</span>}
              </span>
            </li>
          ))}
        </ul>
      </Frame>
    );
  return (
    <Frame text="Failed checks become small patch operations on the EDL, which is re-rendered and watched again.">
      {ex.patches.length ? (
        <pre className="overflow-x-auto rounded border border-line bg-card p-3 font-mono text-[12px] leading-relaxed text-dim">
          {ex.patches
            .slice(0, 6)
            .map((p) =>
              JSON.stringify(Object.fromEntries(Object.entries(p).filter(([, v]) => v != null))),
            )
            .join("\n")}
        </pre>
      ) : (
        <p className="text-sm text-ok">Every check passed on the first watch, so no patches were needed.</p>
      )}
    </Frame>
  );
}

function Frame({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-6 md:grid-cols-[280px_1fr]">
      <p className="max-w-[40ch] leading-relaxed text-dim">{text}</p>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
