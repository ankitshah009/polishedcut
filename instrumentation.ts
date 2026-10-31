/**
 * Next.js instrumentation hook: runs once per server start, before requests are served.
 * Any cut the previous process left in progress is resumed here, so a restart mid-cut
 * is never a dead end for the person waiting on it.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // A half-configured Nebula Frame Analyst (FRAME_ANALYSIS=nebula without URL, secret or an https PUBLIC_URL)
  // fails the boot here, with the reason, instead of failing the first run that asks for an analysis.
  // `register` must finish before the server takes requests, so throwing stops the start.
  const { validateFrameAnalystConfig } = await import("./lib/config");
  try {
    validateFrameAnalystConfig();
  } catch (err) {
    console.error(`[frame-analyst] ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
  // Imported here so the edge bundle never pulls in ffmpeg, fs or the Gemini SDK.
  const { resumeInterruptedRuns } = await import("./lib/jobs");
  try {
    await resumeInterruptedRuns();
  } catch (err) {
    console.error("[argon] could not resume interrupted runs:", err);
  }
  // Chat front door (Photon Beta). Only when PHOTON_PROJECT_ID/PHOTON_API_KEY are set; see docs/PHOTON.md.
  const { photonEnabled, startPhotonStream } = await import("./lib/photon");
  if (photonEnabled()) {
    try {
      await startPhotonStream();
    } catch (err) {
      console.error("[photon] could not start:", err);
    }
  }
}
