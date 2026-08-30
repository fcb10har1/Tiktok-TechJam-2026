import { describe, expect, it } from "vitest";
import {
  displayableTechnicalCommandEvents,
  hasTestFileIntegrityWarning,
  testCommandStatus,
} from "../../web/src/observability.js";
import type { RunEvent } from "../../web/src/types.js";

function runEvent(
  kind: RunEvent["kind"],
  options: {
    outcome?: RunEvent["outcome"];
    path?: string;
    source?: RunEvent["technical"]["source"];
    command?: string;
    exitCode?: number;
  } = {},
): RunEvent {
  return {
    id: kind + "-event",
    sequence: 1,
    timestamp: "2026-08-30T00:00:00.000Z",
    kind,
    ...(options.outcome ? { outcome: options.outcome } : {}),
    ...(options.path ? { path: options.path } : {}),
    technical: {
      source: options.source ?? "codex-jsonl",
      itemType:
        options.source === "workspace-diff"
          ? "workspace_manifest"
          : "command_execution",
      ...(options.command ? { command: options.command } : {}),
      ...(options.exitCode !== undefined
        ? { exitCode: options.exitCode }
        : {}),
    },
  };
}

const passingTest = runEvent("verify", { outcome: "success", exitCode: 0 });
const failingTest = runEvent("verify", { outcome: "failure", exitCode: 1 });

function mutation(path: string): RunEvent {
  return runEvent("modify", {
    outcome: "success",
    path,
    source: "workspace-diff",
  });
}

describe("execution evidence display", () => {
  it("uses test-command wording derived from recognized verification events", () => {
    expect(testCommandStatus([passingTest])).toBe("Test command passed");
    expect(testCommandStatus([failingTest])).toBe("Test command failed");
    expect(testCommandStatus([])).toBe("Test command not observed");
  });

  it("warns for passing tests when a tests directory file changed", () => {
    expect(
      hasTestFileIntegrityWarning([passingTest, mutation("tests/auth.ts")]),
    ).toBe(true);
  });

  it.each(["src/auth.test.ts", "src/auth.spec.ts"])(
    "warns for passing tests when %s changed",
    (workspacePath) => {
      expect(
        hasTestFileIntegrityWarning([passingTest, mutation(workspacePath)]),
      ).toBe(true);
    },
  );

  it("does not warn when a passing test has no test-file mutation", () => {
    expect(hasTestFileIntegrityWarning([passingTest])).toBe(false);
  });

  it("cannot derive a warning from an Agent final response", () => {
    const agentFinalResponse = "Tests passed after I updated tests/auth.ts";
    expect(agentFinalResponse).toContain("Tests passed");
    expect(hasTestFileIntegrityWarning([mutation("tests/auth.ts")])).toBe(false);
  });

  it("does not warn for unrelated source-file mutations", () => {
    expect(
      hasTestFileIntegrityWarning([passingTest, mutation("src/auth.ts")]),
    ).toBe(false);
  });

  it("does not treat non-workspace-diff mutation claims as integrity evidence", () => {
    expect(
      hasTestFileIntegrityWarning([
        passingTest,
        runEvent("modify", {
          outcome: "success",
          path: "tests/auth.ts",
          source: "codex-jsonl",
        }),
      ]),
    ).toBe(false);
  });

  it("does not display technical command rows with no safe details", () => {
    const emptyCommand = runEvent("command", { outcome: "success" });
    const exitOnlyCommand = runEvent("command", {
      outcome: "success",
      exitCode: 0,
    });
    expect(
      displayableTechnicalCommandEvents([emptyCommand, exitOnlyCommand]),
    ).toEqual([exitOnlyCommand]);
  });
});
