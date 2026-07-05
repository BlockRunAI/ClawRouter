import { describe, it, expect } from "vitest";
import { BLOCKRUN_SERVICE_CODE, withBuilderCodeServiceCode } from "./builder-code.js";

/** Minimal shape of the `builder-code` extension the tests inspect. */
type BuilderCodeExtension = { info: { a?: string; s?: string[] } };

describe("withBuilderCodeServiceCode", () => {
  it("attaches the BlockRun service code to an empty payload", () => {
    const ext = withBuilderCodeServiceCode(undefined);
    expect((ext["builder-code"] as BuilderCodeExtension).info.s).toEqual([BLOCKRUN_SERVICE_CODE]);
  });

  it("preserves the server-echoed app code (a) when adding s", () => {
    const ext = withBuilderCodeServiceCode({
      "builder-code": { info: { a: "blockrun" } },
    });
    const info = (ext["builder-code"] as BuilderCodeExtension).info;
    expect(info.a).toBe("blockrun");
    expect(info.s).toEqual([BLOCKRUN_SERVICE_CODE]);
  });

  it("preserves unrelated extensions", () => {
    const ext = withBuilderCodeServiceCode({ "some-ext": { foo: 1 } });
    expect(ext["some-ext"]).toEqual({ foo: 1 });
  });

  it("does not mutate the input object", () => {
    const input = {};
    withBuilderCodeServiceCode(input);
    expect(input).toEqual({});
  });
});

describe("onAfterPaymentCreation stamping (proxy hook contract)", () => {
  // The proxy hook reassigns `paymentPayload.extensions` in place. This guards
  // the reference-mutation assumption: the same payload object the x402 client
  // later serializes into the X-PAYMENT header must carry the stamp.
  it("stamps s onto a payload the hook mutates by reference", () => {
    const payload: { extensions?: Record<string, unknown> } = {};
    payload.extensions = withBuilderCodeServiceCode(payload.extensions);
    expect((payload.extensions["builder-code"] as BuilderCodeExtension).info.s).toEqual([
      BLOCKRUN_SERVICE_CODE,
    ]);
  });
});
