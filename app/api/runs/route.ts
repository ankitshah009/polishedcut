import { NextResponse } from "next/server";

import { MAX_UPLOAD_BYTES } from "@/lib/config";
import { UploadRejected, clock, createRun } from "@/lib/intake";
import { listRuns } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Re-exported for callers that imported it from here before run creation moved to lib/intake.ts.
export { clock };

function tooLarge(bytes: number) {
  const mb = Math.round(MAX_UPLOAD_BYTES / 1e6);
  return NextResponse.json(
    { error: `upload is ${Math.round(bytes / 1e6)} MB; the limit is ${mb} MB (MAX_UPLOAD_BYTES)` },
    { status: 413 },
  );
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
 * The work itself is lib/intake.ts `createRun`, shared with the chat adapter (lib/photon-handler.ts).
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
  const files = form.getAll("files").filter((v): v is File => v instanceof File);

  try {
    const run = await createRun(brief, files, { source: "web" });
    return NextResponse.json(run, { status: 201 });
  } catch (err) {
    if (err instanceof UploadRejected) return NextResponse.json({ error: err.message }, { status: err.status });
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: detail }, { status: 500 });
  }
}
