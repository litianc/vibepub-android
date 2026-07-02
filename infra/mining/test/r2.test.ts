import { describe, expect, it } from "vitest";
import { isSupportedInboxAudioKey } from "../src/r2.js";

describe("R2 inbox audio filter", () => {
  it("accepts Android-importable audio formats from the inbox", () => {
    expect(isSupportedInboxAudioKey("inbox/voice.m4a")).toBe(true);
    expect(isSupportedInboxAudioKey("inbox/voice.mp3")).toBe(true);
    expect(isSupportedInboxAudioKey("inbox/voice.mp4")).toBe(true);
    expect(isSupportedInboxAudioKey("inbox/voice.wav")).toBe(true);
  });

  it("rejects non-inbox or unsupported files", () => {
    expect(isSupportedInboxAudioKey("transcripts/voice.json")).toBe(false);
    expect(isSupportedInboxAudioKey("inbox/voice.flac")).toBe(false);
    expect(isSupportedInboxAudioKey("inbox/voice.txt")).toBe(false);
  });
});
