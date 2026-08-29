import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, setAuthToken } from "./api";
import type { Agent, AgentRun, Message, RunEvent, SystemInfo } from "./types";

const starterPrompts = [
  "Create a small TypeScript CLI that prints a weather summary from sample JSON.",
  "Inspect this workspace and explain what you would improve first.",
  "Build a responsive single-page todo app with tests.",
];

const emptyForm = {
  name: "",
  description: "",
  instructions:
    "Help me build and test software in this workspace. Keep changes small and explain the result.",
};

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function StatusPill({ status, label }: { status: Agent["status"]; label?: string }) {
  return (
    <span className={"status status-" + status}>
      <span className="status-dot" />
      {label ?? status}
    </span>
  );
}

function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

function verificationStatus(events: readonly RunEvent[]): "Passed" | "Failed" | "Not observed" {
  const verificationEvents = events.filter((event) => event.kind === "verify");
  if (verificationEvents.length === 0) return "Not observed";
  return verificationEvents.some((event) => event.outcome === "failure")
    ? "Failed"
    : "Passed";
}

function eventDescription(event: RunEvent): string {
  if (event.kind === "inspect") return "Inspected " + event.path;
  if (event.kind === "create") return "Created " + event.path;
  if (event.kind === "modify") return "Modified " + event.path;
  if (event.kind === "delete") return "Deleted " + event.path;
  if (event.kind === "verify") {
    return event.outcome === "success" ? "Verification passed" : "Verification failed";
  }
  if (event.kind === "blocked") {
    const reason =
      event.authorityReason === "explicitly_protected"
        ? "Explicitly protected"
        : "Outside approved write authority";
    return "Blocked write to " + event.path + " — " + reason;
  }
  if (event.kind === "warning") {
    return event.path
      ? "Permission failure observed for " + event.path + "; authority attribution was inconclusive"
      : "Permission failure observed; authority attribution was inconclusive";
  }
  return event.outcome === "failure" ? "Command failed" : "Ran a command";
}

