# Claude Code bridge

The bridge that lets [llm-for-zotero](../../README.md) talk to a real Claude
Code runtime through the Claude Agent SDK. It used to live in the separate
`cc-llm4zotero-adapter` repository (originally by jianghao-zhang) and moved
here with its history.

**Users do not run this by hand.** While Claude Code mode is on, the plugin
copies the bundled bridge (`addon/content/claude-bridge/bridge.mjs`, built by
`npm run build` at the repository root) to
`<Zotero data directory>/llm-for-zotero/claude-bridge/`, starts it with the
user's Node.js 18+, and stops it again. See `src/claudeCode/bridgeProcess.ts`.

## What it does

- Streams `/run-turn` events from the Claude runtime as llm-for-zotero agent events.
- Exposes `/commands` for slash command discovery and `/session-info` for session recovery.
- Persists session links and run traces in its state directory.

## How the plugin starts it

```bash
ADAPTER_AUTH_TOKEN=<random> node bridge.mjs \
  --host 127.0.0.1 --port 0 \
  --managed-by llm-for-zotero --exit-on-stdin-close 1 --log-file 1 \
  --claude-path /path/to/claude
```

- `--port 0` picks any free port. When the server is listening, the bridge
  prints one line the plugin waits for:
  `CLAUDE_BRIDGE_READY {"host":"127.0.0.1","port":…,"version":…,"runtimeCwd":…,"stateDir":…,"logFile":…}`.
- With `ADAPTER_AUTH_TOKEN` set, every request path must start with
  `/<token>`, for example `/<token>/healthz`; anything else gets HTTP 401. The
  token is passed in the environment so it does not show up in `ps`.
- `--exit-on-stdin-close 1` makes the bridge exit when its stdin closes. The
  plugin keeps stdin open, so the bridge also exits if Zotero crashes.
- `--claude-path` runs the user's own `claude`. The bundled bridge does not
  include the SDK's per-platform Claude binary (about 250 MB).
- When `~/Zotero` exists, the bridge keeps the old adapter's
  `~/Zotero/agent-runtime` and `~/Zotero/agent-state` folders; otherwise the
  plugin passes `--zotero-root <Zotero data directory>`.

## Developing

From this folder (dependencies are installed by `npm install` at the
repository root):

```bash
npm test               # vitest
npm run typecheck
npm run serve:bridge   # run from source on http://127.0.0.1:19787, no token
```

To try a bridge you run by hand with Zotero, turn on **Use my own bridge** in
the plugin's Claude Code settings and keep the Bridge URL at
`http://127.0.0.1:19787`. The same setting is how to use a bridge inside WSL
while Zotero runs on Windows.

Claude Code itself must be installed and logged in (`claude` once in a
terminal). A healthy `/healthz` only means the bridge is up, not that Claude
Code works.

## Config source in plain English

Claude Code itself supports layered config such as user / project / local settings:

- https://code.claude.com/docs/en/settings.md
- https://code.claude.com/docs/en/settings.md#configuration-scopes
- https://code.claude.com/docs/en/settings.md#settings-precedence

In this Zotero integration, those layers are used like this:

- `user` → your normal machine-level Claude Code setup
- `project` → the shared Zotero Claude runtime root
- `local` → the current conversation-specific runtime folder

That is why this adapter works well for both kinds of users:

- users who want Zotero to reuse their normal Claude setup
- users who want Zotero-specific shared behavior without polluting global Claude usage

## Shared runtime root and skills

The adapter defaults to a shared Claude runtime root under `~/Zotero/agent-runtime` and a state dir under `~/Zotero/agent-state`.

The shared runtime root is where Zotero-level Claude assets are expected to live, including things like:

- `CLAUDE.md`
- `.claude/settings.json`
- `.claude/skills/`
- `.claude/commands/`

For most users, shared Claude skills for Zotero should live in that project-level layer rather than in unrelated global user config.

