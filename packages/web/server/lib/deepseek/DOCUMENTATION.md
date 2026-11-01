# DeepSeek Harness

## Ownership

This module carries the fork's DeepSeek Harness ACP adapter onto OpenChamber 2.x.
`deepseek-appserver.js` and `jsonrpc-subprocess.js` own the child process and ACP
conversation. `deepseek-backend.js` owns persisted transcripts and pending turns.
`wire.js` maps those records and events to the current OpenCode wire vocabulary.
`routes.js` registers the adapter after the proxy's authentication, checkout and
configuration trust gates, before ordinary OpenCode forwarding.

Set `DEEPSEEK_DSH_BIN` to enable the integration. `DEEPSEEK_DSH_ARGS` selects the
profile and optional patch. The executable receives the existing environment;
credentials remain in dsh's credential service. `DEEPSEEK_PROVIDER` and
`DEEPSEEK_MODEL` identify the provider/model configured by that profile. The
model appears under **DeepSeek Harness** in the normal model picker. The HTTP
port uses `DEEPSEEK_MODEL`; the legacy adapter's `DEEPSEEK_MODELS` list does not
add entries to this picker.

Web and Electron run this module. Hosted mobile and Capacitor clients use their
connected server's integration and existing authenticated transports. VS Code
runs its own backend and does not advertise this provider. No new listener,
relay protocol, browser credential or desktop IPC capability is introduced.

## Invariants

- Native OpenCode session records remain the authoritative index, including
  pagination, folders, archive state and session metadata. DeepSeek records keep
  the same session ID and live beside them in `deepseek-sessions.json`.
- Only sessions created with the `deepseek-harness` model use ACP. Native
  metadata records that choice; client-generated session IDs are preserved.
  A missing transcript fails explicitly, without sending its
  prompt to OpenCode or another provider.
- One live turn runs per session. A process failure ends that turn; pending
  approvals cannot be answered after their owning process is gone.
- Text, reasoning and tool events retain the same message and content ordering
  as transcript reads. The shared event hub supplies transport replay.
- Prompt bodies are limited to 12 MiB. Message pages default to 100 records,
  permit at most 1000 and use the last returned message ID as their cursor.
- The current port offers one configured model. Unsupported operations return
  an explicit error. OpenCode agent/skill attachments, shell turns, compaction,
  forks, moving a session and switching an existing session's backend are not
  claimed as supported.
- Enterprise mode suppresses discovery and refuses creation, prompt submission
  and approval responses. A request cannot bypass this gate by knowing a session
  ID. Existing transcripts remain readable.

## Decisions

### Why retain native session records

The current UI relies on OpenCode's session index for cursor pagination and
workspace state. A native record avoids a second pagination and folder system;
its model is projected from the stored DeepSeek metadata.

### Why retain the fork's ACP runtime

The existing adapter already owns cancellation, approval round trips, restart
and transcript persistence. Porting that boundary preserves its tested behavior
without restoring the fork's obsolete UI and sync refactor.

### Why keep unsupported operations explicit

The native OpenCode record contains no DeepSeek transcript. Forwarding a fork,
compaction or shell request to OpenCode would operate on an empty conversation
or execute through the wrong engine.