function changedFilesLabel(events: readonly RunEvent[], status: AgentRun["workspaceDiffStatus"]): string {
  const changes = events.filter(
    (event) =>
      event.technical.source === "workspace-diff" &&
      ["create", "modify", "delete"].includes(event.kind),
  );
  const labels = [
    ["create", "created"],
    ["modify", "modified"],
    ["delete", "deleted"],
  ] as const;
  const parts = labels.flatMap(([kind, label]) => {
    const count = changes.filter((event) => event.kind === kind).length;
    return count > 0 ? [count + " " + label] : [];
  });
  if (parts.length > 0) return parts.join(" · ");
  return status === "complete" ? "No resulting changes" : "Not observed";
}

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [prompt, setPrompt] = useState("");
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [writablePathInput, setWritablePathInput] = useState("");
  const [protectedPathInput, setProtectedPathInput] = useState("");
  const [negotiationInstruction, setNegotiationInstruction] = useState("");
  const [negotiatingContract, setNegotiatingContract] = useState(false);
  const [negotiationNotice, setNegotiationNotice] = useState<string | null>(null);
  const [retryingProposal, setRetryingProposal] = useState(false);
  const [proposalRetryNotice, setProposalRetryNotice] = useState<string | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [authInput, setAuthInput] = useState("");
  const messageEnd = useRef<HTMLDivElement>(null);
  const selectedIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const pollingRunIds = useRef(new Set<string>());
  selectedIdRef.current = selectedId;

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );
  const executionEvents = activeRun?.events ?? [];
  const primaryExecutionEvents = executionEvents.filter(
    (event) => event.kind !== "command" || event.outcome === "failure",
  );
  const genericCommandEvents = executionEvents.filter(
    (event) => event.kind === "command" && event.outcome !== "failure",
  );
  const workspaceMutationEvents = executionEvents.filter(
    (event) =>
      event.technical.source === "workspace-diff" &&
      ["create", "modify", "delete"].includes(event.kind),
  );

  const refreshAgents = useCallback(async () => {
    const { agents: next } = await api.listAgents();
    setAgents(next);
    setSelectedId((current) =>
      current && next.some((agent) => agent.id === current)
        ? current
        : (next[0]?.id ?? null),
    );
  }, []);

  const refreshMessages = useCallback(async (agentId: string) => {
    const result = await api.messages(agentId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setMessages(result.messages);
    }
  }, []);

  const bootstrap = useCallback(async () => {
    await Promise.all([refreshAgents(), api.system().then(setSystem)]);
  }, [refreshAgents]);

  useEffect(() => {
    mountedRef.current = true;
    void api
      .auth()
      .then(async ({ required }) => {
        if (!mountedRef.current) return;
        setAuthRequired(required);
        if (!required) await bootstrap();
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      mountedRef.current = false;
    };
  }, [bootstrap]);

  useEffect(() => {
    setActiveRun(null);
    setWritablePathInput("");
    setProtectedPathInput("");
    setNegotiationInstruction("");
    setNegotiationNotice(null);
    setNegotiatingContract(false);
    setRetryingProposal(false);
    setProposalRetryNotice(null);
    setShowSettings(false);
    if (!selectedId) {
      setMessages([]);
      return;
    }
    void Promise.all([refreshMessages(selectedId), api.runs(selectedId)])
      .then(([, result]) => {
        if (selectedIdRef.current !== selectedId) return;
        const latest = result.runs[0] ?? null;
        setActiveRun(latest);
        if (latest && ["queued", "running"].includes(latest.status)) {
          void pollRun(latest.id, selectedId).catch((reason) =>
            setError(reason instanceof Error ? reason.message : String(reason)),
          );
        }
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, [refreshMessages, selectedId]);

  useEffect(() => {
    if (selected) {
      setForm({
        name: selected.name,
        description: selected.description,
        instructions: selected.instructions,
      });
    }
  }, [selected]);

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeRun]);

  const createAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { agent } = await api.createAgent(form);
      await refreshAgents();
      setSelectedId(agent.id);
      setShowCreate(false);
      setForm(emptyForm);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateAgent(selected.id, form);
      await refreshAgents();
      setShowSettings(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleAgent = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      if (selected.status === "stopped") {
        await api.startAgent(selected.id);
      } else {
        await api.stopAgent(selected.id);
      }
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const deleteAgent = async () => {
    if (!selected) return;
    if (!window.confirm("Delete " + selected.name + "? Its workspace will be archived.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.deleteAgent(selected.id);
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const pollRun = async (runId: string, agentId: string) => {
    if (pollingRunIds.current.has(runId)) return;
    pollingRunIds.current.add(runId);
    try {
      while (mountedRef.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        if (!mountedRef.current) return;
        const result = await api.run(runId);
        if (selectedIdRef.current === agentId) setActiveRun(result.run);
        if (!["queued", "running"].includes(result.run.status)) {
          await Promise.all([refreshMessages(agentId), refreshAgents()]);
          return;
        }
      }
    } finally {
      pollingRunIds.current.delete(runId);
    }
  };

  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !prompt.trim()) return;
    const content = prompt.trim();
    setPrompt("");
    setError(null);
    try {
      const result = await api.sendMessage(selected.id, content);
      if (selectedIdRef.current === selected.id) {
        setMessages((current) => [...current, result.message]);
        setActiveRun(result.run);
        setNegotiationInstruction("");
        setNegotiationNotice(null);
        setProposalRetryNotice(null);
      }
      setAgents((current) =>
        current.map((agent) =>
          agent.id === selected.id ? { ...agent, status: "busy" } : agent,
        ),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setActiveRun(null);
      await refreshAgents();
    }
  };

  const replaceProtectedPaths = async (protectedPaths: string[]) => {
    if (
      !activeRun ||
      activeRun.status !== "awaiting_approval" ||
      negotiatingContract ||
      retryingProposal
    ) return;
    setBusy(true);
    setError(null);
    try {
      const { run } = await api.updateExecutionContract(activeRun.id, {
        protectedPaths,
      });
      setActiveRun(run);
      setProposalRetryNotice(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const replaceWritablePaths = async (writablePaths: string[]) => {
    if (
      !activeRun ||
      activeRun.status !== "awaiting_approval" ||
      activeRun.executionContract?.version !== 1 ||
      negotiatingContract ||
      retryingProposal
    ) return;
    setBusy(true);
    setError(null);
    try {
      const { run } = await api.updateExecutionContract(activeRun.id, {
        writablePaths,
      });
      setActiveRun(run);
      setProposalRetryNotice(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const negotiateExecutionContract = async (event: React.FormEvent) => {
    event.preventDefault();
    const instruction = negotiationInstruction.trim();
    if (
      !activeRun ||
      activeRun.status !== "awaiting_approval" ||
      activeRun.executionContract?.version !== 1 ||
      !instruction ||
      retryingProposal
    ) return;
    setNegotiatingContract(true);
    setNegotiationNotice(null);
    setError(null);
    try {
      const result = await api.negotiateExecutionContract(activeRun.id, instruction);
      setActiveRun(result.run);
      setNegotiationNotice(result.notice);
      setProposalRetryNotice(null);
      if (result.applied) setNegotiationInstruction("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setNegotiatingContract(false);
    }
  };

  const addProtectedPath = async (event: React.FormEvent) => {
    event.preventDefault();
    const protectedPath = protectedPathInput.trim();
    const currentPaths = activeRun?.executionContract?.protectedPaths;
    if (!protectedPath || !currentPaths) return;
    await replaceProtectedPaths([...currentPaths, protectedPath]);
    setProtectedPathInput("");
  };

  const addWritablePath = async (event: React.FormEvent) => {
    event.preventDefault();
    const writablePath = writablePathInput.trim();
    const contract = activeRun?.executionContract;
    if (!writablePath || contract?.version !== 1) return;
    await replaceWritablePaths([...contract.writablePaths, writablePath]);
    setWritablePathInput("");
  };

  const retryExecutionContractProposal = async () => {
    if (
      !activeRun ||
      activeRun.status !== "awaiting_approval" ||
      activeRun.executionContract?.version !== 1 ||
      activeRun.executionContract.proposalSource !== "fallback"
    ) return;
    setRetryingProposal(true);
    setProposalRetryNotice(null);
    setError(null);
    try {
      const result = await api.retryExecutionContractProposal(activeRun.id);
      setActiveRun(result.run);
      setProposalRetryNotice(result.notice);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRetryingProposal(false);
    }
  };

  const approveRun = async () => {
    if (
      !activeRun ||
      activeRun.status !== "awaiting_approval" ||
      !selected ||
      retryingProposal
    ) return;
    setBusy(true);
    setError(null);
    try {
      const { run } = await api.approveRun(activeRun.id);
      setActiveRun(run);
      void pollRun(run.id, selected.id).catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const cancelPendingRun = async () => {
    if (
      !activeRun ||
      activeRun.status !== "awaiting_approval" ||
      !selected ||
      retryingProposal
    ) return;
    setBusy(true);
    setError(null);
    try {
      const { run } = await api.cancelRun(activeRun.id);
      setActiveRun(run);
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setAuthToken(authInput);
    try {
      await bootstrap();
      setAuthRequired(false);
      setAuthInput("");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        setError("The access token is not valid.");
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setBusy(false);
    }
  };

  if (authRequired === null) {
    return (
      <main className="auth-screen">
        <section className="auth-card" aria-live="polite">
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Connecting to the control plane</h1>
          {error ? <div className="error-banner" role="alert">{error}</div> : <Spinner />}
        </section>
      </main>
    );
  }

  if (authRequired) {
    return (
      <main className="auth-screen">
        <form className="auth-card" onSubmit={unlock}>
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Enter the access token</h1>
          <p>This shared demo token is configured by the platform operator.</p>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <label>
            Access token
            <input
              autoFocus
              type="password"
              value={authInput}
              onChange={(event) => setAuthInput(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <button className="button button-primary" disabled={busy || !authInput.trim()}>
            {busy ? <Spinner /> : "Open Launchpad"}
          </button>
        </form>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">A</div>
          <div>
            <strong>Agent Launchpad</strong>
            <span>
              {system?.runtimeProvider === "container"
                ? "Local container · Codex CLI"
                : "ECS / Docker · Codex CLI"}
            </span>
          </div>
        </div>

        <button
          className="button button-primary create-button"
          onClick={() => {
            setForm(emptyForm);
            setShowCreate(true);
          }}
        >
          <span>＋</span> Create Agent
        </button>

        <div className="sidebar-label">
          <span>Your Agents</span>
          <span>{agents.length}</span>
        </div>
        <nav className="agent-list">
          {agents.map((agent) => (
            <button
              className={"agent-card " + (agent.id === selectedId ? "selected" : "")}
              key={agent.id}
              onClick={() => setSelectedId(agent.id)}
            >
              <div className="agent-avatar">{agent.name.slice(0, 1).toUpperCase()}</div>
              <div className="agent-card-copy">
                <strong>{agent.name}</strong>
                <span>{agent.description || "Coding Agent"}</span>
              </div>
              <span className={"mini-dot mini-" + agent.status} />
            </button>
          ))}
          {agents.length === 0 && (
            <div className="empty-sidebar">
              <span>◇</span>
              Create your first coding Agent.
            </div>
          )}
        </nav>

        <div className="runtime-card">
          <span className="eyebrow">Runtime</span>
          <strong>{system?.runtime ?? "Checking…"}</strong>
          <span>
            {system?.arkModel ?? "Ark model not configured"}
            {system?.containerEngine ? " · " + system.containerEngine : ""}
          </span>
        </div>
      </aside>

      <main className="main">
        {!system?.arkConfigured || !system?.codexAvailable ? (
          <div className="config-banner">
            <span>!</span>
            <div>
              <strong>Runtime configuration needed</strong>
              <p>
                {!system?.arkConfigured
                  ? "Set ARK_API_KEY and ARK_MODEL in .env before using the Playground."
                  : system.runtimeProvider === "container"
                    ? "The local container engine or Agent Runtime image is unavailable. Rerun npm run poc."
                    : "Codex CLI was not found. Use the Docker image or install @openai/codex."}
              </p>
            </div>
          </div>
        ) : null}

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}

        {selected ? (
          <>
            <header className="agent-header">
              <div>
                <div className="header-title-row">
                  <h1>{selected.name}</h1>
                  <StatusPill
                    status={selected.status}
                    label={
                      activeRun?.status === "awaiting_approval"
                        ? "Awaiting approval"
                        : undefined
                    }
                  />
                </div>
                <p>{selected.description || "A Codex coding Agent in an isolated workspace."}</p>
              </div>
              <div className="header-actions">
                <button
                  className="button button-ghost"
                  onClick={() => setShowSettings((value) => !value)}
                  disabled={busy || selected.status === "busy"}
                >
                  Settings
                </button>
                <button
                  className="button button-ghost"
                  onClick={toggleAgent}
                  disabled={busy}
                >
                  {selected.status === "stopped" ? "Start" : "Stop"}
                </button>
                <button
                  className="button button-danger"
                  onClick={deleteAgent}
                  disabled={busy || selected.status === "busy"}
                >
                  Delete
                </button>
              </div>
            </header>

            {showSettings && (
              <form className="settings-panel" onSubmit={saveAgent}>
                <div className="settings-title">
                  <div>
                    <span className="eyebrow">Agent configuration</span>
                    <h2>Instructions and identity</h2>
                  </div>
                  <button type="button" onClick={() => setShowSettings(false)}>×</button>
                </div>
                <div className="form-grid">
                  <label>
                    Name
                    <input
                      value={form.name}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                      required
                      maxLength={80}
                    />
                  </label>
                  <label>
                    Description
                    <input
                      value={form.description}
                      onChange={(event) =>
                        setForm({ ...form, description: event.target.value })
                      }
                      maxLength={500}
                    />
                  </label>
                </div>
                <label>
                  System instructions
                  <textarea
                    value={form.instructions}
                    onChange={(event) =>
                      setForm({ ...form, instructions: event.target.value })
                    }
                    rows={5}
                    maxLength={10_000}
                  />
                </label>
                <div className="panel-footer">
                  <code>{selected.workspacePath}</code>
                  <button className="button button-primary" disabled={busy}>
                    {busy ? <Spinner /> : "Save changes"}
                  </button>
                </div>
              </form>
            )}

            <section className="playground">
              <div className="playground-topbar">
                <div>
                  <span className="eyebrow">Playground</span>
                  <h2>Build something with your Agent</h2>
                </div>
                <div className="session-info">
                  <span className="pulse" />
                  {selected.codexThreadId ? "Session connected" : "New session"}
                </div>
              </div>

              <div className="messages">
                {messages.length === 0 && !activeRun ? (
                  <div className="welcome">
                    <div className="welcome-orbit">
                      <div>⌁</div>
                    </div>
                    <h3>What should {selected.name} build?</h3>
                    <p>
                      The Agent can inspect files, write code, run commands, and continue the
                      same Codex session across messages.
                    </p>
                    <div className="prompt-grid">
                      {starterPrompts.map((item) => (
                        <button key={item} onClick={() => setPrompt(item)}>
                          <span>↗</span>
                          {item}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  messages.map((message) => (
                    <article className={"message message-" + message.role} key={message.id}>
                      <div className="message-meta">
                        <strong>{message.role === "user" ? "You" : selected.name}</strong>
                        <span>{formatTime(message.createdAt)}</span>
                      </div>
                      <div className="message-body">{message.content}</div>
                    </article>
                  ))
                )}
                {activeRun?.status === "awaiting_approval" &&
                  activeRun.executionContract && (
                    <article className="execution-contract">
                      <div className="contract-header">
                        <div>
                          <span className="eyebrow">
                            Execution Contract v{activeRun.executionContract.version}
                          </span>
                          <h3>Awaiting approval</h3>
                        </div>
                        <div className="contract-badges">
                          {activeRun.executionContract.version === 1 && (
                            <span
                              className={
                                "proposal-source proposal-source-" +
                                activeRun.executionContract.proposalSource
                              }
                            >
                              <span className="proposal-source-dot" aria-hidden="true" />
                              {activeRun.executionContract.proposalSource === "ai"
                                ? "AI proposal"
                                : "Fallback contract"}
                            </span>
                          )}
                          <span className="contract-status">
                            <span className="contract-status-dot" aria-hidden="true" />
                            Awaiting approval
                          </span>
                        </div>
                      </div>
                      {activeRun.executionContract.version === 1 ? (
                        <>
                          {activeRun.executionContract.proposalNotice && (
                            <p className="contract-notice">
                              {activeRun.executionContract.proposalNotice}
                            </p>
                          )}
                          {activeRun.executionContract.proposalSource === "fallback" && (
                            <div className="contract-retry-proposal">
                              <button
                                type="button"
                                className="button button-ghost"
                                disabled={busy || negotiatingContract || retryingProposal}
                                onClick={() => void retryExecutionContractProposal()}
                              >
                                {retryingProposal ? <Spinner /> : "Retry AI Proposal"}
                              </button>
                              {retryingProposal && (
                                <span role="status">
                                  Planning only—Codex is not running.
                                </span>
                              )}
                            </div>
                          )}
                          {proposalRetryNotice && (
                            <p className="contract-negotiation-notice" role="status">
                              {proposalRetryNotice}
                            </p>
                          )}
                          <div className="contract-task">
                            <strong>Goal</strong>
                            <p>{activeRun.executionContract.goal}</p>
                          </div>
                          <div className="contract-section">
                            <strong>Planned actions</strong>
                            {activeRun.executionContract.plannedActions.length > 0 ? (
                              <ol>
                                {activeRun.executionContract.plannedActions.map(
                                  (action, index) => (
                                    <li key={index + "-" + action}>{action}</li>
                                  ),
                                )}
                              </ol>
                            ) : (
                              <p className="contract-empty">No actions proposed.</p>
                            )}
                          </div>
                          <div className="contract-section">
                            <strong>Runtime-enforced write authority</strong>
                            {activeRun.executionContract.writablePaths.length > 0 ? (
                              <ul className="contract-scope-list contract-editable-paths">
                                {activeRun.executionContract.writablePaths.map(
                                  (writablePath) => (
                                    <li key={writablePath}>
                                      <code>{writablePath}</code>
                                      <button
                                        type="button"
                                        disabled={
                                          busy || negotiatingContract || retryingProposal
                                        }
                                        onClick={() =>
                                          void replaceWritablePaths(
                                            activeRun.executionContract?.version === 1
                                              ? activeRun.executionContract.writablePaths.filter(
                                                  (item) => item !== writablePath,
                                                )
                                              : [],
                                          )
                                        }
                                        aria-label={"Remove writable path " + writablePath}
                                      >
                                        Remove
                                      </button>
                                    </li>
                                  ),
                                )}
                              </ul>
                            ) : (
                              <p className="contract-empty">
                                No write authority is requested. The workspace will be
                                completely read-only.
                              </p>
                            )}
                            <form className="contract-add-path" onSubmit={addWritablePath}>
                              <input
                                value={writablePathInput}
                                onChange={(event) =>
                                  setWritablePathInput(event.target.value)
                                }
                                placeholder="Add writable path, e.g. src/**"
                                disabled={busy || negotiatingContract || retryingProposal}
                              />
                              <button
                                type="submit"
                                className="button button-ghost"
                                disabled={
                                  busy ||
                                  negotiatingContract ||
                                  retryingProposal ||
                                  !writablePathInput.trim()
                                }
                              >
                                Add path
                              </button>
                            </form>
                            <p className="contract-advisory">
                              <strong>Enforced after approval:</strong> the Agent can
                              modify or create files only inside these approved scopes.
                              Everything else in the workspace is read-only.
                            </p>
                          </div>
                          <div className="contract-summary">
                            <div className="contract-risk">
                              <strong className="contract-field-label">Risk level</strong>
                              <span
                                className={
                                  "risk-level risk-level-" +
                                  activeRun.executionContract.riskLevel
                                }
                              >
                                {activeRun.executionContract.riskLevel}
                              </span>
                            </div>
                            {activeRun.executionContract.rationale && (
                              <div>
                                <strong>Rationale</strong>
                                <p>{activeRun.executionContract.rationale}</p>
                              </div>
                            )}
                          </div>
                          <form
                            className="contract-negotiation"
                            onSubmit={negotiateExecutionContract}
                          >
                            <label htmlFor="contract-negotiation-input">
                              Negotiate this contract
                            </label>
                            <div className="contract-negotiation-row">
                              <textarea
                                id="contract-negotiation-input"
                                value={negotiationInstruction}
                                onChange={(event) =>
                                  setNegotiationInstruction(event.target.value)
                                }
                                placeholder="Tell Ultr0n what you want changed..."
                                rows={2}
                                maxLength={5_000}
                                disabled={busy || negotiatingContract || retryingProposal}
                              />
                              <button
                                type="submit"
                                className="button button-ghost"
                                disabled={
                                  busy ||
                                  negotiatingContract ||
                                  retryingProposal ||
                                  !negotiationInstruction.trim()
                                }
                              >
                                Apply changes
                              </button>
                            </div>
                            {negotiatingContract && (
                              <div className="contract-updating" role="status">
                                <span className="contract-updating-dot" aria-hidden="true" />
                                <span>
                                  <strong>Updating contract…</strong> Codex is not running.
                                </span>
                              </div>
                            )}
                            {negotiationNotice && (
                              <p className="contract-negotiation-notice" role="status">
                                {negotiationNotice}
                              </p>
                            )}
                          </form>
                        </>
                      ) : (
                        <div className="contract-task">
                          <strong>Task</strong>
                          <p>{activeRun.prompt}</p>
                        </div>
                      )}
                      <div className="contract-paths">
                        <strong>Protected paths</strong>
                        {activeRun.executionContract.protectedPaths.length === 0 ? (
                          <p className="contract-empty">No paths are protected.</p>
                        ) : (
                          <ul>
                            {activeRun.executionContract.protectedPaths.map((protectedPath) => (
                              <li key={protectedPath}>
                                <code>{protectedPath}</code>
                                <button
                                  type="button"
                                  disabled={busy || negotiatingContract || retryingProposal}
                                  onClick={() =>
                                    void replaceProtectedPaths(
                                      activeRun.executionContract?.protectedPaths.filter(
                                        (item) => item !== protectedPath,
                                      ) ?? [],
                                    )
                                  }
                                  aria-label={"Remove protected path " + protectedPath}
                                >
                                  Remove
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                        <form className="contract-add-path" onSubmit={addProtectedPath}>
                          <input
                            value={protectedPathInput}
                            onChange={(event) => setProtectedPathInput(event.target.value)}
                            placeholder="Add workspace-relative path"
                            disabled={busy || negotiatingContract || retryingProposal}
                          />
                          <button
                            type="submit"
                            className="button button-ghost"
                            disabled={
                              busy ||
                              negotiatingContract ||
                              retryingProposal ||
                              !protectedPathInput.trim()
                            }
                          >
                            Add path
                          </button>
                        </form>
                      </div>
                      <p className="contract-limitation">
                        Protected paths always override writable scopes. Directory scopes
                        ending in <code>/**</code> authorize new descendants; exact-file
                        scopes do not make sibling files writable.
                      </p>
                      <div className="contract-actions">
                        <button
                          type="button"
                          className="button button-ghost"
                          disabled={busy || negotiatingContract || retryingProposal}
                          onClick={() => void cancelPendingRun()}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="button button-primary"
                          disabled={busy || negotiatingContract || retryingProposal}
                          onClick={() => void approveRun()}
                        >
                          {busy ? <Spinner /> : "Approve & Run"}
                        </button>
                      </div>
                    </article>
                  )}
                {activeRun && ["queued", "running"].includes(activeRun.status) && (
                  <article className="message message-assistant thinking">
                    <div className="message-meta">
                      <strong>{selected.name}</strong>
                      <span>working in the Agent workspace</span>
                    </div>
                    <div className="thinking-row">
                      <Spinner />
                      Codex is reading, editing, or running commands…
                    </div>
                  </article>
                )}
                {activeRun &&
                  ["completed", "failed", "cancelled"].includes(activeRun.status) && (
                    <article className="execution-evidence">
                      <div className="execution-evidence-header">
                        <div>
                          <span className="eyebrow">Execution evidence</span>
                          <h3>Deterministic post-run record</h3>
                        </div>
                        <span className="evidence-source">Runtime + workspace evidence</span>
                      </div>
                      <section className="evidence-planned">
                        <strong>Planned</strong>
                        {activeRun.executionContract?.version === 1 ? (
                          <ol>
                            {activeRun.executionContract.plannedActions.map(
                              (action, index) => (
                                <li key={index + "-planned-" + action}>{action}</li>
                              ),
                            )}
                          </ol>
                        ) : (
                          <p>{activeRun.prompt}</p>
                        )}
                        <small>Approved intent; this is not proof that an action occurred.</small>
                      </section>
                      <section className="evidence-executed">
                        <strong>Executed evidence</strong>
                        {primaryExecutionEvents.length > 0 ? (
                          <ol className="evidence-timeline">
                            {primaryExecutionEvents.map((event) => (
                              <li key={event.id} className={"evidence-event evidence-" + event.kind}>
                                <span className="evidence-marker" aria-hidden="true" />
                                <div>
                                  <p>{eventDescription(event)}</p>
                                  <details>
                                    <summary>Technical details</summary>
                                    <dl>
                                      <div><dt>Source</dt><dd>{event.technical.source}</dd></div>
                                      <div><dt>Item type</dt><dd>{event.technical.itemType}</dd></div>
                                      {event.technical.exitCode !== undefined && (
                                        <div><dt>Exit code</dt><dd>{event.technical.exitCode}</dd></div>
                                      )}
                                      {event.technical.command && (
                                        <div><dt>Command</dt><dd><code>{event.technical.command}</code></dd></div>
                                      )}
                                    </dl>
                                  </details>
                                </div>
                              </li>
                            ))}
                          </ol>
                        ) : (
                          <p className="evidence-not-observed">Not observed</p>
                        )}
                        {genericCommandEvents.length > 0 && (
                          <details className="evidence-command-log">
                            <summary>
                              Technical command evidence ({genericCommandEvents.length})
                            </summary>
                            <ol>
                              {genericCommandEvents.map((event) => (
                                <li key={"technical-" + event.id}>
                                  <code>
                                    {event.technical.command ?? "Unclassified command"}
                                  </code>
                                  {event.technical.exitCode !== undefined && (
                                    <span>Exit code {event.technical.exitCode}</span>
                                  )}
                                </li>
                              ))}
                            </ol>
                          </details>
                        )}
                        <p className="evidence-net-state-note">
                          Workspace changes show the resulting PRE/POST state. Transient
                          writes restored before completion are not shown.
                        </p>
                      </section>
                      <div className="evidence-summary">
                        <div>
                          <span>Changed files</span>
                          <strong>
                            {changedFilesLabel(
                              executionEvents,
                              activeRun.workspaceDiffStatus,
                            )}
                          </strong>
                          {workspaceMutationEvents.length > 0 && (
                            <details className="changed-file-details">
                              <summary>View files</summary>
                              {(["create", "modify", "delete"] as const).map(
                                (kind) => {
                                  const paths = workspaceMutationEvents
                                    .filter((event) => event.kind === kind)
                                    .map((event) => event.path)
                                    .filter((value): value is string => Boolean(value));
                                  return paths.length > 0 ? (
                                    <section key={kind}>
                                      <b>
                                        {kind === "create"
                                          ? "Created"
                                          : kind === "modify"
                                            ? "Modified"
                                            : "Deleted"}
                                      </b>
                                      <ul>
                                        {paths.map((workspacePath) => (
                                          <li key={kind + "-" + workspacePath}>
                                            <code>{workspacePath}</code>
                                          </li>
                                        ))}
                                      </ul>
                                    </section>
                                  ) : null;
                                },
                              )}
                            </details>
                          )}
                          {activeRun.workspaceDiffStatus === "partial" && (
                            <small>Partial manifest coverage.</small>
                          )}
                        </div>
                        <div>
                          <span>Verification</span>
                          <strong>{verificationStatus(executionEvents)}</strong>
                        </div>
                        <div>
                          <span>Authority blocks</span>
                          <strong>
                            {executionEvents.some((event) => event.kind === "blocked")
                              ? String(executionEvents.filter((event) => event.kind === "blocked").length)
                              : "Not observed"}
                          </strong>
                        </div>
                      </div>
                    </article>
                  )}
                {activeRun?.status === "failed" && (
                  <article className="run-error">
                    <strong>Run failed</strong>
                    <span>{activeRun.error}</span>
                  </article>
                )}
                <div ref={messageEnd} />
              </div>

              <form className="composer" onSubmit={sendMessage}>
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder={
                    selected.status === "stopped"
                      ? "Start this Agent to continue…"
                      : "Describe what you want the Agent to do…"
                  }
                  disabled={
                    selected.status === "stopped" ||
                    selected.status === "busy" ||
                    activeRun != null &&
                    ["awaiting_approval", "queued", "running"].includes(activeRun.status)
                  }
                  rows={3}
                />
                <div className="composer-footer">
                  <span>
                    Enter to send · Shift + Enter for newline · {system?.codexSandboxMode ?? "checking sandbox"}
                  </span>
                  <button
                    className="send-button"
                    disabled={
                      !prompt.trim() ||
                      selected.status === "stopped" ||
                      selected.status === "busy" ||
                      (activeRun != null &&
                        ["awaiting_approval", "queued", "running"].includes(activeRun.status))
                    }
                    aria-label="Send message"
                  >
                    ↑
                  </button>
                </div>
              </form>
            </section>
          </>
        ) : (
          <div className="no-agent">
            <div className="no-agent-art">A</div>
            <span className="eyebrow">Agent Launchpad</span>
            <h1>Your runtime is ready for an Agent.</h1>
            <p>Create a workspace, give Codex a job, and continue the conversation here.</p>
            <button
              className="button button-primary"
              onClick={() => {
                setForm(emptyForm);
                setShowCreate(true);
              }}
            >
              Create your first Agent
            </button>
          </div>
        )}
      </main>

      {showCreate && (
        <div className="modal-backdrop" onMouseDown={() => setShowCreate(false)}>
          <form
            className="modal"
            onSubmit={createAgent}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">New workspace</span>
                <h2>Create an Agent</h2>
                <p>Each Agent gets a persistent folder and a resumable Codex session.</p>
              </div>
              <button type="button" onClick={() => setShowCreate(false)}>×</button>
            </div>
            <label>
              Name
              <input
                autoFocus
                placeholder="Frontend Builder"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                required
                maxLength={80}
              />
            </label>
            <label>
              Description
              <input
                placeholder="Builds polished React prototypes"
                value={form.description}
                onChange={(event) =>
                  setForm({ ...form, description: event.target.value })
                }
                maxLength={500}
              />
            </label>
            <label>
              Instructions
              <textarea
                value={form.instructions}
                onChange={(event) =>
                  setForm({ ...form, instructions: event.target.value })
                }
                rows={6}
                maxLength={10_000}
              />
            </label>
            <div className="modal-footer">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setShowCreate(false)}
              >
                Cancel
              </button>
              <button className="button button-primary" disabled={busy}>
                {busy ? <Spinner /> : "Create Agent"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
