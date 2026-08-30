import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { AgentService } from "./agent-service.js";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

describe("HTTP boundary", () => {
  it("protects API routes with the configured shared token", async () => {
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "a-strong-test-token" }),
      service,
    );
    const denied = await app.inject({ method: "GET", url: "/api/agents" });
    expect(denied.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: "Bearer a-strong-test-token" },
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });

  it("preserves Fastify client error status codes", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service);
    const malformed = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: "{not-json",
    });
    expect(malformed.statusCode).toBe(400);

    const oversized = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ name: "x".repeat(1_100_000) }),
    });
    expect(oversized.statusCode).toBe(413);
    await app.close();
  });

  it("exposes Execution Contract amendment, approval, and cancellation routes", async () => {
    const runId = "11111111-1111-4111-8111-111111111111";
    const run = {
      id: runId,
      status: "awaiting_approval",
      executionContract: { protectedPaths: [".env"], approvedAt: null },
    };
    const contractService = {
      updateExecutionContract: vi.fn(async () => run),
      retryExecutionContractProposal: vi.fn(async () => ({
        run,
        applied: false,
        notice: "AI proposal unavailable: temporarily rate limited. Your current contract was preserved.",
        failureCode: "rate_limited",
      })),
      negotiateExecutionContract: vi.fn(async () => ({
        run,
        applied: true,
        notice: null,
      })),
      approveRun: vi.fn(async () => ({ ...run, status: "queued" })),
      cancelRun: vi.fn(async () => ({ ...run, status: "cancelled" })),
      rollbackRun: vi.fn(async () => ({
        ...run,
        status: "completed",
        rollback: { status: "restored" },
      })),
    } as unknown as AgentService;
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), contractService);

    const amended = await app.inject({
      method: "PATCH",
      url: "/api/runs/" + runId + "/contract",
      payload: { protectedPaths: [".env", "deployment"] },
    });
    expect(amended.statusCode).toBe(200);
    expect(contractService.updateExecutionContract).toHaveBeenCalledWith(runId, {
      protectedPaths: [".env", "deployment"],
    });

    const writableAmendment = await app.inject({
      method: "PATCH",
      url: "/api/runs/" + runId + "/contract",
      payload: { writablePaths: ["src/**"] },
    });
    expect(writableAmendment.statusCode).toBe(200);
    expect(contractService.updateExecutionContract).toHaveBeenLastCalledWith(runId, {
      writablePaths: ["src/**"],
    });

    const retried = await app.inject({
      method: "POST",
      url: "/api/runs/" + runId + "/contract/retry-proposal",
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toMatchObject({
      applied: false,
      failureCode: "rate_limited",
    });
    expect(contractService.retryExecutionContractProposal).toHaveBeenCalledWith(runId);

    const negotiated = await app.inject({
      method: "POST",
      url: "/api/runs/" + runId + "/contract/negotiate",
      payload: { instruction: "Protect package.json too." },
    });
    expect(negotiated.statusCode).toBe(200);
    expect(contractService.negotiateExecutionContract).toHaveBeenCalledWith(
      runId,
      "Protect package.json too.",
    );

    const approved = await app.inject({
      method: "POST",
      url: "/api/runs/" + runId + "/approve",
    });
    expect(approved.statusCode).toBe(202);
    expect(contractService.approveRun).toHaveBeenCalledWith(runId);

    const cancelled = await app.inject({
      method: "POST",
      url: "/api/runs/" + runId + "/cancel",
    });
    expect(cancelled.statusCode).toBe(200);
    expect(contractService.cancelRun).toHaveBeenCalledWith(runId);

    const rolledBack = await app.inject({
      method: "POST",
      url: "/api/runs/" + runId + "/rollback",
    });
    expect(rolledBack.statusCode).toBe(200);
    expect(rolledBack.json()).toMatchObject({
      run: { rollback: { status: "restored" } },
    });
    expect(contractService.rollbackRun).toHaveBeenCalledWith(runId);

    const malformed = await app.inject({
      method: "PATCH",
      url: "/api/runs/" + runId + "/contract",
      payload: { protectedPaths: "not-an-array" },
    });
    expect(malformed.statusCode).toBe(400);

    const emptyAmendment = await app.inject({
      method: "PATCH",
      url: "/api/runs/" + runId + "/contract",
      payload: {},
    });
    expect(emptyAmendment.statusCode).toBe(400);

    const emptyNegotiation = await app.inject({
      method: "POST",
      url: "/api/runs/" + runId + "/contract/negotiate",
      payload: { instruction: "   " },
    });
    expect(emptyNegotiation.statusCode).toBe(400);

    const oversizedNegotiation = await app.inject({
      method: "POST",
      url: "/api/runs/" + runId + "/contract/negotiate",
      payload: { instruction: "x".repeat(5_001) },
    });
    expect(oversizedNegotiation.statusCode).toBe(400);
    await app.close();
  });
});
