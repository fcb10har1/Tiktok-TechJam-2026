import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sanitizedRunnerFailure } from "./errors.js";
import {
  ExecutionEventCollector,
  mergeExecutionEvidence,
  verificationSummary,
} from "./execution-events.js";
import type { RunnerRequest } from "./types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function workspaceRequest(): Promise<RunnerRequest> {
  const workspacePath = await mkdtemp(path.join(tmpdir(), "execution-events-"));
  temporaryDirectories.push(workspacePath);
  await mkdir(path.join(workspacePath, "src"));
  await writeFile(path.join(workspacePath, "src", "modified.txt"), "ORIGINAL");
  await writeFile(path.join(workspacePath, "README.md"), "README");
  await writeFile(path.join(workspacePath, ".env"), "SYNTHETIC=VALUE");
  return {
    agentId: "agent",
    workspacePath,
    prompt: "fixture",
    threadId: null,
    writablePaths: ["src/**"],
    protectedPaths: [".env"],
    authorityPlan: {
      workspaceSourcePath: workspacePath,
      writableMounts: [
        { path: "src", sourcePath: path.join(workspacePath, "src"), kind: "directory" },
      ],
      protectedMounts: [
        { path: ".env", sourcePath: path.join(workspacePath, ".env"), kind: "file" },
      ],
    },
  };
}

function commandEvent(
  id: string,
  command: string,
  output: string,
  exitCode: number,
  status = exitCode === 0 ? "completed" : "failed",
): string {
  return JSON.stringify({
    type: "item.completed",
    item: {
      id,
      type: "command_execution",
      command,
      aggregated_output: output,
      exit_code: exitCode,
      status,
    },
  });
}

