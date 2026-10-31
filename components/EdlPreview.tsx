"use client";

import { Player } from "@remotion/player";
import type { EDL } from "@/lib/schema";
import { EdlComposition, edlDurationFrames } from "./remotion/EdlComposition";

export function EdlPreview({ runId, edl }: { runId: string; edl: EDL }) {
  return (
    <Player
      component={EdlComposition}
      inputProps={{ runId, edl }}
      durationInFrames={edlDurationFrames(edl)}
      fps={edl.fps}
      compositionWidth={edl.width}
      compositionHeight={edl.height}
      controls
      style={{ width: "100%", aspectRatio: "16 / 9" }}
    />
  );
}

export default EdlPreview;
