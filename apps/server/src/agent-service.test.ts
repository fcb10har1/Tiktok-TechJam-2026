import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

class FakeRunner implements AgentRunner {
  readonly calls: RunnerRequest[] = [];

  async run(request: RunnerRequest): Promise<RunnerResult> {
    this.calls.push(structuredClone(request));
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: { inputTokens: 12, outputTokens: 5 },
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeService(
  runner: AgentRunner = new FakeRunner(),
  environment: NodeJS.ProcessEnv = {},
): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
    RUNTIME_PROVIDER: "container",
    ...environment,
  });
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
  );
  await service.initialize();
  return service;
}

describe("Agent lifecycle", () => {
  it("creates, updates, stops, starts and deletes an Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Builder" });
    expect(service.listAgents()).toHaveLength(1);
    expect((await service.updateAgent(agent.id, { description: "Builds apps" })).description)
      .toBe("Builds apps");
    expect((await service.stopAgent(agent.id)).status).toBe("stopped");
    expect((await service.startAgent(agent.id)).status).toBe("ready");
    await service.deleteAgent(agent.id);
    expect(service.listAgents()).toHaveLength(0);
  });

  it("persists a playground conversation after approval", async () => {
    const runner = new FakeRunner();
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Coder" });
    const { run } = await service.sendMessage(agent.id, "write hello world");

    expect(run.status).toBe("awaiting_approval");
    expect(run.executionContract?.protectedPaths).toEqual([".env", "deployment"]);
    expect(runner.calls).toHaveLength(0);

    await service.approveRun(run.id);
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const messages = service.getMessages(agent.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toContain("write hello world");
    expect(service.getAgent(agent.id).codexThreadId).toBe("fake-thread");
  });

  it("amends, freezes, and passes the approved contract exactly once", async () => {
    const runner = new FakeRunner();
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Guarded" });
    const { run } = await service.sendMessage(agent.id, "change source only");

    const amended = await service.updateExecutionContract(run.id, [
      ".env",
      "deployment",
      "infra/secrets",
    ]);
    expect(amended.executionContract?.protectedPaths).toEqual([
      ".env",
      "deployment",
      "infra/secrets",
    ]);
    expect(runner.calls).toHaveLength(0);

    const approvals = await Promise.allSettled([
      service.approveRun(run.id),
      service.approveRun(run.id),
    ]);
    expect(approvals.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(approvals.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect.poll(() => runner.calls.length).toBe(1);
    expect(runner.calls[0]?.protectedPaths).toEqual([
      ".env",
      "deployment",
      "infra/secrets",
    ]);

    const persisted = service.getRun(run.id);
    expect(persisted.executionContract?.approvedAt).not.toBeNull();
    expect(persisted.executionContract?.protectedPaths).toEqual(
      runner.calls[0]?.protectedPaths,
    );
    await expect(service.updateExecutionContract(run.id, ["different"])).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("never executes a cancelled or unapproved Run", async () => {
    const runner = new FakeRunner();
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Cancelled" });
    const { run } = await service.sendMessage(agent.id, "do not run");

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(runner.calls).toHaveLength(0);
    expect((await service.cancelRun(run.id)).status).toBe("cancelled");
    expect(service.getAgent(agent.id).status).toBe("ready");
    await expect(service.approveRun(run.id)).rejects.toMatchObject({ statusCode: 409 });
    expect(runner.calls).toHaveLength(0);
  });

  it("does not approve an unenforced local-process contract", async () => {
    const runner = new FakeRunner();
    const service = await makeService(runner, { RUNTIME_PROVIDER: "local-process" });
    const agent = await service.createAgent({ name: "Local" });
    const { run } = await service.sendMessage(agent.id, "must stay protected");

    await expect(service.approveRun(run.id)).rejects.toMatchObject({ statusCode: 409 });
    expect(service.getRun(run.id).status).toBe("awaiting_approval");
    expect(runner.calls).toHaveLength(0);
  });

  it.each([
    [[""], "between 1 and 512"],
    [["/etc"], "workspace-relative"],
    [["../secret"], "workspace-relative"],
    [["deployment\\secret"], "workspace-relative"],
    [["deployment,src"], "workspace-relative"],
    [["deployment", "deployment"], "Duplicate"],
  ])("rejects invalid protected paths %#", async (protectedPaths, message) => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Invalid" });
    const { run } = await service.sendMessage(agent.id, "validate contract");
    await expect(service.updateExecutionContract(run.id, protectedPaths)).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining(message),
    });
  });

  it("preserves an awaiting-approval contract across restart", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-restart-test-"));
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
      RUNTIME_PROVIDER: "container",
    });
    const workspace = new WorkspaceManager(path.join(root, "workspaces"));
    const first = new AgentService(
      config,
      new JsonStore(path.join(root, "data", "db.json")),
      workspace,
      new FakeRunner(),
    );
    await first.initialize();
    const agent = await first.createAgent({ name: "Persistent" });
    const { run } = await first.sendMessage(agent.id, "wait for approval");
    await first.updateExecutionContract(run.id, [".env", "ops"]);

    const runnerAfterRestart = new FakeRunner();
    const restarted = new AgentService(
      config,
      new JsonStore(path.join(root, "data", "db.json")),
      workspace,
      runnerAfterRestart,
    );
    await restarted.initialize();

    expect(restarted.getRun(run.id)).toMatchObject({
      status: "awaiting_approval",
      executionContract: { protectedPaths: [".env", "ops"], approvedAt: null },
    });
    expect(restarted.getAgent(agent.id).status).toBe("busy");
    expect(runnerAfterRestart.calls).toHaveLength(0);
  });

  it("atomically accepts only one pending Run per Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Concurrent" });
    const attempts = await Promise.allSettled([
      service.sendMessage(agent.id, "first"),
      service.sendMessage(agent.id, "second"),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.find((attempt) => attempt.status === "rejected")).toMatchObject({
      reason: { statusCode: 409 },
    });
    expect(service.getMessages(agent.id)).toHaveLength(1);
  });

  it("does not let start reset an Agent reserved for approval", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Busy" });
    const { run } = await service.sendMessage(agent.id, "first");

    await expect(service.startAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.sendMessage(agent.id, "second")).rejects.toMatchObject({
      statusCode: 409,
    });
    await service.cancelRun(run.id);
  });
});
