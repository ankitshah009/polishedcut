import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { NextResponse } from "next/server";

import {
  BRIEF_MAX_CHARS,
  MAX_CLIP_SECONDS,
  MAX_TOTAL_SECONDS,
  MAX_UPLOAD_BYTES,
  PHOTO_SECONDS,
  isVideoName,
  runDir,
  safeName,
} from "@/lib/config";
import { IMAGE_EXT, imageToClip, isImageFile } from "@/lib/images";
import { startRun } from "@/lib/jobs";
import { chooseOutput, probeMedia, type MediaInfo } from "@/lib/media";
import { listRuns, saveRun } from "@/lib/store";
import type { Run, SourceClip } from "@/lib/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isVideo(file: File): boolean {
  return file.type.startsWith("video/") || isVideoName(file.name);
}

function isPhoto(file: File): boolean {
  return !isVideo(file) && isImageFile(file.name, file.type);
}

function tooLarge(bytes: number) {
  const mb = Math.round(MAX_UPLOAD_BYTES / 1e6);
  return NextResponse.json(
    { error: `upload is ${Math.round(bytes / 1e6)} MB; the limit is ${mb} MB (MAX_UPLOAD_BYTES)` },
    { status: 413 },
  );
}

async function saveUpload(file: File, dst: string): Promise<void> {
  await pipeline(Readable.fromWeb(file.stream() as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(dst));
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

class UploadRejected extends Error {
  constructor(message: string, readonly status: number = 400) {
    super(message);
  }
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

export async function GET() {
  return NextResponse.json(await listRuns());
}

/**
 * POST multipart/form-data { brief, files[] } -> 201 Run (status "queued", loop already started).
 * 400 bad form / brief / file type / unreadable video / clip over MAX_CLIP_SECONDS / footage over
 * MAX_TOTAL_SECONDS, 413 over MAX_UPLOAD_BYTES, 500 when a clip could not be written.
 * Any container, codec, frame rate, bit depth or orientation ffmpeg can decode is accepted; the
 * delivery size follows the footage and the brief (chooseOutput), and photos become clips at that size.
 */
export async function POST(request: Request) {
  // Reject before buffering the body when the browser already tells us it is too big.
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) return tooLarge(declared);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "expected multipart form data" }, { status: 400 });
  }

  const brief = String(form.get("brief") ?? "").trim();
  if (!brief) return NextResponse.json({ error: "brief is required" }, { status: 400 });
  if (brief.length > BRIEF_MAX_CHARS) {
    return NextResponse.json({ error: `brief must be at most ${BRIEF_MAX_CHARS} characters` }, { status: 400 });
  }

  const files = form.getAll("files").filter((v): v is File => v instanceof File);
  if (files.length === 0) return NextResponse.json({ error: "at least one video or photo is required" }, { status: 400 });
  const bad = files.find((f) => !isVideo(f) && !isPhoto(f));
  if (bad) return NextResponse.json({ error: `${bad.name} is not a video or photo` }, { status: 400 });
  const total = files.reduce((sum, f) => sum + f.size, 0);
  if (total > MAX_UPLOAD_BYTES) return tooLarge(total);

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
    const output = chooseOutput(saved.flatMap((s) => (s.info ? [{ ...s.info, duration: s.video ? s.info.duration : PHOTO_SECONDS }] : [])), brief);

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
    if (err instanceof UploadRejected) return NextResponse.json({ error: err.message }, { status: err.status });
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `could not save upload: ${detail}` }, { status: 500 });
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
  };
  await saveRun(run);
  startRun(run);
  return NextResponse.json(run, { status: 201 });
}
