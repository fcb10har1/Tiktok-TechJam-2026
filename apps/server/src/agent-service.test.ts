import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import type {
  ContractPlanner,
  ContractPlanningInput,
  ContractProposal,
} from "./contract-planner.js";
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

const basicProposal: ContractProposal = {
  goal: "Complete the requested task",
  plannedActions: ["Inspect the relevant files", "Make the requested change", "Run tests"],
  writablePaths: ["src"],
  protectedPaths: [],
  riskLevel: "low",
  rationale: "The proposed change is limited to source files.",
};

class FakePlanner implements ContractPlanner {
  readonly calls: ContractPlanningInput[] = [];

  constructor(private readonly result: ContractProposal | Error = basicProposal) {}

  async propose(input: ContractPlanningInput): Promise<ContractProposal> {
    this.calls.push(structuredClone(input));
    if (this.result instanceof Error) throw this.result;
    return structuredClone(this.result);
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
  planner: ContractPlanner = new FakePlanner(),
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
    planner,
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
    expect(run.executionContract).toMatchObject({
      version: 1,
      proposalSource: "ai",
      goal: "Complete the requested task",
      writablePaths: ["src"],
      riskLevel: "low",
    });
    expect(run.executionContract?.protectedPaths).toEqual([".env", "deployment"]);
    expect(runner.calls).toHaveLength(0);

    await service.approveRun(run.id);
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const messages = service.getMessages(agent.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toContain("write hello world");
    expect(service.getAgent(agent.id).codexThreadId).toBe("fake-thread");
  });

  it("triggers preflight planning and persists a validated AI proposal", async () => {
    const runner = new FakeRunner();
    const planner = new FakePlanner({
      goal: "Add a focused utility",
      plannedActions: ["Inspect src", "Add the utility", "Test it"],
      writablePaths: ["src/utility.ts", "src/utility.test.ts"],
      protectedPaths: ["secrets"],
      riskLevel: "medium",
      rationale: "Two source files are expected to change.",
    });
    const service = await makeService(runner, {}, planner);
    const agent = await service.createAgent({
      name: "Planner",
      instructions: "Prefer small TypeScript changes.",
    });

    const { run } = await service.sendMessage(agent.id, "Add a utility");

    expect(planner.calls).toHaveLength(1);
    expect(planner.calls[0]).toMatchObject({
      task: "Add a utility",
      agentInstructions: "Prefer small TypeScript changes.",
    });
    expect(planner.calls[0]?.workspaceInventory).toEqual(
      expect.arrayContaining(["AGENTS.md", "README.md"]),
    );
    expect(run).toMatchObject({
      status: "awaiting_approval",
      executionContract: {
        version: 1,
        goal: "Add a focused utility",
        plannedActions: ["Inspect src", "Add the utility", "Test it"],
        writablePaths: ["src/utility.ts", "src/utility.test.ts"],
        protectedPaths: [".env", "deployment", "secrets"],
        riskLevel: "medium",
        rationale: "Two source files are expected to change.",
        proposalSource: "ai",
        proposalNotice: null,
        approvedAt: null,
      },
    });
    expect(runner.calls).toHaveLength(0);
  });

  it("persists a fallback V1 contract and never runs when planning fails", async () => {
    const runner = new FakeRunner();
    const planner = new FakePlanner(new Error("provider returned 429"));
    const service = await makeService(runner, {}, planner);
    const agent = await service.createAgent({ name: "Fallback" });

    const { run } = await service.sendMessage(agent.id, "Review manually");

    expect(planner.calls).toHaveLength(1);
    expect(run).toMatchObject({
      status: "awaiting_approval",
      executionContract: {
        version: 1,
        goal: "Review manually",
        writablePaths: [],
        protectedPaths: [".env", "deployment"],
        riskLevel: "medium",
        proposalSource: "fallback",
        proposalNotice: "AI proposal unavailable — review contract manually.",
        approvedAt: null,
      },
    });
    expect(service.getRun(run.id)).toEqual(run);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(runner.calls).toHaveLength(0);
    await service.cancelRun(run.id);
  });

  it("falls back safely when planning returns invalid paths", async () => {
    for (const planner of [
      new FakePlanner({
        ...basicProposal,
        writablePaths: ["../outside"],
      }),
      new FakePlanner({
        ...basicProposal,
        protectedPaths: Array.from({ length: 100 }, (_, index) => "safe-" + index),
      }),
    ]) {
      const runner = new FakeRunner();
      const service = await makeService(runner, {}, planner);
      const agent = await service.createAgent({ name: "Fallback" });

      const { run } = await service.sendMessage(agent.id, "Review manually");

      expect(run).toMatchObject({
        status: "awaiting_approval",
        executionContract: {
          version: 1,
          goal: "Review manually",
          writablePaths: [],
          protectedPaths: [".env", "deployment"],
          riskLevel: "medium",
          proposalSource: "fallback",
          proposalNotice: "AI proposal unavailable — review contract manually.",
          approvedAt: null,
        },
      });
      expect(runner.calls).toHaveLength(0);
      await service.cancelRun(run.id);
    }
  });

  it("lets a human protect an AI-proposed writable path before approval", async () => {
    const runner = new FakeRunner();
    const planner = new FakePlanner({
      goal: "Improve authentication",
      plannedActions: ["Update authentication logic", "Run authentication tests"],
      writablePaths: ["src/auth.ts"],
      protectedPaths: [],
      riskLevel: "medium",
      rationale: "The implementation change is limited to authentication source.",
    });
    const service = await makeService(runner, {}, planner);
    const agent = await service.createAgent({ name: "Human override" });

    const { run } = await service.sendMessage(agent.id, "Improve authentication");
    expect(run.executionContract).toMatchObject({
      version: 1,
      proposalSource: "ai",
      writablePaths: ["src/auth.ts"],
      protectedPaths: [".env", "deployment"],
    });
    expect(runner.calls).toHaveLength(0);

    const amended = await service.updateExecutionContract(run.id, [
      ...(run.executionContract?.protectedPaths ?? []),
      "src/auth.ts",
    ]);
    expect(amended.executionContract).toMatchObject({
      writablePaths: ["src/auth.ts"],
      protectedPaths: [".env", "deployment", "src/auth.ts"],
      approvedAt: null,
    });
    expect(runner.calls).toHaveLength(0);

    await service.approveRun(run.id);
    await expect.poll(() => runner.calls.length).toBe(1);
    expect(runner.calls[0]?.protectedPaths).toEqual([
      ".env",
      "deployment",
      "src/auth.ts",
    ]);
    expect(service.getRun(run.id).executionContract).toMatchObject({
      protectedPaths: [".env", "deployment", "src/auth.ts"],
      approvedAt: expect.any(String),
    });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });

  it("amends, freezes, and passes the approved contract exactly once", async () => {
    const runner = new FakeRunner();
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Guarded" });
    const { run } = await service.sendMessage(agent.id, "change source only");

    const amended = await service.updateExecutionContract(run.id, [
      "package.json",
      "infra/secrets",
    ]);
    expect(amended.executionContract?.protectedPaths).toEqual([
      "package.json",
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
      "package.json",
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
