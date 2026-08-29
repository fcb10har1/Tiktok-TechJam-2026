import type {
  Agent,
  AgentRun,
  ContractPlanningFailureCode,
  Message,
  SystemInfo,
} from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

let authToken = "";

export function setAuthToken(token: string): void {
  authToken = token.trim();
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = {
    ...(options?.body ? { "Content-Type": "application/json" } : {}),
    ...(authToken ? { Authorization: "Bearer " + authToken } : {}),
    ...options?.headers,
  };
  const response = await fetch(url, {
    ...options,
    headers,
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new ApiError(data.error ?? "Request failed", response.status);
  }
  return data;
}

export const api = {
  auth: () => request<{ required: boolean }>("/api/auth"),
  system: () => request<SystemInfo>("/api/system"),
  listAgents: () => request<{ agents: Agent[] }>("/api/agents"),
  createAgent: (body: {
    name: string;
    description: string;
    instructions: string;
  }) =>
    request<{ agent: Agent }>("/api/agents", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateAgent: (
    id: string,
    body: { name: string; description: string; instructions: string },
  ) =>
    request<{ agent: Agent }>("/api/agents/" + id, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteAgent: (id: string) =>
    request<{ archivedWorkspace: string }>("/api/agents/" + id, {
      method: "DELETE",
    }),
  startAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/start", {
      method: "POST",
    }),
  stopAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/stop", {
      method: "POST",
    }),
  messages: (id: string) =>
    request<{ messages: Message[] }>("/api/agents/" + id + "/messages"),
  runs: (id: string) =>
    request<{ runs: AgentRun[] }>("/api/agents/" + id + "/runs"),
  sendMessage: (id: string, content: string) =>
    request<{ run: AgentRun; message: Message }>(
      "/api/agents/" + id + "/messages",
      {
        method: "POST",
        body: JSON.stringify({ content }),
      },
    ),
  run: (id: string) => request<{ run: AgentRun }>("/api/runs/" + id),
  updateExecutionContract: (
    id: string,
    body: { protectedPaths?: string[]; writablePaths?: string[] },
  ) =>
    request<{ run: AgentRun }>("/api/runs/" + id + "/contract", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  retryExecutionContractProposal: (id: string) =>
    request<{
      run: AgentRun;
      applied: boolean;
      notice: string | null;
      failureCode: ContractPlanningFailureCode | null;
    }>("/api/runs/" + id + "/contract/retry-proposal", {
      method: "POST",
    }),
  negotiateExecutionContract: (id: string, instruction: string) =>
    request<{ run: AgentRun; applied: boolean; notice: string | null }>(
      "/api/runs/" + id + "/contract/negotiate",
      {
        method: "POST",
        body: JSON.stringify({ instruction }),
      },
    ),
  approveRun: (id: string) =>
    request<{ run: AgentRun }>("/api/runs/" + id + "/approve", {
      method: "POST",
    }),
  cancelRun: (id: string) =>
    request<{ run: AgentRun }>("/api/runs/" + id + "/cancel", {
      method: "POST",
    }),
};
