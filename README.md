# OpenChamber DSH

**A desktop and browser workspace for AI coding agents, with DeepSeek Harness support.**

Describe a task, watch the agent work, review its file changes, and approve commands from one place. OpenChamber keeps the conversation, code diffs, terminal, and project files together so you can see what the agent did before you keep the result.

This repository is a fork of [OpenChamber](https://github.com/openchamber/openchamber). It adds a connection to **DeepSeek Harness**, the local agent runtime launched by the `dsh` command. DeepSeek conversations run through your own Harness installation and its configured model provider.

[Get started](#get-started) · [Configure DeepSeek](#configure-deepseek) · [Update safely](#updates) · [Troubleshooting](#troubleshooting) · [Contribute](#development-and-contributing)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/references/desktop_dark.png">
  <img src="docs/references/desktop_light.png" alt="OpenChamber workspace showing an agent conversation, project navigation, and development tools">
</picture>

*The OpenChamber interface. This fork adds DeepSeek Harness to the model picker.*

## What it does

- **Work with an agent in a project.** Send a task, follow the response as it streams, and continue the same conversation later.
- **Review the work.** Inspect file changes and use the built-in terminal and browser to check the result.
- **Control tool execution.** See permission requests and approve or reject them from the conversation.
- **Keep projects organized.** Find previous sessions, group them into folders, and return to saved work.
- **Choose a backend.** Use the DeepSeek Harness integration or the regular OpenCode-backed sessions provided by OpenChamber.

OpenChamber is the interface. The agent runtime executes tools and talks to the model provider. A model account, credentials, and any inference charges belong to that provider; installing this app does not include model access.

### How the pieces fit

| Component | Purpose |
| --- | --- |
| **OpenChamber DSH** | The app you use to chat, inspect changes, and answer permission requests |
| **DeepSeek Harness / `dsh`** | The separately installed agent runtime for DeepSeek sessions |
| **Model provider** | The service configured in Harness that runs the model |
| **OpenCode** | The bundled desktop runtime for regular sessions and the shared project/session index |

The shared-host connection uses the same running Harness sessions as its desktop app. An ACP connection is also available for older standalone OpenChamber conversations. You do not need to work with either protocol to use the app.

## Get started

### Install the macOS release

Download the Apple Silicon macOS package from [this fork's Releases page](https://github.com/rohanpandula/openchamber/releases/latest), open the DMG, and drag **OpenChamber DSH** into Applications. Configure Harness using the [DeepSeek setup](#configure-deepseek), then open the app and select **DeepSeek Harness** in the model picker.

The package is signed with the maintainer's Developer ID. Apple notarization is not included in this release, so macOS may block a downloaded copy. The current fork release is **2.5.8**, based on upstream OpenChamber **2.5.3**. Official OpenChamber packages do not include this integration.

### Build from source

#### Requirements

- **Node.js 24.14 or newer** and **Bun 1.4.4**, matching the repository's toolchain.
- **Git** to clone and update the repository.
- A working **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness#readme)** installation with its `dsh` executable, a configured provider, and credentials.
- For a macOS desktop build, **Xcode command-line tools** and an Apple Silicon or Intel Mac.

The DeepSeek desktop integration has been exercised on Apple Silicon macOS. OpenChamber also has Windows and Linux desktop packages, but this fork's DeepSeek setup has not been verified on those platforms. Desktop bundles OpenCode; a separately running web server needs its own compatible OpenCode CLI.

#### 1. Get the source

```bash
git clone https://github.com/rohanpandula/openchamber.git
cd openchamber
bun install --frozen-lockfile
```

#### 2. Configure DeepSeek

Follow [Configure DeepSeek](#configure-deepseek) before opening your first DeepSeek session. Follow the [official Harness installation and authentication guide](https://github.com/deepseek-ai/deepseek-harness#readme). Confirm that Harness itself can use your chosen provider and model before troubleshooting the app.

#### 3. Build the desktop app

For a local Apple Silicon build, run these commands from the repository root:

```bash
export BUN="$(command -v bun)"
export CSC_IDENTITY_AUTO_DISCOVERY=false
bun run --cwd packages/electron package \
  --mac --arm64 --dir \
  --config.mac.identity=null --config.mac.notarize=false

codesign --force --deep --sign - \
  --entitlements packages/electron/resources/entitlements.mac.plist \
  "packages/electron/dist/mac-arm64/OpenChamber DSH.app"

open "packages/electron/dist/mac-arm64/OpenChamber DSH.app"
```

On an Intel Mac, use `--x64` and the output directory `packages/electron/dist/mac`. This builds a locally signed app, without Apple notarization. Release signing and platform packaging are covered in the [desktop README](packages/electron/README.md).

To install it, quit any running copy and copy `OpenChamber DSH.app` into Applications. Keep the app's name and bundle identity when rebuilding so subsequent installs use the same saved configuration.

### Start a conversation

1. Open **OpenChamber DSH** and choose a project or start a new session.
2. Open the model picker and choose the model under **DeepSeek Harness**.
3. Send a small task, such as asking the agent to explain the project.
4. Review tool requests and file changes before approving or keeping them.

Existing OpenCode sessions keep their original backend. Start a new session to use DeepSeek.

## Configure DeepSeek

Desktop reads its connection settings from:

```text
~/.config/openchamber-dsh-v2/deepseek.json
```

Create that directory and file if they do not exist. The file contains connection settings, not API keys:

```json
{
  "binary": "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh",
  "args": "--profile acp",
  "provider": "deepseek-official",
  "model": "deepseek-v4-flash"
}
```

These are example provider/model values. Use the identifiers from your working Harness configuration. If your provider needs a Harness patch, include it in `args`, for example `--profile acp --patch \"/absolute/path/to/provider.patch.yml\"`. Restart OpenChamber DSH after changing this file.

| Setting | What to put there |
| --- | --- |
| `binary` | The absolute path to your `dsh` executable |
| `args` | Harness launch arguments, including the profile and optional patch file |
| `provider` | The provider identifier configured in that Harness profile |
| `model` | The model identifier available through that provider |

### Keep Harness and OpenChamber in sync

After configuring DeepSeek, run this once from a source checkout. If you installed the DMG, download or clone this repository for the setup command:

```bash
node scripts/connect-deepseek-desktop.mjs
```

Restart **OpenChamber DSH**. Harness loads the small connection plugin without restarting its running sessions. Keep Harness open while using shared chats.

Existing top-level Harness chats then appear in OpenChamber, grouped by their Harness workspaces, with unassigned chats under Ungrouped. Their working directories stay unchanged. Messages, streamed replies, titles, and running status stay in sync in both directions. Subagent work remains inside its parent chat instead of appearing as separate sidebar conversations. A disconnected host reconnects automatically; it never silently starts another agent process for that chat.

The setup script saves `hostFile` in `deepseek.json` and installs the plugin under `~/.config/openchamber-dsh-v2/harness/`. Both survive app updates. The connection file is private to your user and contains a temporary local authentication URL. Do not share it or commit it.

Keep provider credentials in Harness's credential storage. No API keys belong in this repository. Without shared-host setup, OpenChamber uses its own ACP process and only shows conversations created through that connection.

You can override these values with `DEEPSEEK_DSH_BIN`, `DEEPSEEK_DSH_ARGS`, `DEEPSEEK_PROVIDER`, `DEEPSEEK_MODEL`, and `DEEPSEEK_HOST_FILE` in the app's launch environment. A missing configuration leaves DeepSeek unavailable unless those environment variables configure it. Invalid JSON or missing required fields prevents startup with a configuration error.

### Browser development

For a source development server, export the same connection settings in your shell. Desktop's `deepseek.json` file is specific to the desktop launcher.

```bash
export DEEPSEEK_DSH_BIN="/absolute/path/to/dsh"
export DEEPSEEK_DSH_ARGS="--profile acp"
export DEEPSEEK_PROVIDER="your-provider-id"
export DEEPSEEK_MODEL="your-model-id"
bun run dev
```

Open the Vite URL printed by the command. The server runs on your machine; the browser is its interface. See [CONTRIBUTING.md](CONTRIBUTING.md) for development scripts and [the server package](packages/web/README.md) for server setup.

## Supported DeepSeek features

| Feature | Status |
| --- | --- |
| Text chat and streamed responses | Supported |
| Reasoning and tool output | Supported when emitted by Harness |
| Cancellation | Supported |
| Tool permissions and interactive questions | Answer in Harness for shared-host chats; ACP permissions work in OpenChamber |
| Saved conversations and restart recovery | Supported |
| Two-way Harness desktop sync | Shared-host setup required |
| Subagents | Kept inside their parent chat |
| Image attachments | Passed to Harness; model support varies |
| Multiple DeepSeek models in one configured app | One configured model at a time |
| Token and cost accounting | Not reported; counters currently show zero |
| OpenCode skill/agent attachments, shell turns, compaction, forks, session moves, backend switching | Not supported for DeepSeek sessions |
| DeepSeek inside the VS Code extension | Not implemented |

Harness can execute terminal tools within a DeepSeek conversation. The unsupported “shell turns” entry refers to OpenCode's separate shell-message API, not to those tool calls.

OpenChamber's other features, including goals, multi-run, scheduling, and remote access, come from upstream. Their presence in the interface does not establish compatibility with the DeepSeek backend. See the [adapter documentation](packages/web/server/lib/deepseek/DOCUMENTATION.md) for its exact boundaries. Enterprise mode disables DeepSeek execution.

## Updates

**Keep using builds from this fork to keep the DeepSeek integration.**

The desktop's Stable and Canary update channels point only to `rohanpandula/openchamber`. They do not fall back to official OpenChamber releases. The updater can install compatible packages published in this fork. Source builds can be updated directly:

```bash
git switch main
git pull --ff-only origin main
bun install --frozen-lockfile
```

Then repeat the desktop build and replace your installed copy after quitting it. Review or commit local changes before pulling.

Saved conversations and connection settings live outside the app bundle:

| Data | Default location on macOS |
| --- | --- |
| DeepSeek settings, shared-host plugin, and legacy ACP transcripts | `~/.config/openchamber-dsh-v2/` |
| Bundled OpenCode configuration and data | `runtime-config/` and `runtime-data/` inside that directory |
| Desktop window and browser state | `~/Library/Application Support/OpenChamber DSH 2/` |
| Harness credentials | Harness's own credential storage |

Replacing the app preserves those directories. Back them up before a major upgrade. Installing an official upstream binary or running an official package-manager update cannot preserve code that exists only in this fork.

### Bringing upstream changes into the fork

Maintainers merge upstream changes into this repository and rebuild the fork. For an existing clone, add the upstream remote once:

```bash
git remote add upstream https://github.com/openchamber/openchamber.git
```

Then fetch and merge when ready:

```bash
git fetch upstream
git switch main
git merge upstream/main
```

Resolve any conflicts before building. Preserve the DeepSeek adapter, desktop startup configuration, fork app identity, and fork update feeds. Run the checks below and test a real DeepSeek conversation before publishing an update. Future upstream changes may require adapter work. The upstream npm/release automation is disabled in this fork; fork packages are built and published separately.

## Troubleshooting

| Problem | Check |
| --- | --- |
| Shared chats are unavailable | Open Harness and wait for reconnection; rerun the shared-host setup script if the profile was reset |
| No DeepSeek Harness model in the picker | Check `deepseek.json`, the `binary` path, and whether `dsh` runs; restart the app |
| Model or authentication error | Run Harness directly with the same profile and patch; confirm the provider/model identifiers and credentials there |
| App fails immediately after editing configuration | Validate the JSON and supply all four required fields |
| Existing session uses another backend | Create a new session and select DeepSeek Harness before sending |
| Update check has no release to install | Use the source-build update instructions until this fork publishes a compatible package |
| Unsupported operation error | Check the DeepSeek feature table; the adapter refuses operations it cannot perform |

Desktop logs are under `~/Library/Logs/OpenChamber DSH/` on macOS. Remove secrets and private prompts before sharing logs.

For integration bugs, [open an issue in this fork](https://github.com/rohanpandula/openchamber/issues). Include the app version, OS, Harness version, and a minimal reproduction. General OpenChamber documentation is available at [openchamber.dev](https://openchamber.dev).

## Development and contributing

The code is organized as a monorepo:

| Directory | Contains |
| --- | --- |
| `packages/ui` | Shared React interface and session state |
| `packages/web` | Web app, server, and DeepSeek shared-host/ACP adapters |
| `packages/electron` | Desktop launcher, native integrations, and updater |
| `packages/vscode` | VS Code extension |
| `packages/mobile` | Native mobile shell |
| `packages/sdk` | Extension SDK |
| `packages/docs` | Product documentation |

Run focused integration tests and the repository checks from the root:

```bash
bun run --cwd packages/web test server/lib/deepseek
node --test packages/electron/deepseek-desktop.test.mjs packages/electron/updater-feed.test.mjs
bun run check:changed
```

Keep fixes focused and include a reproduction or test for changed behavior. Read [AGENTS.md](AGENTS.md) and [CONTRIBUTING.md](CONTRIBUTING.md) before working on the code. The contribution guide contains upstream's review policies; discuss fork-specific changes in this repository.

## Credits and license

Maintained as a fork by [Rohan Pandula](https://github.com/rohanpandula). OpenChamber DSH builds on the work of the [OpenChamber contributors](https://github.com/openchamber/openchamber/graphs/contributors), [OpenCode](https://opencode.ai), and DeepSeek Harness. OpenChamber is independent of the OpenCode and DeepSeek teams.

[MIT license](LICENSE).
