"use client";

import { AbsoluteFill, OffthreadVideo, Sequence } from "remotion";
import type { EDL } from "@/lib/schema";
import { TITLE_SECONDS } from "@/lib/format";

export type EdlCompositionProps = { runId: string; edl: EDL };

export function edlDurationFrames(edl: EDL): number {
  const title = edl.title ? TITLE_SECONDS : 0;
  const cuts = edl.cuts.reduce((s, c) => s + Math.max(0, c.srcOut - c.srcIn), 0);
  return Math.max(1, Math.round((title + cuts) * edl.fps));
}

export function EdlComposition({ runId, edl }: EdlCompositionProps) {
  const fps = edl.fps;
  const titleFrames = edl.title ? Math.round(TITLE_SECONDS * fps) : 0;
  const placed = edl.cuts.reduce<{ from: number; startFrom: number; len: number; clipId: string; id: string }[]>(
    (acc, c) => {
      const prev = acc[acc.length - 1];
      const from = prev ? prev.from + prev.len : titleFrames;
      const startFrom = Math.round(c.srcIn * fps);
      const len = Math.max(1, Math.round(c.srcOut * fps) - startFrom);
      return [...acc, { from, startFrom, len, clipId: c.clipId, id: c.id }];
    },
    [],
  );
  const seqs = placed.map((p) => (
    <Sequence key={`${p.id}-${p.from}`} from={p.from} durationInFrames={p.len}>
      <OffthreadVideo
        src={`/api/runs/${runId}/files/proxies/${p.clipId}.mp4`}
        startFrom={p.startFrom}
        endAt={p.startFrom + p.len}
        style={{ width: "100%", height: "100%", objectFit: "contain" }}
      />
    </Sequence>
  ));

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      {edl.title ? (
        <Sequence durationInFrames={Math.round(TITLE_SECONDS * fps)}>
          <AbsoluteFill
            style={{
              justifyContent: "center",
              alignItems: "center",
              color: "white",
              fontFamily: "Georgia, 'Times New Roman', serif",
              fontSize: edl.height / 12,
              textAlign: "center",
              padding: "0 8%",
            }}
          >
            {edl.title}
          </AbsoluteFill>
        </Sequence>
      ) : null}
      {seqs}
      {edl.captions.map((cap, i) => {
        const from = Math.round(cap.start * fps);
        const len = Math.max(1, Math.round(cap.end * fps) - from);
        return (
          <Sequence key={`cap-${i}`} from={from} durationInFrames={len}>
            <AbsoluteFill
              style={{ justifyContent: "flex-end", alignItems: "center", paddingBottom: edl.height * 0.06 }}
            >
              <div
                style={{
                  background: "rgba(0,0,0,0.6)",
                  color: "white",
                  fontFamily: "system-ui, sans-serif",
                  fontSize: edl.height / 22,
                  padding: "0.2em 0.6em",
                  borderRadius: 6,
                  maxWidth: "85%",
                  textAlign: "center",
                }}
              >
                {cap.text}
              </div>
            </AbsoluteFill>
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
}