## HTTP Endpoints

### GET `/healthz`

Health check endpoint.

### GET `/commands`

Returns Claude slash commands.

- Query: `settingSources=user,project,local` (optional)

### GET `/models`

Returns the ordered model catalog reported by Claude Code for the active settings stack.

- Query: `settingSources=user,project,local` (optional)
- Query: `conversationKey`, `scopeType`, `scopeId`, `scopeLabel` (optional; use together to discover models from the same scoped conversation directory as a turn)

The response keeps the legacy `models` string array and adds structured `modelInfos` metadata:

```json
{
  "models": ["default", "opus[1m]", "claude-fable-5[1m]"],
  "modelInfos": [
    {
      "value": "default",
      "resolvedModel": "claude-opus-5[1m]",
      "displayName": "Default",
      "description": "Current account default",
      "supportsEffort": true,
      "supportedEffortLevels": ["low", "medium", "high", "xhigh", "max"],
      "supportsAdaptiveThinking": true,
      "supportsFastMode": false,
      "supportsAutoMode": true
    }
  ]
}
```

Model values are opaque Claude Code identifiers and are returned without removing context suffixes such as `[1m]`.
When Claude Code returns a catalog successfully, that catalog is authoritative, including an intentionally empty or settings-restricted result.
Settings and environment values are synthesized only when model discovery itself fails.
When conversation and scope query parameters are provided, catalog discovery uses the same contained runtime directory and `.claude/settings.local.json` stack as the corresponding turn.
The health endpoint advertises this response contract through the `model_catalog_v1` capability.

### GET `/session-info`

Returns session mapping information for a conversation.

- Query: `conversationKey` (required)
- Query: `scopeType`, `scopeId`, `scopeLabel` (optional)

### POST `/run-turn`

Runs one agent turn with streaming events.

- Required body: `conversationKey`, `userText`
- Optional body: `allowedTools`, `scopeType`, `scopeId`, `scopeLabel`, `runtimeRequest`, `metadata`

### POST `/run-action`

Runs a tool/action request.

- Required body: `conversationKey`, `toolName`
- Optional body: `args`, `approved`, scope fields, metadata/context fields

### POST `/resolve-confirmation`

Resolves pending confirmation requests.

- Required body: `requestId`, `approved`
- Optional body: `actionId`, `data`

### Additional read endpoints

- `GET /tools`
- `GET /models`
- `GET /efforts`

## Runtime / Environment Options

