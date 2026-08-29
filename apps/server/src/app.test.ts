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
      approveRun: vi.fn(async () => ({ ...run, status: "queued" })),
      cancelRun: vi.fn(async () => ({ ...run, status: "cancelled" })),
    } as unknown as AgentService;
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), contractService);

    const amended = await app.inject({
      method: "PATCH",
      url: "/api/runs/" + runId + "/contract",
      payload: { protectedPaths: [".env", "deployment"] },
    });
    expect(amended.statusCode).toBe(200);
    expect(contractService.updateExecutionContract).toHaveBeenCalledWith(runId, [
      ".env",
      "deployment",
    ]);

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

    const malformed = await app.inject({
      method: "PATCH",
      url: "/api/runs/" + runId + "/contract",
      payload: { protectedPaths: "not-an-array" },
    });
    expect(malformed.statusCode).toBe(400);
    await app.close();
  });
});
