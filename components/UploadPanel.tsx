"use client";

import { ArrowRight, GripVertical, ImageIcon, Loader2, Upload, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

const VIDEO_EXT = /\.(mp4|mov|webm|mkv|m4v)$/i;
const IMAGE_EXT = /\.(jpe?g|png|webp|heic|heif)$/i;
const PRESETS = [
  { label: "30s recap", brief: "30s recap with captions. Open on the strongest moment, end on a clear beat." },
  { label: "15s teaser", brief: "15s teaser, punchy cuts, no dead air, title card up front." },
  { label: "60s highlights", brief: "60s highlight reel in chronological order, captions on, end on applause." },
];

type Clip = { key: string; file: File; url: string; kind: "video" | "photo"; duration?: number };

const isVideo = (f: File) => f.type.startsWith("video/") || VIDEO_EXT.test(f.name);
const isPhoto = (f: File) => f.type.startsWith("image/") || IMAGE_EXT.test(f.name);

function fmtSize(b: number) {
  return b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`;
}

function fmtDur(s: number | undefined) {
  if (s === undefined) return "–:––";
  if (!Number.isFinite(s)) return "?:??";
  return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
}

/** POST with upload progress; fetch cannot report request-body progress. */
function postWithProgress(form: FormData, onProgress: (p: number) => void): Promise<{ id: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/runs");
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      const body = (xhr.response ?? {}) as { id?: string; error?: string };
      if (xhr.status >= 200 && xhr.status < 300 && body.id) resolve({ id: body.id });
      else reject(new Error(body.error ? `Upload rejected: ${body.error}.` : `Upload failed (${xhr.status}). Try again.`));
    };
    xhr.onerror = () => reject(new Error("Upload failed. Check your connection and try again."));
    xhr.send(form);
  });
}

function ClipThumb({ clip, onDuration }: { clip: Clip; onDuration: (d: number) => void }) {
  const [broken, setBroken] = useState(false);
  if (clip.kind === "photo") {
    return broken ? (
      <span className="grid h-9 w-16 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
        <ImageIcon className="size-4" />
      </span>
    ) : (
      // eslint-disable-next-line @next/next/no-img-element -- local object URL, not an optimisable asset
      <img src={clip.url} alt="" className="h-9 w-16 shrink-0 rounded-md bg-muted object-cover" onError={() => setBroken(true)} />
    );
  }
  return (
    // #t=0.1 asks the browser to paint an early frame as a poster.
    <video
      src={`${clip.url}#t=0.1`}
      muted
      playsInline
      preload="metadata"
      className="h-9 w-16 shrink-0 rounded-md bg-muted object-cover"
      onLoadedMetadata={(e) => onDuration(e.currentTarget.duration)}
      onError={() => onDuration(NaN)}
    />
  );
}

