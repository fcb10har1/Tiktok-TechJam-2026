import { describe, expect, it } from "vitest";
import {
  mergeProtectedPaths,
  normalizeProtectedPaths,
  normalizeWritablePaths,
} from "./protected-paths.js";

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

  it("preserves explicit directory scopes and rejects unsupported globs", () => {
    expect(
      normalizeWritablePaths([
        "src/**",
        "src/components/App.tsx",
        "tests/",
        "tests/",
        "package.json",
      ]),
    ).toEqual(["src/**", "tests/**", "package.json"]);
    expect(() => normalizeWritablePaths(["src/*.ts"])).toThrow(
      "only a terminal /** is allowed",
    );
    expect(() => normalizeWritablePaths(["src/../README.md"])).toThrow(
      "workspace-relative",
    );
  });

  it("preserves existing protections while bounding a large planner proposal", () => {
    const proposedPaths = Array.from(
      { length: 100 },
      (_, index) => "generated/path-" + index,
    );

    const merged = mergeProtectedPaths(
      [".env", "deployment", "package.json"],
      proposedPaths,
    );

    expect(merged).toHaveLength(100);
    expect(merged.slice(0, 3)).toEqual([".env", "deployment", "package.json"]);
    expect(merged).not.toContain("generated/path-97");
  });
});
