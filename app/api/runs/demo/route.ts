import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

import { DEFAULT_DEMO_BRIEF, DEMO_BRIEF_ENV, DEMO_BRIEF_FILE, DEMO_DIR, isVideoName, runDir, safeName } from "@/lib/config";
import { startRun } from "@/lib/jobs";
import { saveRun } from "@/lib/store";
import type { Run, SourceClip } from "@/lib/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The demo brief: DEMO_BRIEF in the environment, else DEMO_DIR/brief.txt, else the built-in default. */
async function demoBrief(): Promise<string> {
  if (DEMO_BRIEF_ENV) return DEMO_BRIEF_ENV;
  try {
    const text = (await readFile(path.join(DEMO_DIR, DEMO_BRIEF_FILE), "utf8")).trim();
    if (text) return text;
  } catch {
    // no brief.txt next to the clips
  }
  return DEFAULT_DEMO_BRIEF;
}

async function demoClips(): Promise<{ name: string; size: number }[]> {
  let names: string[];
  try {
    names = (await readdir(DEMO_DIR)).filter(isVideoName).sort();
  } catch {
    return [];
  }
  const clips: { name: string; size: number }[] = [];
  for (const name of names) {
    try {
      const info = await stat(path.join(DEMO_DIR, name));
      if (info.isFile()) clips.push({ name, size: info.size });
    } catch {
      // skip anything that vanished between readdir and stat
    }
  }
  return clips;
}

/** What the demo would cut: the brief and the clips found in DEMO_DIR. */
export async function GET() {
  const [brief, clips] = await Promise.all([demoBrief(), demoClips()]);
  return NextResponse.json({ brief, clips, dir: path.basename(DEMO_DIR) });
}

/** Start a run from the bundled demo clips, exactly as an upload would. 201 Run, 404 when there are no clips. */
export async function POST() {
  const [brief, clips] = await Promise.all([demoBrief(), demoClips()]);
  if (clips.length === 0) {
    return NextResponse.json({ error: `no demo clips found in ${DEMO_DIR}` }, { status: 404 });
  }

  const id = randomBytes(5).toString("hex");
  const dir = runDir(id);
  await mkdir(path.join(dir, "src"), { recursive: true });

  const sources: SourceClip[] = [];
  try {
    for (const [i, clip] of clips.entries()) {
      const clipId = `clip${i + 1}`;
      const rel = `src/${clipId}_${safeName(clip.name)}`;
      await copyFile(path.join(DEMO_DIR, clip.name), path.join(dir, rel));
      sources.push({ id: clipId, path: rel, duration: 0, transcript: [] });
    }
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `could not copy demo clips: ${detail}` }, { status: 500 });
  }

  const run: Run = {
    id,
    brief,
    createdAt: new Date().toISOString(),
    clips: sources,
    iterations: [],
    status: "queued",
    error: "",
    warnings: [],
  };
  await saveRun(run);
  startRun(run);
  return NextResponse.json(run, { status: 201 });
}
