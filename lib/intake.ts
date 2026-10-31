import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  BRIEF_MAX_CHARS,
  MAX_CLIP_SECONDS,
  MAX_TOTAL_SECONDS,
  MAX_UPLOAD_BYTES,
  PHOTO_SECONDS,
  isVideoName,
  runDir,
  safeName,
} from "./config";
import { IMAGE_EXT, imageToClip, isImageFile } from "./images";
import { startRun } from "./jobs";
import { chooseOutput, probeMedia, type MediaInfo } from "./media";
import { saveRun } from "./store";
import type { Run, SourceClip } from "./schema";

/**
 * One front door for every way footage reaches the editor: the browser upload (POST /api/runs) and
 * the chat adapter (lib/photon-handler.ts) both call `createRun`, so a clip texted over iMessage
 * is validated, probed, registered and cut exactly like one dropped on the dashboard.
 */

export class UploadRejected extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
    this.name = "UploadRejected";
  }
}

export function isVideo(file: File): boolean {
  return file.type.startsWith("video/") || isVideoName(file.name);
}

export function isPhoto(file: File): boolean {
  return !isVideo(file) && isImageFile(file.name, file.type);
}

/** "12:34" / "1:02:03" for error messages about clip lengths. */
export function clock(seconds: number): string {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

function tooLarge(bytes: number): UploadRejected {
  const mb = Math.round(MAX_UPLOAD_BYTES / 1e6);
  return new UploadRejected(`upload is ${Math.round(bytes / 1e6)} MB; the limit is ${mb} MB (MAX_UPLOAD_BYTES)`, 413);
}

async function saveUpload(file: File, dst: string): Promise<void> {
  await pipeline(Readable.fromWeb(file.stream() as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(dst));
}

/**
 * ffprobe a saved upload. A video must decode and respect MAX_CLIP_SECONDS; a photo only needs a
 * frame size (HEIC an ffmpeg without HEIF support cannot read is still accepted: imageToClip has a
 * macOS fallback for it, and the output size then comes from the other files or the brief).
 */
async function inspect(file: File, saved: string, video: boolean): Promise<MediaInfo | null> {
  let info: MediaInfo;
  try {
    info = await probeMedia(saved);
  } catch (err) {
    if (!video) return null;
    const detail = err instanceof Error ? err.message.split("\n").slice(-1)[0] : String(err);
    throw new UploadRejected(`${file.name} is not a video ffmpeg can read: ${detail}`);
  }
  if (video) {
    if (!info.width || !info.height) throw new UploadRejected(`${file.name} has no video stream`);
    if (!(info.duration > 0)) throw new UploadRejected(`${file.name} has no duration; is it a complete file?`);
    if (info.duration > MAX_CLIP_SECONDS) {
      throw new UploadRejected(
        `${file.name} is ${clock(info.duration)} long; the limit per clip is ${clock(MAX_CLIP_SECONDS)} (MAX_CLIP_SECONDS)`,
      );
    }
  }
  return info;
}

/** Brief and file-list checks that need no disk: the same 400s the HTTP route used to return. */
export function validateIntake(brief: string, files: File[]): void {
  if (!brief) throw new UploadRejected("brief is required");
  if (brief.length > BRIEF_MAX_CHARS) throw new UploadRejected(`brief must be at most ${BRIEF_MAX_CHARS} characters`);
  if (files.length === 0) throw new UploadRejected("at least one video or photo is required");
  const bad = files.find((f) => !isVideo(f) && !isPhoto(f));
  if (bad) throw new UploadRejected(`${bad.name} is not a video or photo`);
  const total = files.reduce((sum, f) => sum + f.size, 0);
  if (total > MAX_UPLOAD_BYTES) throw tooLarge(total);
}

export interface CreateRunOptions {
  /** Where the footage came from, recorded on the run so the dashboard can show it (e.g. "imessage"). */
  source?: string;
  /** Who asked, as the platform identifies them; kept so a reply can find its way back. */
  requester?: string;
}

/**
 * Save `files` under a new run, probe them, turn photos into clips, persist the run and start the
 * edit loop. Resolves to the queued Run (status "queued", loop already running). Throws
 * UploadRejected (400/413) for anything the person can fix and a plain Error when a clip could not
 * be written; in both cases nothing half-written is left on disk.
 */
export async function createRun(brief: string, files: File[], opts: CreateRunOptions = {}): Promise<Run> {
  brief = brief.trim();
  validateIntake(brief, files);

  const id = randomBytes(5).toString("hex");
  const dir = runDir(id);
  await mkdir(path.join(dir, "src"), { recursive: true });

  const clips: SourceClip[] = [];
  try {
    // 1. Save everything and probe it, so the limits and the output size are known before any
    //    photo is rendered into a clip.
    type Saved = { clipId: string; file: File; video: boolean; rel: string; info: MediaInfo | null };
    const saved: Saved[] = [];
    for (const [i, file] of files.entries()) {
      const clipId = `clip${i + 1}`;
      const video = isVideo(file);
      const rel = `src/${clipId}_${safeName(file.name, video ? "clip.mp4" : "photo.jpg")}`;
      await saveUpload(file, path.join(dir, rel));
      saved.push({ clipId, file, video, rel, info: await inspect(file, path.join(dir, rel), video) });
    }
    const total = saved.reduce((sum, s) => sum + (s.video ? s.info!.duration : PHOTO_SECONDS), 0);
    if (total > MAX_TOTAL_SECONDS) {
      throw new UploadRejected(
        `the footage is ${clock(total)} in total; the limit per run is ${clock(MAX_TOTAL_SECONDS)} (MAX_TOTAL_SECONDS)`,
      );
    }
    const output = chooseOutput(
      saved.flatMap((s) => (s.info ? [{ ...s.info, duration: s.video ? s.info.duration : PHOTO_SECONDS }] : [])),
      brief,
    );

    // 2. Register the clips; a photo keeps its original next to the short mp4 the pipeline can cut.
    for (const s of saved) {
      if (s.video) {
        clips.push({ id: s.clipId, path: s.rel, duration: s.info!.duration, transcript: [] });
        continue;
      }
      const rel = `${s.rel.replace(IMAGE_EXT, "")}.mp4`;
      try {
        await imageToClip(path.join(dir, s.rel), path.join(dir, rel), { size: output });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new UploadRejected(`could not turn photo ${s.file.name} into a clip: ${detail}`);
      }
      clips.push({ id: s.clipId, path: rel, duration: PHOTO_SECONDS, transcript: [] });
    }
  } catch (err) {
    // Rejected input, disk full, client went away mid-upload, ...: never leave a half-written run behind.
    await rm(dir, { recursive: true, force: true });
    if (err instanceof UploadRejected) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`could not save upload: ${detail}`);
  }

  const run: Run = {
    id,
    brief,
    createdAt: new Date().toISOString(),
    clips,
    iterations: [],
    status: "queued",
    error: "",
    warnings: [],
    ...(opts.source ? { source: opts.source } : {}),
    ...(opts.requester ? { requester: opts.requester } : {}),
  };
  await saveRun(run);
  startRun(run);
  return run;
}
