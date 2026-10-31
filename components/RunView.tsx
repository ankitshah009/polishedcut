"use client";

import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  AudioLines,
  AudioWaveform,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleStop,
  Clapperboard,
  Eye,
  Info,
  Loader2,
  Maximize,
  MessageSquareText,
  Music,
  Palette,
  Pause,
  Play,
  Receipt,
  RotateCcw,
  ScanSearch,
  Scissors,
  SkipBack,
  Sparkles,
  Tag,
  Volume2,
  VolumeX,
  WandSparkles,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  checkGroup,
  checkLabel,
  costChip,
  currentStage,
  cutAt,
  cutRanges,
  describeWarning,
  edlAudio,
  edlDuration,
  edlEndImage,
  edlEndTitle,
  edlMusic,
  edlOverlays,
  edlTitleImage,
  endCardRange,
  fixCardsBetween,
  formatDuration,
  formatTime,
  recutText,
  runElapsedMs,
  runUsage,
  stageIds,
  TITLE_SECONDS,
  videoUrl,
  type AudioMix,
  type CheckGroupId,
  type FixCard,
  type MusicBed,
  type NoteTone,
  type StageId,
} from "@/lib/format";
import type { Check as CheckT, EDL, Iteration, Run } from "@/lib/schema";
import { retryRun, usePricing, useRun } from "@/lib/use-run";
import { cn } from "@/lib/utils";

import { ExportDialog } from "./ExportDialog";
import { LiveAssistant } from "./live/LiveAssistant";
import { RunProgress } from "./RunProgress";
import { Wordmark } from "./shell/Wordmark";
import { PositionGlyph, spriteFrame, spriteFrameStyle, Timeline, TimelineSkeleton, useSprites } from "./Timeline";
import { Tooltip, TooltipTheme } from "./ui/tooltip";

const FPS = 30;

const STAGES: Record<StageId, { n: string; i: LucideIcon; hint: string }> = {
  transcribe: { n: "Transcribe", i: AudioLines, hint: "Listening to every clip" },
  analyze: { n: "Analyze", i: ScanSearch, hint: "Argon studies the footage shot by shot" },
  draft: { n: "Draft", i: Scissors, hint: "Argon picks the moments" },
  generate: { n: "Generate", i: WandSparkles, hint: "Generating the shots the footage did not have" },
  art: { n: "Art", i: Palette, hint: "Painting the title card" },
  music: { n: "Music", i: Music, hint: "Composing a music bed to the brief" },
  render: { n: "Render", i: Clapperboard, hint: "ffmpeg assembles the cut" },
  watch: { n: "Watch", i: Eye, hint: "Argon reviews the render against your brief" },
  fix: { n: "Fix", i: Wrench, hint: "Patching what failed, then rendering again" },
};

const GROUPS: { id: CheckGroupId; title: string; hint: string }[] = [
  { id: "brief", title: "Your brief", hint: "what you asked for" },
  { id: "auto", title: "Verified", hint: "measured on the transcript" },
  { id: "craft", title: "Craft", hint: "Argon's own standards" },
];

type Tab = "checks" | "fixes" | "edits";

/** Largest `aspect` box that fits inside the element behind `ref`. */
function useFit(ref: React.RefObject<HTMLDivElement | null>, aspect: number): { w: number; h: number } {
  const [box, setBox] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [ref]);
  const w = Math.max(0, Math.min(box.w, box.h * aspect));
  return { w, h: w / aspect };
}

/**
 * Outer shell: remounts the live editor after a director's note is accepted, so useRun (which
 * stops listening once a run finishes) reconnects to the run that has just gone live again.
 */
export function RunView({ runId }: { runId: string }) {
  const [epoch, setEpoch] = useState(0);
  const [seed, setSeed] = useState<Run | null>(null);
  return (
    <TooltipTheme.Provider value="dark">
      <Editor
        key={epoch}
        runId={runId}
        seed={seed}
        onRevised={(r) => {
          setSeed(r);
          setEpoch((e) => e + 1);
        }}
      />
    </TooltipTheme.Provider>
  );
}

