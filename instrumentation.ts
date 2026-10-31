/**
 * Next.js instrumentation hook: runs once per server start, before requests are served.
 * Any cut the previous process left in progress is resumed here, so a restart mid-cut
 * is never a dead end for the person waiting on it.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Imported here so the edge bundle never pulls in ffmpeg, fs or the Gemini SDK.
  const { resumeInterruptedRuns } = await import("./lib/jobs");
  try {
    await resumeInterruptedRuns();
  } catch (err) {
    console.error("[argon] could not resume interrupted runs:", err);
  }
}
