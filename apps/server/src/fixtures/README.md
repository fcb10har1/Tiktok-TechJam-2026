# Codex Runtime protocol fixture

`codex-0.111.0-events.jsonl` was captured from the local
`volc-agent-runtime:local` Docker image running `codex-cli 0.111.0` on
2026-08-30.

The fixture retains only bounded protocol fields needed by the deterministic
translator. Prompts, reasoning, agent-message text, credentials, environment
values, provider payloads, and unbounded command output were not retained.
Test output was replaced with a fixed marker.

In this capture, workspace writes were emitted as `command_execution` items;
no `file_change` item was observed. The two read-only write probes emitted the
expected filesystem errors, but the model appended `|| true`, so their outer
command exit codes were zero. They are regression fixtures for the conservative
`warning` behavior and must not be classified as authority `blocked` events.