function Editor({ runId, seed, onRevised }: { runId: string; seed: Run | null; onRevised: (run: Run) => void }) {
  const live = useRun(runId);
  const run = live.run ?? seed;
  const error = live.error;
  const pricing = usePricing();

  const [picked, setPicked] = useState<number | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [tab, setTab] = useState<Tab>("checks");
  const video = useRef<HTMLVideoElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const fitRef = useRef<HTMLDivElement>(null);

  const its = run?.iterations ?? [];
  const idx = picked != null && picked < its.length ? picked : its.length - 1;
  const it: Iteration | undefined = its[idx];
  const aspect = it ? it.edl.width / it.edl.height : 16 / 9;
  const fit = useFit(fitRef, aspect);

  // Deep links: /runs/<id>#fixes or #edits open that inspector tab, now and whenever the hash changes.
  useEffect(() => {
    const apply = () => {
      const h = window.location.hash.slice(1);
      if (h === "checks" || h === "fixes" || h === "edits") setTab(h);
    };
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, []);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      if (video.current) setTime(video.current.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Space toggles playback; arrow keys step one frame. Ignored while typing or on a focused control.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest("input, textarea, select, [role=slider], [contenteditable]")) return;
      const v = video.current;
      if (!v) return;
      if (e.code === "Space" && !el?.closest("button, a")) {
        e.preventDefault();
        if (v.paused) void v.play();
        else v.pause();
      } else if (e.code === "ArrowLeft" || e.code === "ArrowRight") {
        e.preventDefault();
        v.pause();
        v.currentTime = Math.max(0, v.currentTime + (e.code === "ArrowLeft" ? -1 : 1) / FPS);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const shell = "dark fixed inset-0 z-30 flex flex-col overflow-hidden bg-background text-foreground";

  if (!run) {
    return (
      <div className={cn(shell, "items-center justify-center")}>
        {error ? (
          <div className="flex max-w-sm flex-col items-center gap-3 px-6 text-center">
            <X className="size-6 text-fail" />
            <p className="text-[15px]">This cut couldn’t be loaded</p>
            <p className="text-sm text-muted-foreground">{error}</p>
            <Link href="/" className="mt-2 inline-flex h-8 items-center gap-2 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground">
              <ArrowLeft className="size-4" /> Back to the dashboard
            </Link>
          </div>
        ) : (
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        )}
      </div>
    );
  }

  const done = run.status === "done";
  const failed = run.status === "error";
  const running = !done && !failed;
  const stages = stageIds(run);
  const stageI = currentStage(run);
  const stageNow = STAGES[stages[stageI] ?? "draft"];
  const music = it ? edlMusic(it.edl) : null;
  const audio = it ? edlAudio(it.edl) : null;
  // Argon may state the music level on the bed itself or on the mix; the mix wins when both are set.
  const musicGain = audio?.musicGainDb ?? music?.gainDb;
  const titleImage = it ? edlTitleImage(it.edl) : null;
  const titleImageUrl = titleImage ? videoUrl(run.id, titleImage) : null;
  const endTitle = it ? edlEndTitle(it.edl) : null;
  const endImage = it && endTitle ? edlEndImage(it.edl) : null;
  const endImageUrl = endImage ? videoUrl(run.id, endImage) : null;
  const endCard = it ? endCardRange(it.edl) : null;
  const cost = costChip(runUsage(run), pricing?.rates);
  const cr = it?.critique ?? null;
  const checks = cr?.checks ?? [];
  const fails = checks.filter((c) => !c.passed);
  const passed = checks.length - fails.length;
  const last = its[its.length - 1];
  const lastFails = last?.critique ? last.critique.checks.filter((c) => !c.passed).length : 0;
  const dur = it ? edlDuration(it.edl) : 0;
  const seg = it ? cutAt(it.edl, time) : null;
  const elapsed = runElapsedMs(run);
  const recut = recutText(its);
  const canRevise = (done || failed) && its.length > 0;
  const clipDurations = Object.fromEntries(run.clips.map((c) => [c.id, c.duration]));
  const clipOrder = run.clips.map((c) => c.id);

  const seek = (t: number) => {
    const v = video.current;
    if (!v) return;
    v.currentTime = Math.min(Math.max(0, t), dur);
    setTime(v.currentTime);
  };
  const step = (dir: -1 | 1) => {
    video.current?.pause();
    seek(time + dir / FPS);
  };
  const toggle = () => {
    const v = video.current;
    if (!v) return;
    if (v.paused) {
      if (v.ended || (dur > 0 && v.currentTime >= dur - 0.02)) v.currentTime = 0;
      void v.play();
    } else v.pause();
  };
  const fullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void stage.current?.requestFullscreen();
  };

  return (
    <div className={shell}>
      {/* Header */}
      <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-panel px-4">
        <Link href="/" className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Back to the dashboard">
          <ArrowLeft className="size-4" />
        </Link>
        <Wordmark className="text-xl" />
        <span className="h-5 w-px bg-border" />
        <h1 className="min-w-0 flex-1 truncate text-sm font-normal text-muted-foreground" title={run.brief}>
          {run.brief}
        </h1>
        {audio?.denoise && (
          <Tooltip label="Background noise was reduced on the speech before the mix">
            <span className="hidden shrink-0 items-center gap-1.5 rounded-full bg-success/15 px-3 py-1 text-xs font-medium text-success md:inline-flex">
              <AudioWaveform className="size-3" />
              Denoised
            </span>
          </Tooltip>
        )}
        {music && (
          <Tooltip label={<span className="block">Music bed · {music.prompt}{musicGain != null ? ` · ${musicGain > 0 ? "+" : ""}${musicGain} dB` : ""}</span>}>
            <span className="hidden shrink-0 items-center gap-1.5 rounded-full bg-clip-2/15 px-3 py-1 text-xs font-medium text-clip-2 md:inline-flex">
              <Music className="size-3" />
              <span className="max-w-40 truncate">{music.prompt}</span>
              {musicGain != null && (
                <span className="font-tc shrink-0 rounded-full bg-background/40 px-1.5 text-[10px] leading-4">
                  {musicGain > 0 ? "+" : ""}
                  {musicGain} dB
                </span>
              )}
            </span>
          </Tooltip>
        )}
        {cost && !running && (
          <Tooltip label="Estimated spend on this cut, from the tokens Argon used and the current per-model rates">
            <Link href="/pricing" className="font-tc hidden shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs text-muted-foreground hover:text-foreground sm:inline-flex">
              <Receipt className="size-3" />
              {cost}
            </Link>
          </Tooltip>
        )}
        {running ? (
          <span role="status" aria-live="polite" className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-amber/15 px-3 py-1 text-xs font-medium text-amber">
            <Loader2 className="size-3 animate-spin" />
            {stageNow.n}…
          </span>
        ) : failed ? (
          <span role="status" title={run.error} className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-fail/15 px-3 py-1 text-xs font-medium text-fail">
            <AlertTriangle className="size-3" />
            Stopped
          </span>
        ) : lastFails ? (
          <span role="status" className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-fail/15 px-3 py-1 text-xs font-medium text-fail">
            <span className="size-1.5 rounded-full bg-fail" />v{last.n} · {lastFails} failing
          </span>
        ) : (
          <span role="status" className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-success/15 px-3 py-1 text-xs font-medium text-success">
            <span className="size-1.5 rounded-full bg-success" />
            All checks passed
          </span>
        )}
        <ExportDialog run={run} it={last} disabled={running} />
        <LiveAssistant run={run} />
      </header>

      {/* Version tabs / stepper */}
      <div className={cn("flex h-11 shrink-0 items-center gap-1 overflow-x-auto border-b bg-panel px-4 [scrollbar-width:none]", !running && its.length === 0 && "hidden")}>
        {its.map((v, k) => {
          const vChecks = v.critique?.checks ?? [];
          const f = vChecks.filter((c) => !c.passed).length;
          const active = k === idx;
          return (
            <button
              key={v.n}
              type="button"
              role="tab"
              aria-selected={active}
              title={v.note ? `Director's note: ${v.note}` : undefined}
              onClick={() => {
                setPicked(k);
                setTime(0);
              }}
              className={cn(
                "relative flex h-8 shrink-0 items-center gap-2 rounded-md px-3 text-sm transition-colors",
                active ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <span className="font-medium">v{v.n}</span>
              {v.note && <span className="text-xs text-amber">· note</span>}
              {v.critique ? (
                <>
                  <span className="flex gap-0.5">
                    {vChecks.map((c, i) => (
                      <span key={i} className={cn("size-1 rounded-full", c.passed ? "bg-success" : "bg-fail")} />
                    ))}
                  </span>
                  <span className={cn("font-tc text-xs", f ? "text-fail" : "text-success")}>
                    {vChecks.length - f}/{vChecks.length}
                  </span>
                </>
              ) : (
                <Loader2 className="size-3 animate-spin text-amber" />
              )}
            </button>
          );
        })}
        {running && its.length > 0 && <span className="mx-2 h-5 w-px shrink-0 bg-border" />}
        {running ? (
          <Stepper ids={stages} stage={stageI} />
        ) : (
          recut && (
            <span className="ml-3 inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
              <Sparkles className="size-3.5 text-amber" />
              {recut}
            </span>
          )
        )}
      </div>

      {failed && (
        <div className="flex shrink-0 items-center gap-2 border-b border-fail/30 bg-fail/10 px-4 py-1.5 text-xs text-fail">
          <AlertTriangle className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate" title={run.error}>
            This cut stopped: {run.error || "no error message was recorded"}
          </span>
          {it && <span className="hidden shrink-0 text-muted-foreground sm:inline">The last finished version is below.</span>}
          <RetryButton runId={run.id} onStarted={onRevised} size="sm" />
        </div>
      )}

      {/* Main */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
        {running && !it ? (
          /* Nothing to play yet: the whole viewer tells the story of the cut in progress. */
          <section className="flex min-w-0 flex-1 flex-col overflow-y-auto bg-background" aria-label="Progress">
            <RunProgress run={run} />
          </section>
        ) : (
        <section className="flex min-w-0 shrink-0 flex-col bg-background p-3 lg:min-h-0 lg:flex-1 lg:shrink lg:p-5" aria-label="Viewer">
          <div ref={fitRef} className="flex aspect-video w-full items-center justify-center lg:aspect-auto lg:min-h-0 lg:flex-1">
            <div
              ref={stage}
              className="relative overflow-hidden rounded-lg bg-track shadow-lift ring-1 ring-border"
              style={{ width: fit.w || "100%", height: fit.h || "100%" }}
            >
              {!it ? (
                <div className="absolute inset-0 grid place-items-center">
                  <div className="absolute inset-0 animate-pulse bg-muted/40" />
                  <div className="relative flex max-w-sm flex-col items-center gap-3 px-6 text-center text-sm text-muted-foreground">
                    {failed ? (
                      <>
                        <X className="size-6 text-fail" />
                        <p className="text-foreground">Argon stopped before the first version</p>
                        <p className="font-tc max-w-full rounded-lg border bg-panel px-3 py-2 text-left text-xs leading-relaxed break-words">
                          {run.error || "No error message was recorded."}
                        </p>
                        <RetryButton runId={run.id} onStarted={onRevised} />
                      </>
                    ) : (
                      <>
                        <Loader2 className="size-6 animate-spin text-amber" />
                        <p className="text-foreground">{stageNow.n === "Watch" ? "Argon is watching v1…" : `${stageNow.n}…`}</p>
                        <p className="text-xs">
                          {stageNow.hint}. Argon watches all {run.clips.length} clip{run.clips.length === 1 ? "" : "s"} before it cuts; the first version usually lands in about a minute.
                        </p>
                      </>
                    )}
                  </div>
                </div>
              ) : (
                <>
                  <AnimatePresence mode="wait">
                    <motion.video
                      key={it.video}
                      ref={video}
                      src={videoUrl(run.id, it.video)}
                      playsInline
                      preload="auto"
                      muted={muted}
                      poster={titleImageUrl ?? undefined}
                      onLoadedMetadata={(e) => {
                        const v = e.currentTarget;
                        v.volume = volume;
                        // Paint a real poster frame instead of black: skip past the title card when there is one.
                        // When Argon painted title art, that art is the poster, so the frame stays at 0.
                        if (v.currentTime === 0 && !titleImageUrl) v.currentTime = it.edl.title ? TITLE_SECONDS + 0.05 : 0.05;
                      }}
                      onPlay={() => setPlaying(true)}
                      onPause={() => setPlaying(false)}
                      onEnded={() => setPlaying(false)}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.2 }}
                      className="absolute inset-0 size-full bg-black object-contain"
                    />
                  </AnimatePresence>
                  <AnimatePresence>
                    {!playing && (
                      <motion.button
                        type="button"
                        onClick={toggle}
                        aria-label="Play"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.15 }}
                        className="absolute inset-0 grid place-items-center bg-background/20 transition-colors hover:bg-background/10"
                      >
                        <span className="grid size-16 place-items-center rounded-full bg-background/80 ring-1 ring-border backdrop-blur">
                          <Play className="ml-1 size-7 fill-foreground" />
                        </span>
                      </motion.button>
                    )}
                  </AnimatePresence>
                  {playing && <button type="button" onClick={toggle} className="absolute inset-0" aria-label="Pause" />}
                  <span className="font-tc pointer-events-none absolute top-3 right-3 rounded bg-background/70 px-2 py-0.5 text-xs backdrop-blur">
                    v{it.n} · {seg ? `${seg.cut.id} · ${seg.cut.clipId}` : endCard && time >= endCard.start ? "end card" : it.edl.title ? "title" : "—"}
                  </span>
                </>
              )}
            </div>
          </div>

          {/* Transport */}
          <div className="mt-3 flex shrink-0 items-center gap-2 lg:mt-4 lg:gap-3">
            <TBtn label="Back to start" onClick={() => seek(0)} disabled={!it}>
              <SkipBack className="size-4" />
            </TBtn>
            <TBtn label="Previous frame (←)" onClick={() => step(-1)} disabled={!it}>
              <ChevronLeft className="size-4" />
            </TBtn>
            <button
              type="button"
              onClick={toggle}
              disabled={!it}
              aria-label={playing ? "Pause (space)" : "Play (space)"}
              className="grid size-9 shrink-0 place-items-center rounded-full bg-foreground text-background disabled:opacity-40"
            >
              {playing ? <Pause className="size-4 fill-background" /> : <Play className="ml-0.5 size-4 fill-background" />}
            </button>
            <TBtn label="Next frame (→)" onClick={() => step(1)} disabled={!it}>
              <ChevronRight className="size-4" />
            </TBtn>
            <span className="font-tc shrink-0 text-sm whitespace-nowrap sm:w-36">
              <span>{formatTime(time)}</span>
              <span className="hidden text-muted-foreground sm:inline"> / {formatTime(dur)}</span>
            </span>
            <Scrubber t={time} dur={dur} fails={fails} onSeek={seek} />
            <TBtn label={muted ? "Unmute" : "Mute"} onClick={() => setMuted((m) => !m)}>
              {muted || volume === 0 ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
            </TBtn>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              aria-label="Volume"
              onChange={(e) => {
                const v = Number(e.target.value);
                setVolume(v);
                setMuted(v === 0);
                if (video.current) video.current.volume = v;
              }}
              className="hidden h-1 w-20 cursor-pointer accent-amber md:block"
            />
            <TBtn label="Fullscreen" onClick={fullscreen} disabled={!it}>
              <Maximize className="size-4" />
            </TBtn>
          </div>
        </section>
        )}

        {/* Inspector */}
        <aside className="flex w-full shrink-0 flex-col border-t bg-panel lg:min-h-0 lg:w-[360px] lg:border-t-0 lg:border-l" aria-label="Inspector">
          {running && (
            <div className="shrink-0 border-b">
              <RunProgress run={run} compact />
            </div>
          )}
          <div role="tablist" className={cn("flex shrink-0 gap-1 border-b p-2", running && !it && "hidden")}>
            {(["checks", "fixes", "edits"] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={tab === k}
                onClick={() => setTab(k)}
                className={cn(
                  "flex-1 rounded-md py-1.5 text-sm transition-colors",
                  tab === k ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {k === "edits" ? "Edit list" : k === "checks" ? "Checks" : "Fixes"}
                {k === "checks" && checks.length > 0 && (
                  <span className={cn("font-tc ml-1.5 text-xs", fails.length ? "text-fail" : "text-success")}>
                    {passed}/{checks.length}
                  </span>
                )}
                {k === "fixes" && <FixCount its={its} />}
              </button>
            ))}
          </div>

          <div className="p-3 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
            {!it ? (
              failed ? (
                <p className="px-1 text-sm text-muted-foreground">Nothing to inspect: the cut stopped before Argon rendered a version. Use “Start again” to run it once more.</p>
              ) : (
                <p className="px-1 text-xs text-faint">Checks, fixes and the edit list appear here once Argon has rendered and watched v1.</p>
              )
            ) : tab === "checks" ? (
              <ChecksTab it={it} elapsed={elapsed} cost={cost} warnings={run.warnings} running={running} onSeek={seek} />
            ) : tab === "fixes" ? (
              <FixesTab its={its} running={running} onSeek={seek} />
            ) : (
              <EditList
                runId={run.id}
                edl={it.edl}
                music={music}
                musicGain={musicGain}
                audio={audio}
                titleImageUrl={titleImageUrl}
                endImageUrl={endImageUrl}
                clipOrder={clipOrder}
                clipDurations={clipDurations}
                onSeek={seek}
              />
            )}
          </div>

          {canRevise && <DirectorsNote runId={run.id} onAccepted={onRevised} />}
        </aside>
      </div>

      {it ? (
        <Timeline
          runId={run.id}
          edl={it.edl}
          music={music}
          titleImageUrl={titleImageUrl}
          endImageUrl={endImageUrl}
          clipOrder={clipOrder}
          clipDurations={clipDurations}
          failures={fails}
          time={time}
          onSeek={seek}
        />
      ) : (
        <TimelineSkeleton />
      )}
    </div>
  );
}

function TBtn({ children, label, onClick, disabled }: { children: React.ReactNode; label: string; onClick?: () => void; disabled?: boolean }) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        disabled={disabled}
        className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
      >
        {children}
      </button>
    </Tooltip>
  );
}

