import path from "node:path";

export const DEFAULT_PROTECTED_PATHS = [".env", "deployment"] as const;

export class InvalidProtectedPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidProtectedPathError";
  }
}

export function normalizeProtectedPaths(paths: readonly string[]): string[] {
  const normalizedPaths = normalizeWorkspacePaths(paths, "Protected", true);
  return normalizedPaths.filter(
    (candidatePath) =>
      !normalizedPaths.some(
        (parentPath) =>
          parentPath !== candidatePath &&
          candidatePath.startsWith(parentPath + "/"),
      ),
  );
}

export function normalizeWritablePaths(paths: readonly string[]): string[] {
  return normalizeWorkspacePaths(paths, "Writable", false);
}

function normalizeWorkspacePaths(
  paths: readonly string[],
  pathKind: "Protected" | "Writable",
  canonicalizeProtectedPath: boolean,
): string[] {
  if (paths.length > 100) {
    throw new InvalidProtectedPathError(
      "At most 100 " + pathKind.toLowerCase() + " paths are allowed",
    );
  }

  const normalizedPaths: string[] = [];
  const seen = new Set<string>();
  for (const rawPath of paths) {
    const protectedPath = rawPath.trim();
    if (!protectedPath || protectedPath.length > 512) {
      throw new InvalidProtectedPathError(
        pathKind + " paths must contain between 1 and 512 characters",
      );
    }
    if (
      path.posix.isAbsolute(protectedPath) ||
      protectedPath.includes("\\") ||
      protectedPath.includes(",") ||
      protectedPath.split("/").includes("..")
    ) {
      throw new InvalidProtectedPathError(
        pathKind +
          " path must be a workspace-relative POSIX path: " +
          protectedPath,
      );
    }

    const normalizedPath = canonicalizeProtectedPath
      ? path.posix.normalize(protectedPath).replace(/\/+$/, "")
      : path.posix.normalize(protectedPath);
    if (normalizedPath === "." || normalizedPath.startsWith("../")) {
      throw new InvalidProtectedPathError(
        pathKind + " path escapes the workspace: " + protectedPath,
      );
    }
    if (seen.has(normalizedPath)) {
      if (canonicalizeProtectedPath) continue;
      throw new InvalidProtectedPathError(
        "Duplicate " + pathKind.toLowerCase() + " path: " + normalizedPath,
      );
    }
    seen.add(normalizedPath);
    normalizedPaths.push(normalizedPath);
  }

  return normalizedPaths;
}
