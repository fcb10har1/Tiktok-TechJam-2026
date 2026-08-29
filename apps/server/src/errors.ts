import type { RunEvent } from "./types.js";

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class RunCancelledError extends Error {
  constructor() {
    super("Run cancelled");
    this.name = "RunCancelledError";
  }
}

export class RunExecutionError extends Error {
  constructor(
    message: string,
    public readonly events: RunEvent[],
  ) {
    super(message);
    this.name = "RunExecutionError";
  }
}

export function sanitizedRunnerFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /^(?:Codex|Runtime) timed out after \d+ ms$/.test(message) ||
    message === "Codex output exceeded CODEX_MAX_OUTPUT_BYTES" ||
    message === "Codex completed without an agent message"
  ) {
    return message;
  }
  const exitCode = message.match(/(?:Codex|Runtime) exited with code (\d+)/)?.[1];
  return exitCode
    ? "Runtime execution failed with exit code " + exitCode
    : "Runtime execution failed";
}
