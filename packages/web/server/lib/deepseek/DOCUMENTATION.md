# DeepSeek Harness

## Ownership

This module connects OpenChamber to DeepSeek Harness. Shared-host mode attaches
to the running Harness desktop host; ACP mode owns a separate subprocess for
legacy OpenChamber conversations. `routes.js` selects the owner and maintains
OpenCode index records. The shared UI, desktop, hosted mobile and Capacitor use
the same authenticated server routes. VS Code does not advertise this provider.

`host-discovery.mjs` runs as a Harness plugin and publishes its authenticated
loopback URL to a private file. `host-connection.js` owns that credential, the
API peer, HTTP calls, multiplexed streams and reconnect. `host-runtime.js` owns
session membership, followed histories and index reconciliation.
`host-transcript.js` maps durable events and live assistant frames to records;
`wire.js` maps records to OpenCode's UI vocabulary. The ACP files retain their
existing subprocess, persistence and permission ownership.

`DEEPSEEK_HOST_FILE` selects shared-host mode. The setup script installs the
plugin into the user's configuration and saves `hostFile` in `deepseek.json`;
the packaged desktop launcher loads it. `DEEPSEEK_DSH_BIN`,
`DEEPSEEK_DSH_ARGS`, `DEEPSEEK_PROVIDER` and `DEEPSEEK_MODEL` configure ACP and
the advertised model. New shared chats select the configured model. Existing
Harness chats retain their own runtime and model selection.

## Invariants

- Harness is authoritative for shared chat history, titles and running status.
  OpenCode holds index records so existing sidebar pagination and folders work.
  Workspace membership and row order come from `workspace/follow`; cwd stays
  the execution directory, never the grouping authority. Unassigned chats use
  the Ungrouped list, and blank drafts stay out of the sidebar.
  Only root chats are indexed; `origin: subagent` records remain in their parent
  chat's tool output. Ordinary forks remain distinct chats.
- Host IDs map deterministically to native IDs. Legacy ACP bindings retain their
  original native IDs. Dispatch waits for shared-host ownership and never starts
  ACP as a fallback for a disconnected shared chat.
- Index failures retry without clearing successful rows. Index metadata writes
  use the existing serialized metadata store, preserving concurrent user edits.
  Project registration upserts exact Harness workspace paths and labels through
  the settings write queue without changing
  the active project. Clients refresh settings after a new project is added.
- Shared history never resumes a second agent. Requested subscriptions survive
  host reconnects. Old generations and replaced subscriptions cannot publish
  late results. A broken stream is canceled and retried from a fresh baseline.
- User request IDs survive history conversion, allowing optimistic UI messages
  to reconcile. Text, tool calls and results retain their parent step identities.
- The connection file is owned by this OS user, mode 0600, under a private
  directory. Only authenticated `http://127.0.0.1` discovery is accepted. Tokens
  remain server-side and are never returned to browsers or included in events.
  Stopping OpenChamber closes its peer, not the Harness process or its sessions.
- Enterprise mode disables shared-host connection and DeepSeek execution. The
  existing HTTP authentication and trust gates remain in front of these routes.
- Shared-host approvals and interactive questions remain in Harness. The bridge
  delegates unhandled waterfalls rather than approving them. ACP permission
  replies remain supported. Shared deletion is refused before native deletion.
- OpenCode-specific forks, moves, shell turns, compaction and agent/skill
  attachments remain unsupported. The model picker advertises one configured
  model; upstream features are not promises of DeepSeek compatibility.

## Decisions

### Why attach to the existing host

A new ACP process owns different live agents, even when it reads the same
persisted logs. Attaching to Harness's authenticated API allows both interfaces
to operate the same running chat without duplicate sessions or writer conflicts.

### Why keep the connection plugin outside the app

The Harness profile and private connection file survive replacing OpenChamber.
The plugin uses Harness's authentication API instead of extracting desktop
cookies or modifying the signed Harness application.

### Why retain native index records and legacy bindings

OpenChamber's sidebar relies on OpenCode pagination and metadata. Stable index
records preserve that contract, and binding old ACP identities prevents an
existing chat from appearing again under a new imported ID.
