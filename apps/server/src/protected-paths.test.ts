import { describe, expect, it } from "vitest";
import { normalizeProtectedPaths } from "./protected-paths.js";

describe("normalizeProtectedPaths", () => {
  it("canonicalizes trailing slashes and deduplicates protected paths", () => {
    expect(
      normalizeProtectedPaths([
        "deployment/",
        "deployment",
        "deployment//",
        ".env",
        ".env",
      ]),
    ).toEqual(["deployment", ".env"]);
  });

  it("removes descendants when a protected parent is present regardless of order", () => {
    expect(
      normalizeProtectedPaths([
        "deployment/config.yml",
        "src/generated/output.ts",
        "deployment",
        "src",
        "package.json",
      ]),
    ).toEqual(["deployment", "src", "package.json"]);
  });

  it("does not treat paths with a shared string prefix as descendants", () => {
    expect(
      normalizeProtectedPaths(["deploy", "deployment/config.yml"]),
    ).toEqual(["deploy", "deployment/config.yml"]);
  });
});
