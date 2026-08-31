import { describe, expect, it } from "vitest";
import { runsByOwnerMessageId } from "../../web/src/run-history.js";

describe("conversation Run ownership", () => {
  it("renders each Run once under its first chronological user message", () => {
    const messages = [
      { id: "task-a", runId: "run-a", role: "user" as const },
      { id: "answer-a", runId: "run-a", role: "assistant" as const },
      { id: "duplicate-a", runId: "run-a", role: "user" as const },
      { id: "task-b", runId: "run-b", role: "user" as const },
    ];
    const owned = runsByOwnerMessageId(messages, [
      { id: "run-a", source: "active" },
      { id: "run-b", source: "historical" },
      { id: "run-a", source: "historical" },
    ]);

    expect([...owned.keys()]).toEqual(["task-a", "task-b"]);
    expect(owned.get("task-a")).toEqual({ id: "run-a", source: "active" });
    expect([...owned.values()].filter((run) => run.id === "run-a")).toHaveLength(1);
    expect(owned.has("answer-a")).toBe(false);
    expect(owned.has("duplicate-a")).toBe(false);
  });
});