function Stepper({ ids, stage }: { ids: StageId[]; stage: number }) {
  return (
    <ol className="flex shrink-0 items-center gap-1" aria-label="Progress">
      {ids.map((id, k) => {
        const s = STAGES[id];
        const done = k < stage;
        const cur = k === stage;
        return (
          <li key={id} className="flex items-center gap-1" aria-current={cur ? "step" : undefined} title={cur ? s.hint : undefined}>
            <span className={cn("flex h-7 items-center gap-1.5 rounded-md px-2.5 text-sm", cur ? "bg-amber/15 text-amber" : done ? "text-success" : "text-muted-foreground")}>
              {done ? <Check className="size-3.5" /> : cur ? <Loader2 className="size-3.5 animate-spin" /> : <s.i className="size-3.5" />}
              {s.n}
            </span>
            {k < ids.length - 1 && <span className={cn("h-px w-6", done ? "bg-success/50" : "bg-border")} />}
          </li>
        );
      })}
    </ol>
  );
}

/** "Start again" for a stopped cut: POSTs the retry, then hands the re-queued run up so the editor reconnects to it. */
function RetryButton({ runId, onStarted, size = "md" }: { runId: string; onStarted: (run: Run) => void; size?: "sm" | "md" }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const go = async () => {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    const r = await retryRun(runId);
    if (r.ok) {
      onStarted(r.run);
      return;
    }
    setMsg(r.message);
    setBusy(false);
  };
  return (
    <span className={cn("flex items-center gap-2", size === "md" && "mt-1 flex-col")}>
      <button
        type="button"
        onClick={() => void go()}
        disabled={busy}
        className={cn(
          "inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-primary font-medium text-primary-foreground hover:brightness-105 disabled:opacity-40",
          size === "sm" ? "h-6 px-2 text-xs" : "h-8 px-3 text-sm",
        )}
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
        Start again
      </button>
      {msg && (
        <span role="alert" className={cn("text-fail", size === "sm" ? "hidden max-w-64 truncate text-xs lg:inline" : "text-xs")} title={msg}>
          {msg}
        </span>
      )}
    </span>
  );
}

