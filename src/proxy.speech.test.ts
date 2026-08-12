import { describe, expect, it } from "vitest";

import {
  DEFAULT_SPEECH_MODEL,
  SPEECH_MODELS,
  normalizeSpeechRequest,
  parseSpeechResponse,
} from "./proxy.js";

describe("speech request normalization", () => {
  it("defaults the model and audio fields", () => {
    expect(normalizeSpeechRequest({ text: "Hello" })).toEqual({
      model: DEFAULT_SPEECH_MODEL,
      text: "Hello",
      stream: false,
      output_format: "hex",
      audio_setting: { format: "mp3" },
    });
  });

  it("accepts every supported speech model and request field", () => {
    for (const model of SPEECH_MODELS) {
      expect(
        normalizeSpeechRequest({
          model,
          text: "Hello",
          language_boost: "English",
          voice_setting: { voice_id: "female-shaonv" },
          pronunciation_dict: { tone: ["hello/(he lou)"] },
          audio_setting: { format: "wav", sample_rate: 32000 },
          voice_modify: { pitch: 1 },
          subtitle_enable: true,
        }).model,
      ).toBe(model);
    }
  });

  it("rejects missing text, unknown models, and unsupported audio formats", () => {
    expect(() => normalizeSpeechRequest({ model: DEFAULT_SPEECH_MODEL })).toThrow("requires text");
    expect(() => normalizeSpeechRequest({ model: "unknown", text: "Hello" })).toThrow(
      "Unsupported speech model",
    );
    expect(() =>
      normalizeSpeechRequest({ text: "Hello", audio_setting: { format: "ogg" } }),
    ).toThrow("Unsupported speech audio format");
  });
});

describe("speech response parsing", () => {
  it("decodes hex audio and returns response metadata", () => {
    expect(
      parseSpeechResponse({
        data: { audio: "48656c6c6f", status: 2 },
        base_resp: { status_code: 0 },
        extra_info: { audio_format: "wav" },
      }),
    ).toEqual({ audio: Buffer.from("Hello"), format: "wav", status: 2 });
  });

  it("decodes base64 audio and rejects failed or empty responses", () => {
    expect(parseSpeechResponse({ data: { audio: "SGVsbG8=" } }).audio).toEqual(
      Buffer.from("Hello"),
    );
    expect(() =>
      parseSpeechResponse({ base_resp: { status_code: 1001, status_msg: "Invalid request" } }),
    ).toThrow("Invalid request");
    expect(() => parseSpeechResponse({ data: {} })).toThrow("did not contain audio");
  });
});