| Flag                          | Env                                 | Description                                                                                                                                                                             |
| ----------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--host`                      | `ADAPTER_HOST`                      | Bind host (default `127.0.0.1`)                                                                                                                                                         |
| `--port`                      | `ADAPTER_PORT`                      | Bind port (default `19787`; `0` picks a free port and the ready line reports it)                                                                                                        |
| `--runtime-cwd`               | `ADAPTER_RUNTIME_CWD`               | Workspace root for Claude Agent SDK. Defaults to the legacy Zotero runtime path when available.                                                                                         |
| `--state-dir`                 | `ADAPTER_STATE_DIR`                 | Session/trace persistence directory. Defaults to the legacy Zotero state path when available.                                                                                           |
| `--zotero-root`               | `ZOTERO_ROOT`                       | Override the legacy Zotero root used to derive default runtime/state paths. Useful when Zotero data is not under the home directory.                                                    |
| `--additional-directories`    | `ADAPTER_ADDITIONAL_DIRECTORIES`    | Extra readable directories (comma-separated, `~` supported).                                                                                                                            |
| (env only)                    | `ADAPTER_WINDOWS_DRIVE_MOUNT_ROOT`  | Where Windows drives are mounted when the bridge runs under WSL while Zotero runs on Windows (default `/mnt`). Raw PDF paths such as `C:\Users\...` are mapped to `<root>/c/Users/...`. |
| `--default-allowed-tools`     | `ADAPTER_DEFAULT_ALLOWED_TOOLS`     | Tools always auto-allowed (comma-separated). Default: `WebFetch,WebSearch`.                                                                                                             |
| `--setting-sources`           | `ADAPTER_SETTING_SOURCES`           | Claude settings sources: `user`, `project`, `local` (comma-separated). Default: `user,project,local`.                                                                                   |
| `--append-system-prompt`      | `ADAPTER_APPEND_SYSTEM_PROMPT`      | Inline overlay prompt text.                                                                                                                                                             |
| `--append-system-prompt-file` | `ADAPTER_APPEND_SYSTEM_PROMPT_FILE` | File-based overlay prompt. Missing optional files are ignored.                                                                                                                          |
| `--forward-frontend-model`    | `ADAPTER_FORWARD_FRONTEND_MODEL`    | Pass every non-empty frontend `metadata.model` value to Claude Code unchanged (default `true`). Claude Code resolves aliases, custom provider names, and future model families.         |
| `--log-file`                  | `ADAPTER_LOG_FILE`                  | Mirror bridge stdout/stderr to a file. Use `1` / `true` to write to `<state-dir>/bridge.log`.                                                                                           |
| `--claude-path`               | `ADAPTER_CLAUDE_PATH`               | The `claude` executable the SDK runs. Required for the bundled bridge.                                                                                                                  |
| (env only)                    | `ADAPTER_AUTH_TOKEN`                | Require a `/<token>` prefix on every request path.                                                                                                                                      |
| `--managed-by`                | `ADAPTER_MANAGED_BY`                | Reported by `/healthz` as `managedBy`. The plugin passes `llm-for-zotero`.                                                                                                              |
| `--exit-on-stdin-close`       | `ADAPTER_EXIT_ON_STDIN_CLOSE`       | Exit when stdin closes (default `false`).                                                                                                                                               |

Default additional readable directories:

- `$HOME/Zotero`
- `$HOME/Downloads`
- `$HOME/Documents`

## Troubleshooting

### 1) Bridge URL or port mismatch

- Make sure llm-for-zotero Bridge URL matches adapter bind address.
- Default is `http://127.0.0.1:19787`.

### 2) Claude Code itself is not ready

If you see `claude: command not found`, install Claude Code CLI first.

If the bridge is healthy but Claude turns still fail, check Claude Code itself separately:

```bash
claude
```

If needed, finish login/auth there first.

### 3) Health is OK, but Zotero still cannot use Claude correctly

That usually means one of these layers is wrong:

- Claude Code CLI is not installed or not logged in
- the bridge is running on a different host/port than Zotero expects
- Zotero config source or permission setup is not what the user intended

### Logs

With `--log-file 1` (always on when the plugin starts the bridge), output goes
to `<state-dir>/bridge.log`. The plugin's **Open log** button opens it.

## Repository Layout

- `src/bridge` — bridge/runtime adapter contracts and wrappers
- `src/event-mapper` — Claude SDK events to llm-for-zotero event mapping
- `src/session-link` — conversationKey ↔ provider session mapping
- `src/trace-store` — run trace persistence
- `src/providers` — Claude Agent SDK runtime client
- `src/server` — HTTP bridge server
- `bin/start-bridge-server.ts` — server entrypoint, also the bundle entry

## References

- [Claude Agent SDK TypeScript](https://platform.claude.com/docs/en/agent-sdk/typescript)
- [Claude Agent SDK Overview](https://platform.claude.com/docs/en/agent-sdk/overview)

## License

AGPL-3.0-or-later, the same as llm-for-zotero (see `LICENSE`).
This bridge was originally released under the MIT License by 东亜重工 (jianghao-zhang) and was relicensed with permission.
Contributions made before the relicense remain available under the MIT License (see `LICENSE-MIT`).
`NOTICE` has the same statement, and the plugin ships it with the bundled bridge.
