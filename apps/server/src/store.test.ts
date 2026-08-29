import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "./store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("JsonStore", () => {
  it("reloads persisted execution events", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-events-"));
    temporaryDirectories.push(root);
    const filePath = path.join(root, "db.json");
    const store = new JsonStore(filePath);
    await store.initialize();
    await store.mutate((database) => {
      database.runs.push({
        id: "run-1",
        agentId: "agent-1",
        status: "completed",
        prompt: "test",
        output: "done",
        error: null,
        usage: null,
        startedAt: "2026-08-30T00:00:00.000Z",
        completedAt: "2026-08-30T00:00:01.000Z",
        createdAt: "2026-08-30T00:00:00.000Z",
        events: [
          {
            id: "codex-item-1",
            sequence: 1,
            timestamp: "2026-08-30T00:00:00.500Z",
            kind: "verify",
            outcome: "success",
            technical: {
              source: "codex-jsonl",
              itemType: "command_execution",
              exitCode: 0,
            },
          },
        ],
      });
    });

    const restarted = new JsonStore(filePath);
    await restarted.initialize();
    expect(restarted.snapshot().runs[0]?.events).toEqual([
      expect.objectContaining({ kind: "verify", outcome: "success" }),
    ]);
  });

  it("does not publish a mutation in memory when persistence fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const originalPath = path.join(root, "db.json");
    const store = new JsonStore(originalPath);
    await store.initialize();

    const mutableStore = store as unknown as { filePath: string };
    mutableStore.filePath = path.join(root, "missing-directory", "db.json");
    await expect(
      store.mutate((database) => {
        database.messages.push({
          id: "message-1",
          agentId: "agent-1",
          runId: "run-1",
          role: "user",
          content: "must not become visible",
          createdAt: new Date().toISOString(),
        });
      }),
    ).rejects.toThrow();
    expect(store.snapshot().messages).toEqual([]);

    mutableStore.filePath = originalPath;
    await store.mutate((database) => {
      database.messages.push({
        id: "message-2",
        agentId: "agent-1",
        runId: "run-2",
        role: "user",
        content: "queue recovered",
        createdAt: new Date().toISOString(),
      });
    });
    expect(store.snapshot().messages.map((message) => message.content)).toEqual([
      "queue recovered",
    ]);
  });
});
