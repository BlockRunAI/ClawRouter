import { describe, expect, it } from "vitest";

import { MAX_COMMAND_OUTPUT_BYTES, runCommand } from "../electron/core/process.js";

describe("desktop command runner", () => {
  it("bounds stdout and retains the newest diagnostic tail", async () => {
    const result = await runCommand(
      process.execPath,
      ["-e", 'process.stdout.write("a".repeat(1_200_000) + "TAIL")'],
      { timeoutMs: 10_000 },
    );

    expect(result.code).toBe(0);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(MAX_COMMAND_OUTPUT_BYTES);
    expect(result.stdout).toContain("[earlier command output truncated]");
    expect(result.stdout.endsWith("TAIL")).toBe(true);
  });

  it("bounds stderr independently from stdout", async () => {
    const result = await runCommand(
      process.execPath,
      ["-e", 'process.stderr.write("e".repeat(1_200_000) + "ERRTAIL")'],
      { timeoutMs: 10_000 },
    );

    expect(result.code).toBe(0);
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(MAX_COMMAND_OUTPUT_BYTES);
    expect(result.stderr.endsWith("ERRTAIL")).toBe(true);
  });
});
