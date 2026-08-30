import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import {
  ArkContractPlanner,
  ContractPlanningError,
  parseContractProposal,
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
  it("reports only sanitized Zod issue metadata for schema-invalid proposals", () => {
    let caught: unknown;
    try {
      parseContractProposal({
        ...validProposal,
        riskLevel: "secret body text",
        writablePaths: [42],
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ContractPlanningError);
    expect(caught).toMatchObject({
      code: "schema_invalid",
      schemaIssues: [
        {
          path: "writablePaths.0",
          code: "invalid_type",
          expected: "string",
        },
        {
          path: "riskLevel",
          code: "invalid_value",
          expected: "low|medium|high",
        },
      ],
    });
    expect(JSON.stringify(caught)).not.toContain("secret body text");
  });

  it("defaults planner configuration to ARK_MODEL and a 30-second timeout", () => {
    expect(config()).toMatchObject({
      arkModel: "planner-model",
      arkPlannerModel: "planner-model",
      plannerTimeoutMs: 30_000,
    });
  });

  it("uses ARK_PLANNER_MODEL without changing the Codex execution model", async () => {
    const fetchMock = vi.fn(async () => providerResponse(validProposal));
    const plannerConfig = config({ ARK_PLANNER_MODEL: "planning-only-model" });
    const planner = new ArkContractPlanner(
      plannerConfig,
      fetchMock as unknown as typeof fetch,
    );

    await planner.propose(planningInput());

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.model).toBe("planning-only-model");
    expect(plannerConfig.arkModel).toBe("planner-model");
    expect(plannerConfig.arkPlannerModel).toBe("planning-only-model");
  });

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
    expect(body.instructions).toContain(
      "every other workspace path read-only by default",
    );
    expect(body.instructions).toContain("protected paths always win");
    expect(body.instructions).not.toContain("Writable paths are advisory only");
    const input = JSON.stringify(body.input);
    expect(input).toContain("Improve authentication");
    expect(input).toContain("Only touch src/auth.");
    expect(input).toContain("package.json");
  });

  it("retries a rate-limited amendment exactly once", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: { "retry-after": "0" },
        }),
      )
      .mockResolvedValueOnce(providerResponse(validAmendment));
    const planner = new ArkContractPlanner(config(), fetchMock as unknown as typeof fetch);

    await expect(planner.amend(amendmentInput())).resolves.toMatchObject({
      writablePaths: ["src/auth"],
      protectedPaths: [".env", "deployment", "package.json"],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

    await expect(planner.propose(planningInput())).rejects.toMatchObject({
      code: "path_invalid",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    [401, "authentication failed", "authentication_failed"],
    [500, "provider failed", "provider_error"],
    [400, "invalid model name", "provider_error"],
  ])("does not compatibility-retry an arbitrary %i response", async (status, message, code) => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message } }), { status }),
    );
    const planner = new ArkContractPlanner(config(), fetchMock as unknown as typeof fetch);

    await expect(planner.propose(planningInput())).rejects.toMatchObject({ code });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops after one automatic 429 retry and exposes a sanitized category", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "secret provider detail" } }), {
        status: 429,
        headers: { "retry-after": "0" },
      }),
    );
    const planner = new ArkContractPlanner(config(), fetchMock as unknown as typeof fetch);

    await expect(planner.propose(planningInput())).rejects.toMatchObject({
      code: "rate_limited",
      status: 429,
      retryCount: 1,
      message: "Planner is temporarily rate limited",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("honors a short Retry-After before the one rate-limit retry", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "0.01" },
        }),
      )
      .mockResolvedValueOnce(providerResponse(validProposal));
    const planner = new ArkContractPlanner(config(), fetchMock as unknown as typeof fetch);

    const proposal = planner.propose(planningInput());
    await vi.advanceTimersByTimeAsync(9);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(proposal).resolves.toEqual(validProposal);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["not json", "malformed_json"],
    [JSON.stringify({ ...validProposal, riskLevel: "critical" }), "schema_invalid"],
    [JSON.stringify({ ...validProposal, writablePaths: ["../outside"] }), "path_invalid"],
    [JSON.stringify({ ...validProposal, unexpected: true }), "schema_invalid"],
  ])("categorizes malformed, schema-invalid, or unsafe output %#", async (text, code) => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          output: [{ content: [{ type: "output_text", text }] }],
        }),
        { status: 200 },
      ),
    );
    const planner = new ArkContractPlanner(config(), fetchMock as unknown as typeof fetch);

    await expect(planner.propose(planningInput())).rejects.toMatchObject({ code });
  });

  it("categorizes refusals without exposing provider payloads", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          output: [{ content: [{ type: "refusal", refusal: "raw refusal" }] }],
        }),
        { status: 200 },
      ),
    );
    const planner = new ArkContractPlanner(config(), fetchMock as unknown as typeof fetch);

    await expect(planner.propose(planningInput())).rejects.toMatchObject({
      code: "refusal",
      message: "Planner refused to propose a contract",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
      config({ ARK_PLANNER_TIMEOUT_MS: "1000" }),
      fetchMock as unknown as typeof fetch,
    );

    const proposal = planner.propose(planningInput());
    const rejection = expect(proposal).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