function Skeletons() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 7 }).map((_, k) => (
        <div key={k} className="h-14 animate-pulse rounded-lg bg-muted/60" style={{ opacity: 1 - k * 0.1 }} />
      ))}
    </div>
  );
}

function TimeChip({ t, onSeek }: { t: number; onSeek: (s: number) => void }) {
  return (
    <button
      type="button"
      onClick={() => onSeek(t)}
      aria-label={`Jump to ${formatTime(t)}`}
      className="font-tc shrink-0 rounded-md bg-accent px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-amber/20 hover:text-amber"
    >
      {formatTime(t)}
    </button>
  );
}

function ChecksTab({
  it,
  elapsed,
  cost,
  warnings,
  running,
  onSeek,
}: {
  it: Iteration;
  elapsed: number | null;
  cost: string | null;
  warnings: string[];
  running: boolean;
  onSeek: (s: number) => void;
}) {
  const cr = it.critique;
  if (!cr) {
    return (
      <div className="space-y-2">
        <p className="flex items-center gap-2 px-1 pb-1 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin text-amber" /> Argon is watching v{it.n}…
        </p>
        <Skeletons />
      </div>
    );
  }
  const fails = cr.checks.filter((c) => !c.passed).length;
  const groups = GROUPS.map((g) => ({ ...g, items: cr.checks.filter((c) => checkGroup(c.name) === g.id) }))
    .filter((g) => g.items.length)
    .sort((a, b) => b.items.filter((c) => !c.passed).length - a.items.filter((c) => !c.passed).length);
  return (
    <>
      <div className="mb-3 flex items-baseline justify-between gap-3 px-1">
        <span className="min-w-0 text-sm text-muted-foreground">
          Score
          {!running && (elapsed != null || cost) && (
            <span className="font-tc ml-2 text-xs text-faint">
              {elapsed != null && <>· Cut in {formatDuration(elapsed)} </>}
              {cost && (
                <Link href="/pricing" className="whitespace-nowrap hover:text-foreground" title="How this estimate is made">
                  · {cost}
                </Link>
              )}
            </span>
          )}
        </span>
        <span className={cn("font-tc shrink-0 text-lg font-medium", fails ? "text-fail" : "text-success")}>
          {cr.checks.length - fails}/{cr.checks.length}
        </span>
      </div>
      {cr.summary && <p className="mb-4 px-1 text-xs leading-relaxed text-muted-foreground">{cr.summary}</p>}
      {groups.map((g) => (
        <CheckGroup key={g.id} title={g.title} hint={g.hint} items={g.items} onSeek={onSeek} />
      ))}
      <ArgonNotes warnings={warnings} />
    </>
  );
}

