/**
 * ExcludeModels persistence tests — load, add, remove, clear, aliases.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadExcludeList,
  addExclusion,
  removeExclusion,
  clearExclusions,
} from "./exclude-models.js";

describe("ExcludeModels", () => {
  let tempDir: string;
  let filePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "exclude-models-test-"));
    filePath = join(tempDir, "exclude-models.json");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns empty set when file does not exist", () => {
    const set = loadExcludeList(filePath);
    expect(set.size).toBe(0);
  });

  it("add persists to disk and load returns it", () => {
    const resolved = addExclusion("openai/gpt-4o", filePath);
    expect(resolved).toBe("openai/gpt-4o");

    const set = loadExcludeList(filePath);
    expect(set.has("openai/gpt-4o")).toBe(true);
    expect(set.size).toBe(1);
  });

  it("add multiple models", () => {
    addExclusion("openai/gpt-4o", filePath);
    addExclusion("anthropic/claude-sonnet-4.6", filePath);

    const set = loadExcludeList(filePath);
    expect(set.size).toBe(2);
    expect(set.has("openai/gpt-4o")).toBe(true);
    expect(set.has("anthropic/claude-sonnet-4.6")).toBe(true);
  });

  it("remove returns true when model was present", () => {
    addExclusion("openai/gpt-4o", filePath);
    const removed = removeExclusion("openai/gpt-4o", filePath);
    expect(removed).toBe(true);

    const set = loadExcludeList(filePath);
    expect(set.size).toBe(0);
  });

  it("remove returns false when model was not present", () => {
    const removed = removeExclusion("openai/gpt-4o", filePath);
    expect(removed).toBe(false);
  });

  it("clear empties the list", () => {
    addExclusion("openai/gpt-4o", filePath);
    addExclusion("anthropic/claude-sonnet-4.6", filePath);
    clearExclusions(filePath);

    const set = loadExcludeList(filePath);
    expect(set.size).toBe(0);
  });

  it("deduplication — adding same model twice results in one entry", () => {
    addExclusion("openai/gpt-4o", filePath);
    addExclusion("openai/gpt-4o", filePath);

    const set = loadExcludeList(filePath);
    expect(set.size).toBe(1);
  });

  it("resolves aliases — 'nvidia' becomes 'free/gpt-oss-120b'", () => {
    const resolved = addExclusion("nvidia", filePath);
    expect(resolved).toBe("free/gpt-oss-120b");

    const set = loadExcludeList(filePath);
    expect(set.has("free/gpt-oss-120b")).toBe(true);
    expect(set.size).toBe(1);
  });

  it("resolves aliases — 'claude' becomes 'anthropic/claude-sonnet-4.6'", () => {
    const resolved = addExclusion("claude", filePath);
    expect(resolved).toBe("anthropic/claude-sonnet-4.6");

    const set = loadExcludeList(filePath);
    expect(set.has("anthropic/claude-sonnet-4.6")).toBe(true);
  });

  it("remove resolves aliases too", () => {
    addExclusion("nvidia", filePath); // "nvidia" alias → "free/gpt-oss-120b"
    const removed = removeExclusion("gpt-120b", filePath); // different alias for same model
    expect(removed).toBe(true);

    const set = loadExcludeList(filePath);
    expect(set.size).toBe(0);
  });

  it("file contains sorted JSON array", () => {
    addExclusion("openai/gpt-4o", filePath);
    addExclusion("anthropic/claude-sonnet-4.6", filePath);

    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(raw).toEqual(["anthropic/claude-sonnet-4.6", "openai/gpt-4o"]);
  });

  it("creates parent directories if they do not exist", () => {
    const nestedPath = join(tempDir, "a", "b", "c", "exclude-models.json");
    addExclusion("openai/gpt-4o", nestedPath);

    const set = loadExcludeList(nestedPath);
    expect(set.has("openai/gpt-4o")).toBe(true);
  });
});
