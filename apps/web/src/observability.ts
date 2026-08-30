import type { RunEvent } from "./types";

export type TestCommandStatus =
  | "Test command passed"
  | "Test command failed"
  | "Test command not observed";

const WORKSPACE_MUTATION_KINDS = new Set<RunEvent["kind"]>([
  "create",
  "modify",
  "delete",
]);
const TEST_DIRECTORY_NAMES = new Set(["test", "tests", "__tests__"]);

export function testCommandStatus(
  events: readonly RunEvent[],
): TestCommandStatus {
  const testCommands = events.filter((event) => event.kind === "verify");
  if (testCommands.length === 0) return "Test command not observed";
  return testCommands.some((event) => event.outcome === "failure")
    ? "Test command failed"
    : "Test command passed";
}

export function isLikelyTestFilePath(workspacePath: string): boolean {
  const segments = workspacePath.split("/");
  const basename = segments.at(-1)?.toLowerCase() ?? "";
  return (
    segments
      .slice(0, -1)
      .some((segment) => TEST_DIRECTORY_NAMES.has(segment.toLowerCase())) ||
    basename.includes(".test.") ||
    basename.includes(".spec.")
  );
}

export function hasTestFileIntegrityWarning(
  events: readonly RunEvent[],
): boolean {
  if (testCommandStatus(events) !== "Test command passed") return false;
  return events.some(
    (event) =>
      event.technical.source === "workspace-diff" &&
      WORKSPACE_MUTATION_KINDS.has(event.kind) &&
      typeof event.path === "string" &&
      isLikelyTestFilePath(event.path),
  );
}

export function displayableTechnicalCommandEvents(
  events: readonly RunEvent[],
): RunEvent[] {
  return events.filter(
    (event) =>
      event.kind === "command" &&
      event.outcome !== "failure" &&
      (Boolean(event.technical.command) ||
        event.technical.exitCode !== undefined),
  );
}
