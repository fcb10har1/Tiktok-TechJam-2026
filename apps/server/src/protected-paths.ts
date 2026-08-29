import path from "node:path";

export const DEFAULT_PROTECTED_PATHS = [".env", "deployment"] as const;

export class InvalidProtectedPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidProtectedPathError";
  }
}

export function normalizeProtectedPaths(paths: readonly string[]): string[] {
  const byRoot = new Map<string, string>();
  for (const normalizedPath of normalizeWorkspacePaths(paths, "Protected")) {
    const root = workspaceScopeRoot(normalizedPath);
    const existing = byRoot.get(root);
    if (!existing || (isDirectoryScope(normalizedPath) && !isDirectoryScope(existing))) {
      byRoot.set(root, normalizedPath);
    }
  }
  const normalizedPaths = [...byRoot.values()];
  return normalizedPaths.filter(
    (candidatePath) =>
      !normalizedPaths.some(
        (parentPath) =>
          workspaceScopeRoot(parentPath) !== workspaceScopeRoot(candidatePath) &&
          isPathInsideScope(candidatePath, parentPath),
      ),
  );
}

export function normalizeWritablePaths(paths: readonly string[]): string[] {
  const byRoot = new Map<string, string>();
  for (const normalizedPath of normalizeWorkspacePaths(paths, "Writable")) {
    const root = workspaceScopeRoot(normalizedPath);
    const existing = byRoot.get(root);
    if (!existing || (isDirectoryScope(normalizedPath) && !isDirectoryScope(existing))) {
      byRoot.set(root, normalizedPath);
    }
  }
  const normalizedPaths = [...byRoot.values()];
  return normalizedPaths.filter(
    (candidatePath) =>
      !normalizedPaths.some(
        (parentPath) =>
          parentPath !== candidatePath &&
          isDirectoryScope(parentPath) &&
          isPathInsideScope(candidatePath, parentPath),
      ),
  );
}

export function isDirectoryScope(workspacePath: string): boolean {
  return workspacePath.endsWith("/**");
}

export function workspaceScopeRoot(workspacePath: string): string {
  return isDirectoryScope(workspacePath) ? workspacePath.slice(0, -3) : workspacePath;
}

export function isPathInsideScope(candidatePath: string, scopePath: string): boolean {
  const candidateRoot = workspaceScopeRoot(candidatePath);
  const scopeRoot = workspaceScopeRoot(scopePath);
  return candidateRoot === scopeRoot || candidateRoot.startsWith(scopeRoot + "/");
}

function normalizeWorkspacePaths(
  paths: readonly string[],
  pathKind: "Protected" | "Writable",
): string[] {
  if (paths.length > 100) {
    throw new InvalidProtectedPathError(
      "At most 100 " + pathKind.toLowerCase() + " paths are allowed",
    );
  }

  const normalizedPaths: string[] = [];
  const seen = new Set<string>();
  for (const rawPath of paths) {
    const workspacePath = rawPath.trim();
    if (!workspacePath || workspacePath.length > 512) {
      throw new InvalidProtectedPathError(
        pathKind + " paths must contain between 1 and 512 characters",
      );
    }
    const directoryScope =
      workspacePath.endsWith("/**") ||
      (pathKind === "Writable" && workspacePath.endsWith("/"));
    const pathWithoutScope = workspacePath.endsWith("/**")
      ? workspacePath.slice(0, -3)
      : workspacePath;
    if (
      path.posix.isAbsolute(pathWithoutScope) ||
      pathWithoutScope.includes("\\") ||
      pathWithoutScope.includes(",") ||
      /[\u0000-\u001f\u007f]/.test(pathWithoutScope) ||
      pathWithoutScope.split("/").includes("..")
    ) {
      throw new InvalidProtectedPathError(
        pathKind +
          " path must be a workspace-relative POSIX path: " +
          workspacePath,
      );
    }
    if (/[*?[\]{}]/.test(pathWithoutScope)) {
      throw new InvalidProtectedPathError(
        pathKind +
          " path contains unsupported glob syntax; only a terminal /** is allowed: " +
          workspacePath,
      );
    }

    const normalizedRoot = path.posix.normalize(pathWithoutScope).replace(/\/+$/, "");
    if (normalizedRoot === "." || normalizedRoot.startsWith("../")) {
      throw new InvalidProtectedPathError(
        pathKind + " path escapes the workspace: " + workspacePath,
      );
    }
    const normalizedPath = normalizedRoot + (directoryScope ? "/**" : "");
    if (seen.has(normalizedPath)) {
      continue;
    }
    seen.add(normalizedPath);
    normalizedPaths.push(normalizedPath);
  }

  return normalizedPaths;
}
