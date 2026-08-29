import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWorkspaceMountArgs } from "./container-codex-runner.js";

const execFileAsync = promisify(execFile);
const integrationRequired = process.env.AGENTGUARD_CONTAINER_INTEGRATION === "1";
const containerEngine = process.env.CONTAINER_ENGINE ?? "docker";
const runtimeImage = process.env.AGENTGUARD_RUNTIME_IMAGE ?? "volc-agent-runtime:local";

describe.skipIf(!integrationRequired)("AgentGuard container filesystem enforcement", () => {
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

    workspacePath = await mkdtemp(path.join(tmpdir(), "agentguard-integration-"));
    await mkdir(path.join(workspacePath, "src"));
    await mkdir(path.join(workspacePath, "deployment"));
    await writeFile(path.join(workspacePath, ".env"), "SECRET_VALUE=ORIGINAL\n");
    await writeFile(
      path.join(workspacePath, "src", "allowed.ts"),
      'export const value = "ORIGINAL";\n',
    );
    await writeFile(
      path.join(workspacePath, "deployment", "config.yml"),
      "environment: production\n",
    );
  }, 30_000);

  afterAll(async () => {
    if (workspacePath) await rm(workspacePath, { recursive: true, force: true });
  });

  it(
    "allows src writes and blocks shell, Node, Python, delete, and replace bypasses",
    async () => {
      const mountArgs = buildWorkspaceMountArgs({
        agentId: "agentguard-integration",
        workspacePath,
        prompt: "deterministic filesystem probe",
        threadId: null,
      });
      const script = String.raw`
set -eu
printf 'export const value = "MODIFIED";\n' > /workspace/src/allowed.ts

if sh -c "printf 'SECRET_VALUE=SHELL\n' > /workspace/.env"; then exit 11; fi
if sh -c "printf 'environment: shell\n' > /workspace/deployment/config.yml"; then exit 12; fi

node -e "require('node:fs').writeFileSync('/workspace/src/allowed.ts', 'NODE\\n')"
if node -e "require('node:fs').writeFileSync('/workspace/.env', 'SECRET_VALUE=NODE\\n')"; then exit 13; fi
if node -e "require('node:fs').writeFileSync('/workspace/deployment/config.yml', 'environment: node\\n')"; then exit 14; fi

python3 -c "open('/workspace/src/allowed.ts', 'w').write('PYTHON\\n')"
if python3 -c "open('/workspace/.env', 'w').write('SECRET_VALUE=PYTHON\\n')"; then exit 15; fi
if python3 -c "open('/workspace/deployment/config.yml', 'w').write('environment: python\\n')"; then exit 16; fi

printf 'SECRET_VALUE=REPLACEMENT\n' > /workspace/.env.replacement
if mv -f /workspace/.env.replacement /workspace/.env; then exit 17; fi
rm -f /workspace/.env.replacement
if rm -f /workspace/.env; then exit 18; fi
printf 'environment: replacement\n' > /workspace/config.replacement
if mv -f /workspace/config.replacement /workspace/deployment/config.yml; then exit 19; fi
rm -f /workspace/config.replacement
if rm -rf /workspace/deployment; then exit 20; fi
printf 'export const value = "MODIFIED";\n' > /workspace/src/allowed.ts
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
        readFile(path.join(workspacePath, "src", "allowed.ts"), "utf8"),
      ).resolves.toBe('export const value = "MODIFIED";\n');
      await expect(readFile(path.join(workspacePath, ".env"), "utf8")).resolves.toBe(
        "SECRET_VALUE=ORIGINAL\n",
      );
      await expect(
        readFile(path.join(workspacePath, "deployment", "config.yml"), "utf8"),
      ).resolves.toBe("environment: production\n");
    },
    30_000,
  );
});
