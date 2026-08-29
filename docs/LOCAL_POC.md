# Local POC

The local profile runs the React/Fastify control plane on macOS or Linux and
starts every Codex turn in a disposable Docker, Colima, or Podman container.
Only the Volcengine Ark model API is remote.

## Start

Requirements:

- Node.js 22+
- Docker, Colima, or Podman
- An Ark API key and Responses-capable endpoint

```bash
ARK_API_KEY=your-ark-api-key ARK_MODEL=ep-your-endpoint-id npm run poc
```

Open <http://localhost:3000>. Press `Ctrl+C` to stop the server and remove this
instance's remaining Runtime containers.

Force an engine with `CONTAINER_ENGINE=docker` or
`CONTAINER_ENGINE=podman`. Colima uses the Docker CLI.

## Data and Runtime

Persistent state defaults to:

- macOS: `~/.volc-agent-launchpad/`
- Linux: `.local/`

Set `LOCAL_POC_DATA_ROOT` to use another directory.

Each turn mounts only the selected Agent workspace and Codex session directory.
Default limits are 2 CPUs, 2 GiB memory, 256 processes, dropped capabilities,
and `no-new-privileges`.

Codex requests `workspace-write`. If the Linux kernel lacks Landlock, startup
warns and disables only the inner Codex sandbox. The outer container limits
remain active, but this fallback is not tenant isolation.

## Rootless Podman on Linux

This path requires no Docker or Compose. It supports Ubuntu 22.04/24.04, Debian
12, and veLinux 2.

Install Podman:

```bash
sudo apt-get update
sudo apt-get install -y podman uidmap slirp4netns fuse-overlayfs
```

Install Node.js 22 if needed. Inspect the downloaded setup script before
running it:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x \
  -o /tmp/nodesource_setup_22.sh
less /tmp/nodesource_setup_22.sh
sudo -E bash /tmp/nodesource_setup_22.sh
sudo apt-get install -y nodejs
```

Check subordinate UID/GID ranges:

```bash
grep "^$USER:" /etc/subuid
grep "^$USER:" /etc/subgid
```

If both are missing, assign unused ranges and log in again:

```bash
sudo usermod --add-subuids 100000-165535 "$USER"
sudo usermod --add-subgids 100000-165535 "$USER"
```

Verify rootless Podman:

```bash
podman info
podman run --rm docker.io/library/alpine:3.20 echo PODMAN_OK
```

`podman info` must report `rootless: true`. Start the POC:

```bash
CONTAINER_ENGINE=podman \
ARK_API_KEY=your-ark-api-key \
ARK_MODEL=ep-your-endpoint-id \
npm run poc
```

This flow was verified on veLinux 2 with rootless Podman 4.3.1. A `vfs` storage
driver works but needs more disk space; keep at least 5 GiB free for a cold
build.

## Common options

```bash
CONTAINER_RUNTIME_APT_PACKAGES='ca-certificates git ripgrep python3 build-essential' \
ARK_API_KEY=your-ark-api-key \
ARK_MODEL=ep-your-endpoint-id \
npm run poc
```

For restricted networks, configure:

- `CONTAINER_RUNTIME_BASE_IMAGE`
- `CONTAINER_APT_MIRROR`
- `CONTAINER_APT_SECURITY_MIRROR`

Resource limits are controlled by `CONTAINER_CPU_LIMIT`,
`CONTAINER_MEMORY_LIMIT`, and `CONTAINER_PIDS_LIMIT`.

## Runtime write authority

For approved V1 Execution Contracts, the local container mounts the Agent
workspace read-only and adds read-write bind mounts only for the approved
`writablePaths`. Explicit `protectedPaths` are mounted read-only last, so the
precedence is:

```text
protected paths > writable paths > default read-only
```

A terminal `/**` denotes a directory subtree. For example, `src/**` authorizes
creation, modification, rename, and deletion below `src`, while unrelated root
files remain read-only. Existing directory paths are also treated as subtree
scopes. If an approved `/**` root is absent, the trusted control plane creates
that exact directory before launch. An absent exact path such as `package.json`
is prepared as an empty file and mounted individually; its siblings remain
read-only. Every prepared target is recorded on the Run with
`existedBeforeRun: false`.
For a missing nested target, its parent directory must already exist; the
control plane never creates or grants an unapproved parent scope implicitly.

A missing protected descendant inside a writable directory is prepared using
the same explicit syntax—`path/**` for a directory or an exact path for a
file—then overlaid read-only. Missing protected paths outside writable authority
need no placeholder because their parent is already read-only.

Exact-file mounts support ordinary direct writes and truncation. Tools that save
by creating a sibling temporary file and renaming it over the mounted file can
fail with `EBUSY` because the file itself is a bind-mount point. Prefer directory
scopes for normal app-building work. A future production design can use a
staging workspace or OverlayFS for transparent atomic replacement and
transactional commits; this POC intentionally does not provide staging or
rollback.

The guarantee applies to the container's `/workspace` tree. It does not claim
equivalent enforcement for the local-process Runtime, host administrators, or
other host processes with direct access to the workspace.

The ordinary test suite skips the Docker probe. Run it mandatorily with:

```bash
AGENTGUARD_CONTAINER_INTEGRATION=1 \
AGENTGUARD_RUNTIME_IMAGE=volc-agent-runtime:local \
npm run test -w @launchpad/server -- \
src/container-codex-runner.integration.test.ts
```

With the integration flag set, an unavailable Runtime or a failed enforcement
assertion fails the test instead of skipping it.

## Troubleshooting

Check Runtime readiness:

```bash
docker info                       # Or: podman info
docker image inspect volc-agent-runtime:local
curl http://localhost:3000/api/system
```

If a bind mount is rejected, set `LOCAL_POC_DATA_ROOT` to a directory shared
with the container VM. On Linux, the startup script automatically uses the host
UID/GID and validates workspace write access.

Remove only the default Runtime image:

```bash
podman image rm volc-agent-runtime:local
```
