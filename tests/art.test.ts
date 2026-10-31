import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ART_MODEL, extractImage, generateTitleCard, titleCardPrompt } from "../lib/art";

const execFileAsync = promisify(execFile);

let tmp: string;
let pngBase64: string;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "art-test-"));
  // A real 320x180 PNG from ffmpeg, so the fit-to-frame step has real pixels to scale.
  const src = path.join(tmp, "src.png");
  await execFileAsync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=navy:s=320x180", "-frames:v", "1", src]);
  pngBase64 = readFileSync(src).toString("base64");
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function client(reply: (params: Record<string, unknown>) => Promise<unknown>) {
  const create = vi.fn(reply);
  return { ai: { interactions: { create } } as never, create };
}

async function probe(file: string): Promise<{ width: number; height: number; codec: string }> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,codec_name", "-of", "json", file,
  ]);
  const s = JSON.parse(stdout).streams[0];
  return { width: s.width, height: s.height, codec: s.codec_name };
}

describe("extractImage", () => {
  it("reads output_image first, then outputs[].content[] image blocks", () => {
    const viaOutput = extractImage({ output_image: { type: "image", data: "aGk=", mime_type: "image/jpeg" } });
    expect(viaOutput?.mimeType).toBe("image/jpeg");
    expect(viaOutput?.data.toString()).toBe("hi");
    const viaBlocks = extractImage({
      outputs: [{ content: [{ type: "text", text: "here" }, { type: "image", data: "aGk=" }] }],
    });
    expect(viaBlocks?.mimeType).toBe("image/png");
    expect(extractImage({ output_text: "no image" })).toBeNull();
    expect(extractImage({ output_image: { type: "image", uri: "https://x/y.png" } })).toBeNull();
  });
});

describe("generateTitleCard", () => {
  it("asks nano banana for a 16:9 image and writes a 1280x720 PNG", async () => {
    const { ai, create } = client(async () => ({ output_image: { type: "image", data: pngBase64, mime_type: "image/png" } }));
    const out = path.join(tmp, "run", "title.png");
    expect(await generateTitleCard("Launch Day", "a 30s recap", out, ai)).toBe(out);
    expect(existsSync(out)).toBe(true);
    expect(existsSync(`${out}.raw`)).toBe(false);
    expect(await probe(out)).toEqual({ width: 1280, height: 720, codec: "png" });

    const params = create.mock.calls[0][0] as Record<string, unknown>;
    expect(params.model).toBe(ART_MODEL);
    expect(params.store).toBe(false);
    expect(params.response_format).toMatchObject({ type: "image", aspect_ratio: "16:9" });
    expect(params.input).toBe(titleCardPrompt("Launch Day", "a 30s recap"));
    expect(String(params.input)).toMatch(/no text/i);
  });

  it("returns null when the model returns no image, errors out, or the title is empty", async () => {
    const out = path.join(tmp, "none.png");
    expect(await generateTitleCard("T", "", out, client(async () => ({ output_text: "sorry" })).ai)).toBeNull();
    const down = client(async () => { throw Object.assign(new Error("quota"), { status: 403 }); });
    expect(await generateTitleCard("T", "", out, down.ai)).toBeNull();
    const idle = client(async () => ({ output_image: { data: pngBase64 } }));
    expect(await generateTitleCard("  ", "", out, idle.ai)).toBeNull();
    expect(idle.create).not.toHaveBeenCalled();
    expect(existsSync(out)).toBe(false);
  });
});