/** The "New cut" card: drop footage, write a brief, cut it. Uploads to POST /api/runs and opens the run. */
export function UploadPanel() {
  const router = useRouter();
  const [clips, setClips] = useState<Clip[]>([]);
  const [brief, setBrief] = useState("");
  const [over, setOver] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const dragDepth = useRef(0);
  const clipsRef = useRef(clips);
  useEffect(() => {
    clipsRef.current = clips;
  }, [clips]);
  useEffect(() => () => clipsRef.current.forEach((c) => URL.revokeObjectURL(c.url)), []);

  const busy = progress !== null;
  const canSubmit = !busy && clips.length > 0 && brief.trim().length > 0;
  const pct = Math.round((progress ?? 0) * 100);

  const add = (list: FileList | null) => {
    if (!list) return;
    const all = Array.from(list);
    const ok = all.filter((f) => isVideo(f) || isPhoto(f));
    const skipped = all.length - ok.length;
    setError(skipped > 0 ? `Skipped ${skipped} file${skipped > 1 ? "s" : ""} that ${skipped > 1 ? "aren't" : "isn't"} video or photo.` : null);
    setClips((cur) => [
      ...cur,
      ...ok.map((file) => ({
        key: `${file.name}-${file.size}-${Math.random()}`,
        file,
        url: URL.createObjectURL(file),
        kind: isVideo(file) ? ("video" as const) : ("photo" as const),
      })),
    ]);
  };

  const remove = (key: string) =>
    setClips((cur) => {
      const c = cur.find((x) => x.key === key);
      if (c) URL.revokeObjectURL(c.url);
      return cur.filter((x) => x.key !== key);
    });

  const setDuration = (key: string, d: number) =>
    setClips((cur) => cur.map((x) => (x.key === key ? { ...x, duration: d } : x)));

  const moveOnto = (target: string) => {
    if (!dragKey || dragKey === target) return;
    setClips((cur) => {
      const from = cur.findIndex((c) => c.key === dragKey);
      const to = cur.findIndex((c) => c.key === target);
      if (from < 0 || to < 0) return cur;
      const next = [...cur];
      next.splice(to, 0, ...next.splice(from, 1));
      return next;
    });
  };

  const submit = async () => {
    if (!canSubmit) {
      if (!busy) setError(clips.length === 0 ? "Add at least one clip first." : "Write a short brief first.");
      return;
    }
    setError(null);
    setProgress(0);
    const form = new FormData();
    form.append("brief", brief.trim());
    for (const c of clips) form.append("files", c.file, c.file.name);
    try {
      const { id } = await postWithProgress(form, setProgress);
      clips.forEach((c) => URL.revokeObjectURL(c.url));
      setClips([]);
      setBrief("");
      router.push(`/runs/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed. Try again.");
      setProgress(null);
    }
  };

  const isFileDrag = (e: React.DragEvent) => e.dataTransfer.types.includes("Files");

  return (
    <section id="new" aria-label="New cut" className="scroll-mt-8 rounded-2xl border bg-card p-5 shadow-tile lg:col-span-2">
      <div className="flex items-center justify-between">
        <h2 className="font-medium">New cut</h2>
        <span className="text-xs text-muted-foreground">
          {clips.length === 0 ? "No clips yet" : `${clips.length} clip${clips.length === 1 ? "" : "s"}`}
        </span>
      </div>

      <label
        htmlFor="footage-input"
        className={cn(
          "mt-4 flex w-full cursor-pointer flex-col items-center gap-1 rounded-xl border-2 border-dashed px-4 py-5 text-sm transition-colors focus-within:border-amber focus-within:bg-accent/60",
          over ? "border-amber bg-accent" : "border-border hover:bg-muted/60",
          busy && "pointer-events-none opacity-60",
        )}
        onDragEnter={(e) => {
          if (!isFileDrag(e)) return;
          e.preventDefault();
          dragDepth.current += 1;
          setOver(true);
        }}
        onDragOver={(e) => isFileDrag(e) && e.preventDefault()}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setOver(false);
        }}
        onDrop={(e) => {
          if (!isFileDrag(e)) return;
          e.preventDefault();
          dragDepth.current = 0;
          setOver(false);
          add(e.dataTransfer.files);
        }}
      >
        <input
          id="footage-input"
          type="file"
          accept="video/*,image/*"
          multiple
          disabled={busy}
          className="sr-only"
          onChange={(e) => {
            add(e.target.files);
            e.target.value = "";
          }}
        />
        <Upload className="size-5 text-muted-foreground" aria-hidden />
        <span className="font-medium">{over ? "Release to add" : clips.length ? "Add more footage" : "Drop footage here"}</span>
        <span className="text-xs text-muted-foreground">Video or photos, up to 2 GB. Click to browse.</span>
      </label>

      {clips.length > 0 && (
        <ul className="mt-3 max-h-[min(260px,34vh)] space-y-1.5 overflow-y-auto" aria-label="Clips, drag to reorder">
          {clips.map((c) => (
            <li
              key={c.key}
              draggable={!busy && clips.length > 1}
              onDragStart={(e) => {
                setDragKey(c.key);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragEnter={() => moveOnto(c.key)}
              onDragOver={(e) => dragKey && e.preventDefault()}
              onDragEnd={() => setDragKey(null)}
              className={cn(
                "flex items-center gap-3 rounded-lg border bg-background p-1.5 pr-2 text-sm transition-shadow",
                dragKey === c.key && "shadow-lift opacity-70",
              )}
            >
              <GripVertical
                className={cn("size-4 shrink-0 text-muted-foreground", clips.length > 1 ? "cursor-grab" : "opacity-40")}
                aria-hidden
              />
              <ClipThumb clip={c} onDuration={(d) => setDuration(c.key, d)} />
              <span className="min-w-0 flex-1 truncate">{c.file.name}</span>
              <span className="font-tc text-xs text-muted-foreground">{c.kind === "photo" ? "photo" : fmtDur(c.duration)}</span>
              <span className="w-14 text-right text-xs text-muted-foreground">{fmtSize(c.file.size)}</span>
              <button
                type="button"
                aria-label={`Remove ${c.file.name}`}
                disabled={busy}
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => remove(c.key)}
              >
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <label className="mt-4 block text-sm font-medium" htmlFor="brief">
        Brief
      </label>
      <textarea
        id="brief"
        value={brief}
        maxLength={2000}
        rows={3}
        disabled={busy}
        onChange={(e) => setBrief(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
        placeholder="Cut a 30-second launch teaser. Open on the welcome, remove filler words, end on the price. Add captions."
        className="mt-1.5 w-full resize-none rounded-xl border bg-background px-3 py-2.5 text-sm leading-relaxed outline-none placeholder:text-muted-foreground/80 focus:ring-2 focus:ring-ring/50 disabled:opacity-60"
      />
      <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Brief presets">
        {PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            title={p.brief}
            aria-pressed={brief === p.brief}
            disabled={busy}
            onClick={() => setBrief(p.brief)}
            className="rounded-full border px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted aria-pressed:border-amber aria-pressed:bg-accent aria-pressed:font-medium aria-pressed:text-accent-foreground"
          >
            {p.label}
          </button>
        ))}
      </div>

      {error && (
        <p role="alert" className="mt-3 text-xs text-fail">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={submit}
        disabled={!canSubmit}
        aria-busy={busy || undefined}
        className={cn(
          "relative mt-5 flex h-11 w-full items-center justify-center gap-2 overflow-hidden rounded-xl bg-primary font-medium text-primary-foreground shadow-tile transition-all hover:brightness-105 disabled:cursor-default disabled:hover:brightness-100",
          !busy && !canSubmit && "opacity-40",
        )}
      >
        {busy && (
          <span className="absolute inset-y-0 left-0 bg-foreground/10 transition-[width] duration-200" style={{ width: `${pct}%` }} aria-hidden />
        )}
        <span className="relative flex items-center gap-2">
          {busy ? (
            <>
              <Loader2 className="size-4 animate-spin" /> {pct >= 100 ? "Starting the cut" : `Uploading ${pct}%`}
            </>
          ) : (
            <>
              Cut it <ArrowRight className="size-4" />
            </>
          )}
        </span>
      </button>
      {busy && (
        <span className="sr-only" role="status">
          Uploading {pct} percent
        </span>
      )}
    </section>
  );
}
