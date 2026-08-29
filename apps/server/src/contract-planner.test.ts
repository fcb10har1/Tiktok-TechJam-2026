import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import {
  ArkContractPlanner,
  type ContractAmendment,
  type ContractProposal,
} from "./contract-planner.js";
import type { ExecutionContractV1 } from "./types.js";

const validProposal: ContractProposal = {
  goal: "Update the source safely",
  plannedActions: ["Inspect the source", "Change the implementation", "Run tests"],
  writablePaths: ["src"],
  protectedPaths: [".env", "deployment"],
  riskLevel: "low",
  rationale: "The task is limited to application source.",
};

const currentContract: ExecutionContractV1 = {
  version: 1,
  ...validProposal,
  protectedPaths: [".env", "deployment", "package.json"],
  proposalSource: "ai",
  proposalNotice: null,
  approvedAt: null,
  updatedAt: "2026-08-29T10:00:00.000Z",
};

const validAmendment: ContractAmendment = {
  ...validProposal,
  writablePaths: ["src/auth"],
  protectedPaths: [".env", "deployment/", "deployment/config.yml", "package.json"],
  removedProtectedPaths: [],
};

function config(environment: NodeJS.ProcessEnv = {}) {
  return loadConfig({
    NODE_ENV: "test",
    ARK_API_KEY: "planner-key",
    ARK_MODEL: "planner-model",
    ARK_BASE_URL: "https://ark.example/api/v3",
    ...environment,
  });
}

function providerResponse(proposal: unknown, status = 200): Response {
  return new Response(
    JSON.stringify({
      status: "completed",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: JSON.stringify(proposal) }],
        },
      ],
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

function planningInput() {
  return {
    task: "Change src/index.ts",
    agentInstructions: "Keep changes small.",
    workspaceInventory: ["AGENTS.md", "src/", "src/index.ts"],
  };
}

function amendmentInput() {
  return {
    task: "Improve authentication",
    agentInstructions: "Keep changes small.",
    currentContract,
    amendmentInstruction: "Only touch src/auth.",
    workspaceInventory: ["AGENTS.md", "src/", "src/auth.ts", "package.json"],
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ArkContractPlanner", () => {
  it("uses the Responses endpoint with strict text.format and no tools", async () => {
    const fetchMock = vi.fn(async () => providerResponse(validProposal));
    const planner = new ArkContractPlanner(config(), fetchMock as unknown as typeof fetch);

    await expect(planner.propose(planningInput())).resolves.toEqual(validProposal);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://ark.example/api/v3/responses");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty("tools");
    expect(body).toMatchObject({
      model: "planner-model",
      store: false,
      text: {
        format: {
          type: "json_schema",
          name: "execution_contract_v1",
          strict: true,
        },
      },
    });
    expect(JSON.stringify(body.input)).toContain("Change src/index.ts");
    expect(JSON.stringify(body.input)).toContain("src/index.ts");
  });

  it("sends the complete current contract for a strict tool-free amendment", async () => {
    const fetchMock = vi.fn(async () => providerResponse(validAmendment));
    const planner = new ArkContractPlanner(config(), fetchMock as unknown as typeof fetch);

    await expect(planner.amend(amendmentInput())).resolves.toEqual({
      ...validAmendment,
      protectedPaths: [".env", "deployment", "package.json"],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).not.toHaveProperty("tools");
    expect(body.text.format).toMatchObject({
      type: "json_schema",
      name: "execution_contract_amendment_v1",
      strict: true,
    });
    expect(body.text.format.schema.required).toContain("removedProtectedPaths");
    expect(body.instructions).toContain("Preserve every existing protected path");
    const input = JSON.stringify(body.input);
    expect(input).toContain("Improve authentication");
    expect(input).toContain("Only touch src/auth.");
    expect(input).toContain("package.json");
  });

  it("does not retry a rate-limited amendment", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
      }),
    );
    const planner = new ArkContractPlanner(config(), fetchMock as unknown as typeof fetch);

    await expect(planner.amend(amendmentInput())).rejects.toThrow(
      "Planner request failed",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed amendment JSON", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          output: [{ content: [{ type: "output_text", text: "not json" }] }],
        }),
        { status: 200 },
      ),
    );
    const planner = new ArkContractPlanner(config(), fetchMock as unknown as typeof fetch);

    await expect(planner.amend(amendmentInput())).rejects.toThrow(
      "Planner returned malformed contract JSON",
    );
  });

  it("retries once without text.format only when a 400 explicitly rejects it", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: "Unsupported parameter: text.format" } }),
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(providerResponse(validProposal));
    const planner = new ArkContractPlanner(config(), fetchMock as typeof fetch);

    await expect(planner.propose(planningInput())).resolves.toEqual(validProposal);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const retryBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(firstBody.text.format.type).toBe("json_schema");
    expect(retryBody).not.toHaveProperty("text");
    expect(retryBody).not.toHaveProperty("tools");
    expect(retryBody.instructions).toContain("Return only one raw JSON object");
  });

  it("applies the same strict validation to compatibility output", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("Unsupported structured output parameter text.format", {
          status: 400,
        }),
      )
      .mockResolvedValueOnce(
        providerResponse({ ...validProposal, protectedPaths: ["/etc"] }),
      );
    const planner = new ArkContractPlanner(config(), fetchMock as typeof fetch);

    await expect(planner.propose(planningInput())).rejects.toThrow(
      "Planner returned an invalid contract",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    [429, "rate limited"],
    [401, "authentication failed"],
    [500, "provider failed"],
    [400, "invalid model name"],
  ])("does not compatibility-retry an arbitrary %i response", async (status, message) => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message } }), { status }),
    );
    const planner = new ArkContractPlanner(config(), fetchMock as unknown as typeof fetch);

    await expect(planner.propose(planningInput())).rejects.toThrow(
      "Planner request failed",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["not json"],
    [JSON.stringify({ ...validProposal, riskLevel: "critical" })],
    [JSON.stringify({ ...validProposal, writablePaths: ["../outside"] })],
    [JSON.stringify({ ...validProposal, unexpected: true })],
  ])("rejects malformed, schema-invalid, or unsafe contract output %#", async (text) => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          output: [{ content: [{ type: "output_text", text }] }],
        }),
        { status: 200 },
      ),
    );
    const planner = new ArkContractPlanner(config(), fetchMock as unknown as typeof fetch);

    await expect(planner.propose(planningInput())).rejects.toThrow();
  });

  it("times out without making a compatibility retry", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    const planner = new ArkContractPlanner(
      config({ PLANNER_TIMEOUT_MS: "1000" }),
      fetchMock as unknown as typeof fetch,
    );

    const proposal = planner.propose(planningInput());
    const rejection = expect(proposal).rejects.toThrow("Planner request timed out");
    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
