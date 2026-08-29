import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  isDirectoryScope,
  isPathInsideScope,
  normalizeProtectedPaths,
  normalizeWritablePaths,
  workspaceScopeRoot,
} from "./protected-paths.js";
import type {
  AuthorityMount,
  AuthorityPreparation,
  AuthorityTargetKind,
  WorkspaceAuthorityPlan,
} from "./types.js";

export class WorkspaceAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceAuthorityError";
  }
}

export interface WorkspaceAuthorityInput {
  workspacePath: string;
  writablePaths: readonly string[];
  protectedPaths: readonly string[];
}

export interface PreparedWorkspaceAuthority {
  writablePaths: string[];
  protectedPaths: string[];
  preparations: AuthorityPreparation[];
  plan: WorkspaceAuthorityPlan;
}

export interface ValidatedWorkspaceAuthorityDraft {
  writablePaths: string[];
  protectedPaths: string[];
}

function isInsideWorkspace(workspacePath: string, candidatePath: string): boolean {
  const relative = path.relative(workspacePath, candidatePath);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== "..");
}

function targetPath(workspacePath: string, contractPath: string): string {
  return path.resolve(workspacePath, workspaceScopeRoot(contractPath));
}

function assertNoSymlinkComponents(
  workspacePath: string,
  contractPath: string,
  includeTarget: boolean,
): void {
  const components = workspaceScopeRoot(contractPath).split("/");
  const finalIndex = includeTarget ? components.length : components.length - 1;
  let currentPath = workspacePath;
  for (let index = 0; index < finalIndex; index += 1) {
    currentPath = path.join(currentPath, components[index]!);
    if (!existsSync(currentPath)) {
      throw new WorkspaceAuthorityError(
        "Authority target parent does not exist: " + contractPath,
      );
    }
    if (lstatSync(currentPath).isSymbolicLink()) {
      throw new WorkspaceAuthorityError(
        "Authority target traverses a symbolic link: " + contractPath,
      );
    }
  }
}

function assertNoExistingSymlinkComponents(
  workspacePath: string,
  contractPath: string,
): void {
  const components = workspaceScopeRoot(contractPath).split("/");
  let currentPath = workspacePath;
  for (const component of components) {
    currentPath = path.join(currentPath, component);
    if (!existsSync(currentPath)) return;
    if (lstatSync(currentPath).isSymbolicLink()) {
      throw new WorkspaceAuthorityError(
        "Authority target traverses a symbolic link: " + contractPath,
      );
    }
  }
}

function targetKind(contractPath: string, sourcePath: string): AuthorityTargetKind {
  const stats = lstatSync(sourcePath);
  if (stats.isSymbolicLink()) {
    throw new WorkspaceAuthorityError(
      "Declared authority target cannot be a symbolic link: " + contractPath,
    );
  }
  if (isDirectoryScope(contractPath)) {
    if (!stats.isDirectory()) {
      throw new WorkspaceAuthorityError(
        "Directory scope does not resolve to a directory: " + contractPath,
      );
    }
    return "directory";
  }
  if (stats.isDirectory()) return "directory";
  if (stats.isFile()) return "file";
  throw new WorkspaceAuthorityError(
    "Authority target must be a regular file or directory: " + contractPath,
  );
}

function resolveMount(
  canonicalWorkspacePath: string,
  contractPath: string,
): AuthorityMount {
  assertNoSymlinkComponents(canonicalWorkspacePath, contractPath, true);
  const candidatePath = targetPath(canonicalWorkspacePath, contractPath);
  const sourcePath = realpathSync(candidatePath);
  if (!isInsideWorkspace(canonicalWorkspacePath, sourcePath)) {
    throw new WorkspaceAuthorityError(
      "Authority target resolves outside the workspace: " + contractPath,
    );
  }
  return {
    path: workspaceScopeRoot(contractPath),
    sourcePath,
    kind: targetKind(contractPath, candidatePath),
  };
}

