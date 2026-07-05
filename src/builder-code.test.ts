import { describe, it, expect } from "vitest";
import { BLOCKRUN_SERVICE_CODE, withBuilderCodeServiceCode } from "./builder-code.js";

describe("withBuilderCodeServiceCode", () => {
  it("attaches the BlockRun service code to an empty payload", () => {
    const ext = withBuilderCodeServiceCode(undefined);
    expect((ext["builder-code"] as any).info.s).toEqual([BLOCKRUN_SERVICE_CODE]);
  });

  it("preserves the server-echoed app code (a) when adding s", () => {
    const ext = withBuilderCodeServiceCode({
      "builder-code": { info: { a: "blockrun" } },
    });
    const info = (ext["builder-code"] as any).info;
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