const NOTE_ICON: Record<NoteTone, { i: LucideIcon; cls: string; label: string }> = {
  info: { i: Info, cls: "text-clip-1", label: "Argon did this" },
  caution: { i: AlertTriangle, cls: "text-amber", label: "Argon could not do this" },
  final: { i: CircleStop, cls: "text-fail", label: "Argon stopped here" },
};

/** run.warnings as a tidy list: what Argon did (info), what it had to skip (caution), and where it stopped (final). */
function ArgonNotes({ warnings }: { warnings: string[] }) {
  const notes = useMemo(() => warnings.filter((w) => w && w.trim()).map(describeWarning), [warnings]);
  if (!notes.length) return null;
  return (
    <section className="mt-2 rounded-xl border bg-panel-2 p-3" aria-label="Notes from Argon">
      <p className="mb-2 flex items-baseline gap-1.5 px-0.5 text-xs font-medium text-muted-foreground">
        Notes from Argon <span className="font-tc">· {notes.length}</span>
      </p>
      <ul className="flex flex-col gap-1.5">
        {notes.map((n, i) => {
          const tone = NOTE_ICON[n.tone];
          return (
            <li key={i} className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
              <tone.i className={cn("mt-0.5 size-3.5 shrink-0", tone.cls)} aria-label={tone.label} />
              <span className="min-w-0 flex-1 break-words">{n.text}</span>
              {n.version != null && (
                <span className="font-tc shrink-0 rounded bg-accent px-1 text-[10px] leading-4 text-faint" title={`Recorded while making v${n.version}`}>
                  v{n.version}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function CheckGroup({ title, hint, items, onSeek }: { title: string; hint: string; items: CheckT[]; onSeek: (s: number) => void }) {
  const sorted = [...items].sort((a, b) => Number(a.passed) - Number(b.passed));
  return (
    <div className="mb-4">
      <p className="mb-1.5 flex items-baseline gap-1.5 px-1 text-xs font-medium text-muted-foreground">
        {title} <span className="font-tc">· {items.filter((i) => i.passed).length}/{items.length}</span>
        <span className="ml-auto font-normal text-faint">{hint}</span>
      </p>
      <ul className="space-y-1">
        {sorted.map((c, i) => (
          <li key={i} className={cn("flex items-start gap-2.5 rounded-lg p-2.5", c.passed ? "hover:bg-accent/50" : "bg-fail/10 ring-1 ring-fail/25")}>
            <span className={cn("mt-0.5 grid size-4 shrink-0 place-items-center rounded-full", c.passed ? "bg-success/20 text-success" : "bg-fail text-background")}>
              {c.passed ? <Check className="size-2.5" strokeWidth={3} /> : <X className="size-2.5" strokeWidth={3} />}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm leading-tight font-medium">{checkLabel(c.name)}</p>
              {c.note && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{c.note}</p>}
            </div>
            {c.at != null && <TimeChip t={c.at} onSeek={onSeek} />}
          </li>
        ))}
      </ul>
    </div>
  );
}

interface FixRound {
  from: Iteration;
  to?: Iteration;
  cards: FixCard[];
}

/** One round per version pair: patches diffed against the next EDL, or a plain EDL diff for note-driven versions. */
function fixRounds(its: Iteration[]): FixRound[] {
  const rounds: FixRound[] = [];
  its.forEach((from, k) => {
    const to = its[k + 1];
    const cards = fixCardsBetween(from, to);
    if (cards.length) rounds.push({ from, to, cards });
  });
  return rounds;
}

function FixCount({ its }: { its: Iteration[] }) {
  const n = useMemo(() => fixRounds(its).reduce((s, r) => s + r.cards.length, 0), [its]);
  return n > 0 ? <span className="font-tc ml-1.5 text-xs text-muted-foreground">{n}</span> : null;
}

function FixesTab({ its, running, onSeek }: { its: Iteration[]; running: boolean; onSeek: (s: number) => void }) {
  const rounds = useMemo(() => fixRounds(its), [its]);
  const last = its[its.length - 1];
  if (!rounds.length) {
    return (
      <p className="px-1 text-sm text-muted-foreground">
        {!last?.critique
          ? `Fixes appear once Argon has watched v${last?.n ?? 1}.`
          : last.critique.checks.every((c) => c.passed)
            ? `Nothing to fix. v${last.n} passed every check.`
            : "Argon reported failures but proposed no fixes."}
      </p>
    );
  }
  return (
    <div className="space-y-4">
      {rounds.map(({ from, to, cards }) => {
        const failing = from.critique?.checks.filter((c) => !c.passed) ?? [];
        return (
          <section key={from.n} className="space-y-2">
            <div className="px-1">
              <p className="text-sm text-muted-foreground">
                {to ? (
                  <>
                    Applied to v{from.n} <ArrowRight className="inline size-3" /> v{to.n}
                  </>
                ) : running ? (
                  `Applying to make v${from.n + 1}…`
                ) : (
                  `Proposed for v${from.n}, not applied`
                )}
              </p>
              {to?.note ? (
                <p className="mt-0.5 text-xs text-amber">Your note: “{to.note}”</p>
              ) : (
                failing.length > 0 && <p className="mt-0.5 truncate text-xs text-faint">Fixing: {failing.map((c) => checkLabel(c.name)).join(", ")}</p>
              )}
            </div>
            {cards.map((f, i) => (
              <div key={i} className="rounded-xl border bg-panel-2 p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="min-w-0 truncate text-sm font-medium">{f.title}</p>
                  {f.at != null && <TimeChip t={f.at} onSeek={onSeek} />}
                </div>
                <div className="font-tc mt-2 flex flex-wrap items-center gap-2 text-sm">
                  <span className="max-w-full truncate rounded bg-fail/15 px-1.5 py-0.5 text-fail line-through decoration-fail/50">{f.before}</span>
                  <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="max-w-full truncate rounded bg-success/15 px-1.5 py-0.5 text-success">{f.after}</span>
                </div>
                {f.reason && <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{f.reason}</p>}
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}

function EditList({
  runId,
  edl,
  music,
  musicGain,
  audio,
  titleImageUrl,
  endImageUrl,
  clipOrder,
  clipDurations,
  onSeek,
}: {
  runId: string;
  edl: EDL;
  music: MusicBed | null;
  musicGain?: number;
  audio: AudioMix | null;
  titleImageUrl: string | null;
  endImageUrl: string | null;
  clipOrder: string[];
  clipDurations: Record<string, number>;
  onSeek: (s: number) => void;
}) {
  const clipIds = useMemo(() => [...new Set(edl.cuts.map((c) => c.clipId))], [edl.cuts]);
  const sprites = useSprites(runId, clipIds);
  const ranges = cutRanges(edl);
  const overlays = edlOverlays(edl);
  const endTitle = edlEndTitle(edl);
  const endCard = endCardRange(edl);
  return (
    <ol className="space-y-1.5">
      {edl.title && (
        <li className="flex items-center gap-3 rounded-lg border bg-panel-2 p-2">
          <span className="h-9 w-1 rounded-full bg-muted-foreground/40" />
          {titleImageUrl ? (
            <span
              role="img"
              aria-label="Title card art"
              className="h-9 w-16 shrink-0 rounded bg-track bg-cover bg-center"
              style={{ backgroundImage: `url(${titleImageUrl})` }}
            />
          ) : (
            <span className="grid h-9 w-16 shrink-0 place-items-center rounded bg-track text-[10px] text-muted-foreground">Title</span>
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm">{edl.title}</p>
            <p className="font-tc text-xs text-muted-foreground">
              title card · {TITLE_SECONDS.toFixed(2)}s{titleImageUrl && " · Argon art"}
            </p>
          </div>
          <TimeChip t={0} onSeek={onSeek} />
        </li>
      )}
      {music && (
        <li className="flex items-center gap-3 rounded-lg border bg-panel-2 p-2">
          <span className="h-9 w-1 rounded-full bg-clip-2/60" />
          <span className="grid h-9 w-16 shrink-0 place-items-center rounded bg-clip-2/15 text-clip-2">
            <Music className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm" title={music.prompt}>
              {music.prompt}
            </p>
            <p className="font-tc text-xs text-muted-foreground">
              music bed · whole cut{musicGain != null && ` · ${musicGain > 0 ? "+" : ""}${musicGain} dB`}
            </p>
          </div>
          <TimeChip t={0} onSeek={onSeek} />
        </li>
      )}
      {audio?.denoise && (
        <li className="flex items-center gap-3 rounded-lg border bg-panel-2 p-2">
          <span className="h-9 w-1 rounded-full bg-success/60" />
          <span className="grid h-9 w-16 shrink-0 place-items-center rounded bg-success/15 text-success">
            <AudioWaveform className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm">Background noise reduced</p>
            <p className="font-tc text-xs text-muted-foreground">speech · whole cut</p>
          </div>
          <TimeChip t={0} onSeek={onSeek} />
        </li>
      )}
      {overlays.length > 0 && (
        <li className="rounded-lg border bg-panel-2 p-2">
          <p className="mb-1.5 flex items-center gap-1.5 px-0.5 text-xs font-medium text-muted-foreground">
            <Tag className="size-3.5 text-clip-1" /> Labels <span className="font-tc">· {overlays.length}</span>
          </p>
          <ul className="space-y-1">
            {overlays.map((o, i) => (
              <li key={i} className="flex items-center gap-2 rounded-md px-1 py-0.5 text-clip-1">
                <PositionGlyph position={o.position} />
                <span className="min-w-0 flex-1 truncate text-sm text-foreground" title={`${o.text} · ${o.position}`}>
                  {o.text}
                </span>
                <span className="font-tc shrink-0 text-xs text-muted-foreground">{(o.end - o.start).toFixed(1)}s</span>
                <TimeChip t={o.start} onSeek={onSeek} />
              </li>
            ))}
          </ul>
        </li>
      )}
      {ranges.map(({ cut, start, end }) => {
        const n = sprites[cut.clipId] ?? 0;
        const color = `var(--clip-${Math.max(0, clipOrder.indexOf(cut.clipId)) % 4})`;
        return (
          <li key={cut.id} className="flex items-center gap-3 rounded-lg border bg-panel-2 p-2">
            <span className="h-9 w-1 shrink-0 rounded-full" style={{ background: color }} />
            {n > 0 ? (
              <div className="shrink-0 rounded bg-track" style={spriteFrameStyle(runId, cut.clipId, n, spriteFrame(cut.srcIn, n, clipDurations[cut.clipId]), 64, 36)} />
            ) : (
              <div className="h-9 w-16 shrink-0 rounded bg-track" />
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm" title={cut.reason || undefined}>
                {cut.id} · {cut.clipId}
              </p>
              <p className="font-tc text-xs text-muted-foreground">
                in {formatTime(cut.srcIn)} · {(end - start).toFixed(2)}s
              </p>
            </div>
            <TimeChip t={start} onSeek={onSeek} />
          </li>
        );
      })}
      {endTitle && endCard && (
        <li className="flex items-center gap-3 rounded-lg border bg-panel-2 p-2">
          <span className="h-9 w-1 rounded-full bg-muted-foreground/40" />
          {endImageUrl ? (
            <span role="img" aria-label="End card art" className="h-9 w-16 shrink-0 rounded bg-track bg-cover bg-center" style={{ backgroundImage: `url(${endImageUrl})` }} />
          ) : (
            <span className="grid h-9 w-16 shrink-0 place-items-center rounded bg-track text-[10px] text-muted-foreground">End</span>
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm">{endTitle}</p>
            <p className="font-tc text-xs text-muted-foreground">
              end card · {TITLE_SECONDS.toFixed(2)}s{endImageUrl && " · Argon art"}
            </p>
          </div>
          <TimeChip t={endCard.start} onSeek={onSeek} />
        </li>
      )}
    </ol>
  );
}

/** Example notes that map to things Argon can actually do: labels, a closing card, and the audio mix. */
const NOTE_EXAMPLES = ["Add labels explaining each clip", "End on a card: Built with Gemini 4 Argon", "Reduce background noise and bring the music up"];

function DirectorsNote({ runId, onAccepted }: { runId: string; onAccepted: (run: Run) => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const submit = async () => {
    const text = note.trim();
    if (!text || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/revise`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note: text }),
      });
      if (res.status === 202) {
        onAccepted((await res.json()) as Run);
        return;
      }
      if (res.status === 409) {
        setMsg("Argon is still busy with this cut. Try again when it finishes.");
      } else {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setMsg(body?.error ?? "Argon couldn’t take that note right now.");
      }
    } catch {
      setMsg("Couldn’t reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="shrink-0 border-t p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label htmlFor="directors-note" className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <MessageSquareText className="size-3.5 text-amber" />
        Tell Argon what to change
      </label>
      <textarea
        id="directors-note"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
        rows={2}
        maxLength={500}
        placeholder="e.g. Lose the thank-you at the end and land on the price."
        className="mt-1.5 w-full resize-none rounded-lg border bg-background px-3 py-2 text-sm leading-relaxed outline-none placeholder:text-faint focus:ring-2 focus:ring-ring/50"
      />
      <div className="mt-1.5 flex flex-wrap gap-1.5" aria-label="Example notes">
        {NOTE_EXAMPLES.map((ex) => (
          <button
            key={ex}
            type="button"
            disabled={busy}
            aria-pressed={note === ex}
            onClick={() => {
              setNote(ex);
              setMsg(null);
              document.getElementById("directors-note")?.focus();
            }}
            className={cn(
              "rounded-full border px-2.5 py-0.5 text-[11px] leading-5 transition-colors disabled:opacity-40",
              note === ex ? "border-amber/50 bg-amber/15 text-amber" : "text-muted-foreground hover:border-amber/40 hover:text-foreground",
            )}
          >
            {ex}
          </button>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <p role={msg ? "alert" : undefined} className={cn("min-w-0 flex-1 text-xs", msg ? "text-fail" : "text-faint")}>
          {msg ?? "Argon re-cuts from this version and checks the result again."}
        </p>
        <button
          type="submit"
          disabled={!note.trim() || busy}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:brightness-105 disabled:opacity-40"
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
          Revise
        </button>
      </div>
    </form>
  );
}

function Scrubber({ t, dur, fails, onSeek }: { t: number; dur: number; fails: CheckT[]; onSeek: (s: number) => void }) {
  const pct = dur > 0 ? Math.min(100, (t / dur) * 100) : 0;
  const at = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    onSeek(((e.clientX - r.left) / r.width) * dur);
  };
  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label="Playhead"
      aria-valuemin={0}
      aria-valuemax={Math.round(dur * 10) / 10}
      aria-valuenow={Math.round(t * 10) / 10}
      aria-valuetext={formatTime(t)}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        at(e);
      }}
      onPointerMove={(e) => e.buttons === 1 && at(e)}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          e.stopPropagation();
          onSeek(t + (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 1 : 1 / FPS));
        }
      }}
      className="group relative mx-1.5 h-6 min-w-16 flex-1 cursor-pointer touch-none"
    >
      <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-accent" />
      <div className="absolute top-1/2 left-0 h-1 -translate-y-1/2 rounded-full bg-amber" style={{ width: `${pct}%` }} />
      {dur > 0 &&
        fails.map(
          (f, i) =>
            f.at != null && (
              <span key={i} title={f.name} className="absolute top-1/2 h-3 w-0.5 -translate-y-1/2 rounded bg-fail" style={{ left: `${Math.min(100, (f.at / dur) * 100)}%` }} />
            ),
        )}
      <span className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-amber ring-2 ring-background" style={{ left: `${pct}%` }} />
    </div>
  );
}