function prepareMissingTarget(
  canonicalWorkspacePath: string,
  contractPath: string,
  purpose: "writable" | "protected",
): AuthorityPreparation[] {
  const preparations: AuthorityPreparation[] = [];
  assertNoSymlinkComponents(canonicalWorkspacePath, contractPath, false);
  const candidatePath = targetPath(canonicalWorkspacePath, contractPath);
  const parentPath = realpathSync(path.dirname(candidatePath));
  if (!isInsideWorkspace(canonicalWorkspacePath, parentPath)) {
    throw new WorkspaceAuthorityError(
      "Authority target parent resolves outside the workspace: " + contractPath,
    );
  }
  const kind: AuthorityTargetKind = isDirectoryScope(contractPath)
    ? "directory"
    : "file";
  if (kind === "directory") {
    mkdirSync(candidatePath, { mode: 0o700 });
  } else {
    writeFileSync(candidatePath, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
  }
  preparations.push({
    path: workspaceScopeRoot(contractPath),
    kind,
    purpose,
    existedBeforeRun: false,
  });
  return preparations;
}

function removeRedundantWritableMounts(mounts: AuthorityMount[]): AuthorityMount[] {
  return mounts.filter(
    (candidate) =>
      !mounts.some(
        (parent) =>
          parent !== candidate &&
          parent.kind === "directory" &&
          parent.path !== candidate.path &&
          candidate.path.startsWith(parent.path + "/"),
      ),
  );
}

function assertNoUnsafeWritableEntries(
  mount: AuthorityMount,
  protectedMounts: readonly AuthorityMount[],
): void {
  const visit = (sourcePath: string, relativePath: string): void => {
    if (
      protectedMounts.some(
        (protectedMount) =>
          relativePath === protectedMount.path ||
          relativePath.startsWith(protectedMount.path + "/"),
      )
    ) {
      return;
    }
    const stats = lstatSync(sourcePath);
    if (stats.isSymbolicLink()) return;
    if (stats.isFile()) {
      if (stats.nlink > 1) {
        throw new WorkspaceAuthorityError(
          "Writable authority contains a hard-linked file: " + relativePath,
        );
      }
      return;
    }
    if (!stats.isDirectory()) {
      throw new WorkspaceAuthorityError(
        "Writable authority contains an unsupported special file: " + relativePath,
      );
    }
    for (const entry of readdirSync(sourcePath, { withFileTypes: true })) {
      visit(path.join(sourcePath, entry.name), relativePath + "/" + entry.name);
    }
  };

  visit(mount.sourcePath, mount.path);
}

function normalizedInput(input: WorkspaceAuthorityInput): {
  canonicalWorkspacePath: string;
  writablePaths: string[];
  protectedPaths: string[];
} {
  const canonicalWorkspacePath = realpathSync(path.resolve(input.workspacePath));
  if (!lstatSync(canonicalWorkspacePath).isDirectory()) {
    throw new WorkspaceAuthorityError("Agent workspace is not a directory");
  }
  return {
    canonicalWorkspacePath,
    writablePaths: normalizeWritablePaths(input.writablePaths),
    protectedPaths: normalizeProtectedPaths(input.protectedPaths),
  };
}

function compileNormalizedAuthority(
  canonicalWorkspacePath: string,
  writablePaths: readonly string[],
  protectedPaths: readonly string[],
): WorkspaceAuthorityPlan {
  const effectiveWritablePaths = writablePaths.filter(
    (writablePath) =>
      !protectedPaths.some((protectedPath) =>
        isPathInsideScope(writablePath, protectedPath),
      ),
  );
  const writableMounts = removeRedundantWritableMounts(
    effectiveWritablePaths.map((writablePath) => {
      const candidatePath = targetPath(canonicalWorkspacePath, writablePath);
      if (!existsSync(candidatePath)) {
        throw new WorkspaceAuthorityError(
          "Approved writable target does not exist: " + writablePath,
        );
      }
      return resolveMount(canonicalWorkspacePath, writablePath);
    }),
  );
  const protectedMounts = protectedPaths.flatMap((protectedPath) => {
    const candidatePath = targetPath(canonicalWorkspacePath, protectedPath);
    return existsSync(candidatePath)
      ? [resolveMount(canonicalWorkspacePath, protectedPath)]
      : [];
  });

  for (const writableMount of writableMounts) {
    assertNoUnsafeWritableEntries(writableMount, protectedMounts);
  }
  return {
    workspaceSourcePath: canonicalWorkspacePath,
    writableMounts,
    protectedMounts,
  };
}

function validateDraftTarget(
  canonicalWorkspacePath: string,
  contractPath: string,
  allowMissingParent: boolean,
): AuthorityMount | null {
  const candidatePath = targetPath(canonicalWorkspacePath, contractPath);
  if (existsSync(candidatePath)) {
    return resolveMount(canonicalWorkspacePath, contractPath);
  }
  if (allowMissingParent) {
    assertNoExistingSymlinkComponents(canonicalWorkspacePath, contractPath);
    return null;
  }
  assertNoSymlinkComponents(canonicalWorkspacePath, contractPath, false);
  const parentPath = realpathSync(path.dirname(candidatePath));
  if (!isInsideWorkspace(canonicalWorkspacePath, parentPath)) {
    throw new WorkspaceAuthorityError(
      "Authority target parent resolves outside the workspace: " + contractPath,
    );
  }
  return null;
}

export function validateWorkspaceAuthorityDraft(
  input: WorkspaceAuthorityInput,
): ValidatedWorkspaceAuthorityDraft {
  const normalized = normalizedInput(input);
  const protectedMounts = normalized.protectedPaths.flatMap((protectedPath) => {
    const mount = validateDraftTarget(
      normalized.canonicalWorkspacePath,
      protectedPath,
      true,
    );
    return mount ? [mount] : [];
  });
  const writableMounts = removeRedundantWritableMounts(
    normalized.writablePaths.flatMap((writablePath) => {
      if (
        normalized.protectedPaths.some((protectedPath) =>
          isPathInsideScope(writablePath, protectedPath),
        )
      ) {
        return [];
      }
      const mount = validateDraftTarget(
        normalized.canonicalWorkspacePath,
        writablePath,
        false,
      );
      return mount ? [mount] : [];
    }),
  );
  for (const writableMount of writableMounts) {
    assertNoUnsafeWritableEntries(writableMount, protectedMounts);
  }
  return {
    writablePaths: normalized.writablePaths,
    protectedPaths: normalized.protectedPaths,
  };
}

export function compileWorkspaceAuthority(
  input: WorkspaceAuthorityInput,
): WorkspaceAuthorityPlan {
  const normalized = normalizedInput(input);
  return compileNormalizedAuthority(
    normalized.canonicalWorkspacePath,
    normalized.writablePaths,
    normalized.protectedPaths,
  );
}

export function prepareWorkspaceAuthority(
  input: WorkspaceAuthorityInput,
): PreparedWorkspaceAuthority {
  const normalized = normalizedInput(input);
  const preparations: AuthorityPreparation[] = [];
  const effectiveWritablePaths = normalized.writablePaths.filter(
    (writablePath) =>
      !normalized.protectedPaths.some((protectedPath) =>
        isPathInsideScope(writablePath, protectedPath),
      ),
  );

  for (const writablePath of effectiveWritablePaths) {
    const candidatePath = targetPath(normalized.canonicalWorkspacePath, writablePath);
    if (!existsSync(candidatePath)) {
      preparations.push(
        ...prepareMissingTarget(
          normalized.canonicalWorkspacePath,
          writablePath,
          "writable",
        ),
      );
    }
  }

  const writableMounts = removeRedundantWritableMounts(
    effectiveWritablePaths.map((writablePath) =>
      resolveMount(normalized.canonicalWorkspacePath, writablePath),
    ),
  );
  for (const protectedPath of normalized.protectedPaths) {
    const candidatePath = targetPath(normalized.canonicalWorkspacePath, protectedPath);
    const needsPlaceholder = writableMounts.some(
      (writableMount) =>
        writableMount.kind === "directory" &&
        (workspaceScopeRoot(protectedPath) === writableMount.path ||
          workspaceScopeRoot(protectedPath).startsWith(writableMount.path + "/")),
    );
    if (!existsSync(candidatePath) && needsPlaceholder) {
      preparations.push(
        ...prepareMissingTarget(
          normalized.canonicalWorkspacePath,
          protectedPath,
          "protected",
        ),
      );
    }
  }

  return {
    writablePaths: normalized.writablePaths,
    protectedPaths: normalized.protectedPaths,
    preparations,
    plan: compileNormalizedAuthority(
      normalized.canonicalWorkspacePath,
      normalized.writablePaths,
      normalized.protectedPaths,
    ),
  };
}
