import path from "node:path";

export const DEFAULT_PROTECTED_PATHS = [".env", "deployment"] as const;

export class InvalidProtectedPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidProtectedPathError";
  }
}

export function normalizeProtectedPaths(paths: readonly string[]): string[] {
  if (paths.length > 100) {
    throw new InvalidProtectedPathError("At most 100 protected paths are allowed");
  }

  const normalizedPaths: string[] = [];
  const seen = new Set<string>();
  for (const rawPath of paths) {
    const protectedPath = rawPath.trim();
    if (!protectedPath || protectedPath.length > 512) {
      throw new InvalidProtectedPathError(
        "Protected paths must contain between 1 and 512 characters",
      );
    }
    if (
      path.posix.isAbsolute(protectedPath) ||
      protectedPath.includes("\\") ||
      protectedPath.includes(",") ||
      protectedPath.split("/").includes("..")
    ) {
      throw new InvalidProtectedPathError(
        "Protected path must be a workspace-relative POSIX path: " + protectedPath,
      );
    }

    const normalizedPath = path.posix.normalize(protectedPath);
    if (normalizedPath === "." || normalizedPath.startsWith("../")) {
      throw new InvalidProtectedPathError(
        "Protected path escapes the workspace: " + protectedPath,
      );
    }
    if (seen.has(normalizedPath)) {
      throw new InvalidProtectedPathError("Duplicate protected path: " + normalizedPath);
    }
    seen.add(normalizedPath);
    normalizedPaths.push(normalizedPath);
  }

  return normalizedPaths;
}
