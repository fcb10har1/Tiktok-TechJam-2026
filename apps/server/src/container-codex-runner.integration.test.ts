import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWorkspaceMountArgs } from "./container-codex-runner.js";
import type { RunnerRequest } from "./types.js";
import { prepareWorkspaceAuthority } from "./workspace-authority.js";

const execFileAsync = promisify(execFile);
const integrationRequired = process.env.AGENTGUARD_CONTAINER_INTEGRATION === "1";
const containerEngine = process.env.CONTAINER_ENGINE ?? "docker";
const runtimeImage = process.env.AGENTGUARD_RUNTIME_IMAGE ?? "volc-agent-runtime:local";

describe.skipIf(!integrationRequired)("AgentGuard default-deny write authority", () => {
  let workspacePath = "";

  beforeAll(async () => {
    await execFileAsync(containerEngine, ["version"], { timeout: 10_000 });
    await execFileAsync(containerEngine, ["image", "inspect", runtimeImage], {
      timeout: 10_000,
    });
    await execFileAsync(
      containerEngine,
      [
        "run",
        "--rm",
        "--entrypoint",
        "sh",
        runtimeImage,
        "-c",
        "command -v node >/dev/null && command -v python3 >/dev/null",
      ],
      { timeout: 20_000 },
    );

    workspacePath = await mkdtemp(path.join(tmpdir(), "authority-integration-"));
    await mkdir(path.join(workspacePath, "src", "auth"), { recursive: true });
    await mkdir(path.join(workspacePath, "deployment"));
    await writeFile(path.join(workspacePath, ".env"), "SECRET_VALUE=ORIGINAL\n");
    await writeFile(path.join(workspacePath, "README.md"), "README ORIGINAL\n");
    await writeFile(path.join(workspacePath, "outside.ts"), "OUTSIDE ORIGINAL\n");
    await writeFile(
      path.join(workspacePath, "src", "auth", "login.ts"),
      'export const login = "ORIGINAL";\n',
    );
    await writeFile(
      path.join(workspacePath, "src", "auth", "secret.txt"),
      "AUTH SECRET ORIGINAL\n",
    );
    await writeFile(
      path.join(workspacePath, "deployment", "config.yml"),
      "environment: production\n",
    );
    await symlink("../../README.md", path.join(workspacePath, "src", "auth", "readme-link"));
  }, 30_000);

  afterAll(async () => {
    if (workspacePath) await rm(workspacePath, { recursive: true, force: true });
  });

  it(
    "enforces approved directory and exact-file authority with protected overrides",
    async () => {
      const authority = prepareWorkspaceAuthority({
        workspacePath,
        writablePaths: [
          "src/auth/**",
          "tests/**",
          "public/**",
          "package.json",
          "deployment/config.yml",
        ],
        protectedPaths: [
          ".env",
          "deployment/**",
          "src/auth/secret.txt",
          "src/auth/future-secret.txt",
        ],
      });
      expect(authority.preparations).toEqual([
        {
          path: "tests",
          kind: "directory",
          purpose: "writable",
          existedBeforeRun: false,
        },
        {
          path: "public",
          kind: "directory",
          purpose: "writable",
          existedBeforeRun: false,
        },
        {
          path: "package.json",
          kind: "file",
          purpose: "writable",
          existedBeforeRun: false,
        },
        {
          path: "src/auth/future-secret.txt",
          kind: "file",
          purpose: "protected",
          existedBeforeRun: false,
        },
      ]);
      expect(authority.plan.writableMounts.map((mount) => mount.path)).toEqual([
        "src/auth",
        "tests",
        "public",
        "package.json",
      ]);
      const request: RunnerRequest = {
        agentId: "authority-integration",
        workspacePath,
        prompt: "deterministic filesystem authority probe",
        threadId: null,
        writablePaths: authority.writablePaths,
        protectedPaths: authority.protectedPaths,
        authorityPlan: authority.plan,
      };
      const mountArgs = buildWorkspaceMountArgs(request, containerEngine);
      const script = String.raw`
set -eu

# Shell, Node, and Python writes inside approved directory authority.
printf 'SHELL\n' > /workspace/src/auth/login.ts
node -e "require('node:fs').writeFileSync('/workspace/src/auth/node.ts', 'NODE\\n')"
python3 -c "open('/workspace/src/auth/python.ts', 'w').write('PYTHON\\n')"
printf 'NEW DESCENDANT\n' > /workspace/src/auth/helper.ts

# Prepared greenfield roots and exact file.
printf 'TEST\n' > /workspace/tests/app.test.ts
printf 'PUBLIC\n' > /workspace/public/index.html
printf '{"name":"greenfield"}\n' > /workspace/package.json

# Default-deny modification and creation outside approved authority.
if sh -c "printf 'README MUTATED\n' > /workspace/README.md"; then exit 11; fi
if sh -c "printf 'SECRET_VALUE=MUTATED\n' > /workspace/.env"; then exit 12; fi
if sh -c "printf 'NEW SECRET\n' > /workspace/.env.production"; then exit 13; fi
if sh -c "printf 'RANDOM\n' > /workspace/random-root.txt"; then exit 14; fi
if rm -f /workspace/outside.ts; then exit 15; fi

# Replacement and traversal cannot escape an approved subtree.
printf 'REPLACEMENT\n' > /workspace/src/auth/replacement.tmp
if mv -f /workspace/src/auth/replacement.tmp /workspace/README.md; then exit 16; fi
rm -f /workspace/src/auth/replacement.tmp
if sh -c "cd /workspace/src/auth && printf 'TRAVERSAL\n' > ../../README.md"; then exit 17; fi
if sh -c "printf 'SYMLINK\n' > /workspace/src/auth/readme-link"; then exit 18; fi

# Protected children and parents override writable requests.
if sh -c "printf 'AUTH SECRET MUTATED\n' > /workspace/src/auth/secret.txt"; then exit 19; fi
if sh -c "printf 'environment: mutated\n' > /workspace/deployment/config.yml"; then exit 20; fi
if rm -f /workspace/src/auth/secret.txt; then exit 21; fi
if sh -c "printf 'FUTURE SECRET\n' > /workspace/src/auth/future-secret.txt"; then exit 25; fi

# Exact-file authority does not make its parent writable. Atomic replacement is limited.
if sh -c "printf '{}\n' > /workspace/package-lock.json"; then exit 22; fi
printf 'ATOMIC\n' > /tmp/package-replacement
if mv -f /tmp/package-replacement /workspace/package.json; then exit 23; fi

# A new hard link cannot cross from the read-only root mount into a writable mount.
if ln /workspace/README.md /workspace/src/auth/readme-hardlink; then exit 24; fi
`;
      const containerUser =
        typeof process.getuid === "function" && typeof process.getgid === "function"
          ? process.getuid() + ":" + process.getgid()
          : "1000:1000";

      await execFileAsync(
        containerEngine,
        [
          "run",
          "--rm",
          "--init",
          "--security-opt",
          "no-new-privileges",
          "--cap-drop",
          "ALL",
          "--user",
          containerUser,
          ...mountArgs,
          "--workdir",
          "/workspace",
          "--entrypoint",
          "sh",
          runtimeImage,
          "-c",
          script,
        ],
        { timeout: 30_000, maxBuffer: 1_048_576 },
      );

      await expect(
        readFile(path.join(workspacePath, "src", "auth", "login.ts"), "utf8"),
      ).resolves.toBe("SHELL\n");
      await expect(
        readFile(path.join(workspacePath, "src", "auth", "node.ts"), "utf8"),
      ).resolves.toBe("NODE\n");
      await expect(
        readFile(path.join(workspacePath, "src", "auth", "python.ts"), "utf8"),
      ).resolves.toBe("PYTHON\n");
      await expect(readFile(path.join(workspacePath, "package.json"), "utf8"))
        .resolves.toBe('{"name":"greenfield"}\n');
      await expect(readFile(path.join(workspacePath, "README.md"), "utf8")).resolves
        .toBe("README ORIGINAL\n");
      await expect(readFile(path.join(workspacePath, ".env"), "utf8")).resolves.toBe(
        "SECRET_VALUE=ORIGINAL\n",
      );
      await expect(readFile(path.join(workspacePath, "outside.ts"), "utf8")).resolves
        .toBe("OUTSIDE ORIGINAL\n");
      await expect(
        readFile(path.join(workspacePath, "src", "auth", "secret.txt"), "utf8"),
      ).resolves.toBe("AUTH SECRET ORIGINAL\n");
      await expect(
        readFile(
          path.join(workspacePath, "src", "auth", "future-secret.txt"),
          "utf8",
        ),
      ).resolves.toBe("");
      await expect(
        readFile(path.join(workspacePath, "deployment", "config.yml"), "utf8"),
      ).resolves.toBe("environment: production\n");
    },
    30_000,
  );
});