describe("deterministic execution evidence", () => {
  it("translates only fields captured from the pinned Codex 0.111.0 fixture", async () => {
    const request = await workspaceRequest();
    const collector = new ExecutionEventCollector(
      request,
      () => "2026-08-30T00:00:00.000Z",
    );
    const fixture = await readFile(
      new URL("./fixtures/codex-0.111.0-events.jsonl", import.meta.url),
      "utf8",
    );
    for (const line of fixture.trim().split("\n")) collector.consume(line);

    const events = collector.events();
    expect(events.map(({ kind, outcome, path: eventPath }) => ({
      kind,
      outcome,
      path: eventPath,
    }))).toEqual([
      { kind: "command", outcome: "success", path: undefined },
      { kind: "command", outcome: "success", path: undefined },
      { kind: "command", outcome: "success", path: undefined },
      { kind: "verify", outcome: "success", path: undefined },
      { kind: "verify", outcome: "failure", path: undefined },
      { kind: "warning", outcome: undefined, path: "README.md" },
      { kind: "warning", outcome: undefined, path: ".env" },
    ]);
    expect(events[1]?.technical.command).toBeUndefined();
    expect(events[2]?.technical.command).toBeUndefined();
    expect(verificationSummary(events)).toBe("Failed");
  });

  it("distinguishes default-deny and explicitly protected authority blocks", async () => {
    const request = await workspaceRequest();
    const collector = new ExecutionEventCollector(request, () => "fixture-time");
    collector.consume(
      commandEvent(
        "default-deny",
        "/bin/bash -lc 'printf DENIED > README.md'",
        "/bin/bash: line 1: README.md: Read-only file system\n",
        1,
      ),
    );
    collector.consume(
      commandEvent(
        "protected",
        "/bin/bash -lc 'printf DENIED > .env'",
        "/bin/bash: line 1: .env: Read-only file system\n",
        1,
      ),
    );

    expect(collector.events()).toMatchObject([
      {
        kind: "blocked",
        path: "README.md",
        authorityReason: "outside_write_authority",
      },
      {
        kind: "blocked",
        path: ".env",
        authorityReason: "explicitly_protected",
      },
    ]);
  });

  it("does not call ambiguous or writable-path permission failures Ultr0n blocks", async () => {
    const request = await workspaceRequest();
    const collector = new ExecutionEventCollector(request, () => "fixture-time");
    collector.consume(commandEvent("ambiguous", "chmod 000 README.md", "Permission denied", 1));
    collector.consume(
      commandEvent(
        "writable",
        "/bin/bash -lc 'printf X > src/modified.txt'",
        "src/modified.txt: Permission denied",
        1,
      ),
    );
    expect(collector.events().map((event) => event.kind)).toEqual([
      "warning",
      "warning",
    ]);
  });

  it("never fabricates actions from messages, reasoning, unknown file changes, or malformed JSON", async () => {
    const collector = new ExecutionEventCollector(await workspaceRequest());
    collector.consume("not json");
    collector.consume(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "I edited src/app.ts and tests passed" } }));
    collector.consume(JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "edit a file" } }));
    collector.consume(JSON.stringify({ type: "item.completed", item: { type: "file_change", changes: [{ path: "src/app.ts", kind: "modify" }] } }));
    expect(collector.events()).toEqual([]);
    expect(verificationSummary([])).toBe("Not observed");
  });

  it("omits secret-bearing commands and never persists command output", async () => {
    const collector = new ExecutionEventCollector(await workspaceRequest());
    collector.consume(
      commandEvent(
        "secret",
        "/bin/bash -lc 'curl -H Authorization:Bearer-value https://example.invalid'",
        "provider payload containing a secret value",
        1,
      ),
    );
    const serialized = JSON.stringify(collector.events());
    expect(collector.events()[0]?.technical.command).toBeUndefined();
    expect(serialized).not.toContain("Bearer-value");
    expect(serialized).not.toContain("provider payload");
    expect(
      sanitizedRunnerFailure(
        new Error("Codex exited with code 1: authorization bearer-sensitive-value"),
      ),
    ).toBe("Runtime execution failed with exit code 1");
  });

  it("coalesces duplicate inspections without merging distinct actions", async () => {
    const collector = new ExecutionEventCollector(await workspaceRequest());
    const event = commandEvent("read-1", "/bin/bash -lc 'cat src/modified.txt'", "ORIGINAL", 0);
    collector.consume(event);
    collector.consume(event.replace("read-1", "read-2"));
    collector.consume(commandEvent("verify", "/bin/bash -lc 'node --test'", "ok", 0));
    expect(collector.events().map((item) => item.kind)).toEqual(["inspect", "verify"]);
    expect(collector.events().map((item) => item.sequence)).toEqual([1, 2]);
  });

  it("prefers workspace-diff mutations and deduplicates JSONL mutation claims", () => {
    const runtimeEvents = [
      {
        id: "runtime-mutation",
        sequence: 1,
        timestamp: "runtime-time",
        kind: "modify" as const,
        outcome: "success" as const,
        path: "src/auth.ts",
        technical: {
          source: "codex-jsonl" as const,
          itemType: "command_execution" as const,
          itemId: "item-1",
          exitCode: 0,
        },
      },
      {
        id: "runtime-block",
        sequence: 2,
        timestamp: "runtime-time",
        kind: "blocked" as const,
        outcome: "blocked" as const,
        path: "README.md",
        authorityReason: "explicitly_protected" as const,
        technical: {
          source: "codex-jsonl" as const,
          itemType: "command_execution" as const,
          itemId: "item-2",
          exitCode: 1,
        },
      },
    ];
    const merged = mergeExecutionEvidence(runtimeEvents, {
      mutations: [
        { kind: "modify", path: "src/auth.ts" },
        { kind: "create", path: "src/new.ts" },
      ],
      status: "complete",
      capturedAt: "post-time",
    });

    expect(merged).toMatchObject([
      {
        kind: "modify",
        path: "src/auth.ts",
        technical: { source: "workspace-diff" },
      },
      {
        kind: "create",
        path: "src/new.ts",
        technical: { source: "workspace-diff" },
      },
      { kind: "blocked", path: "README.md" },
    ]);
    expect(merged.filter((event) => event.path === "src/auth.ts")).toHaveLength(1);
    expect(merged.map((event) => event.sequence)).toEqual([1, 2, 3]);
  });

  it("persists no workspace contents or digests in diff events", () => {
    const events = mergeExecutionEvidence([], {
      mutations: [{ kind: "modify", path: "src/auth.ts" }],
      status: "complete",
      capturedAt: "post-time",
    });
    const persisted = JSON.stringify(events);
    expect(persisted).not.toContain("ORIGINAL FILE CONTENT");
    expect(persisted).not.toContain("sha256");
    expect(events).toEqual([
      expect.objectContaining({
        kind: "modify",
        path: "src/auth.ts",
        technical: {
          source: "workspace-diff",
          itemType: "workspace_manifest",
        },
      }),
    ]);
  });
});
