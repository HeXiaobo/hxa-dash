# Design: Feishu -> GitHub/Codex Bridge

**Issue:** #3
**Author:** Codex
**Status:** Draft v2 - bot ownership decision resolved

---

## Problem

Important engineering decisions and follow-up requests often start in Feishu, but hxa-dash work should be tracked in GitHub issues and pull requests. Today the handoff is manual: someone has to notice a message, copy context into GitHub, and then decide whether Codex should work on it.

That creates three problems:

- Feishu conversations are easy to lose after the moment passes.
- GitHub is not always the source of truth for requested work.
- Codex cannot reliably pick up work unless a human restates the task in a thread.

The bridge should turn explicit Feishu messages into GitHub issues or comments, then mark selected work for Codex handoff.

## Goals

- Make `HeXiaobo/hxa-dash` the only GitHub target for hxa-dash bridge-created work.
- Capture explicit Feishu requests as GitHub issues or issue comments.
- Preserve source context: Feishu chat, message id, sender, timestamp, and message link.
- Support a safe dry-run mode for testing routing without writing to GitHub.
- Provide a clear handoff path for Codex work without requiring hidden access to private chats.

## Non-Goals

- Do not ingest all private Feishu conversations.
- Do not treat `coco-xyz/hxa-dash` as a maintained target.
- Do not bypass GitHub review by applying code changes directly from Feishu.
- Do not require the first version to create Codex desktop threads automatically.

## Decision: Feishu Bot Ownership

Decision as of 2026-06-12: v1 uses a dedicated bridge bot/app running as an independent service. It must not be merged into the existing comm-bridge command handler.

The current Zylos Feishu bot already consumes `im.message.receive_v1` through the existing message dispatcher. Starting a second bridge worker on the same bot/app would risk duplicate or competing event consumption.

The bridge service can reuse the same Feishu event integration pattern as comm-bridge, but the runtime, credentials, logs, and restart lifecycle stay separate. The expected production shape is an independent PM2 process pinned to a Git commit.

Chosen path:

- Uses a separate Feishu app id or bot identity for bridge-specific event intake.
- Physically isolates bridge events from the existing Claude/C4 message path.
- Keeps GitHub token, Codex/OpenAI credentials, and bridge audit logs out of the critical comm-bridge path.
- Allows bridge-specific deploy, restart, rollback, and rate-limit handling without risking team message delivery.

Rejected path for v1:

- Do not add `/issue`, `/comment`, or `/codex` as interceptors inside the current comm-bridge dispatcher.
- Do not let GitHub API calls, Codex handoff work, or long-running code tasks block the message dispatch pipeline.
- Revisit tighter integration only after the dedicated bridge service has run safely in production.

## Trigger Model

The bridge only acts on explicit triggers visible to the bridge bot.

Supported MVP triggers:

| Trigger | Action |
|---|---|
| `/issue <title>\n<body>` | Create a GitHub issue in `HeXiaobo/hxa-dash`; first line is title, remaining lines are body |
| `/comment #<issue> <body>` | Append a GitHub issue comment |
| `/codex <title>\n<body>` | Create a GitHub issue with a `codex-ready` label and Codex handoff template |
| `/bridge help` | Reply with supported commands |

Optional later triggers:

- Feishu reaction-based routing, such as adding a specific emoji to a message.
- Forward-to-bot routing, where the forwarded message becomes the issue body.
- Project prefixes, such as `/issue hxa-dash ...`, if more repositories are added later.

## Privacy Boundary

The bridge must only receive messages where the bot is present or explicitly addressed. It should not use a user token to search arbitrary private chat history in the background.

Default policy:

- Process messages sent to the bridge bot in P2P chats.
- Process group messages only when the bot is mentioned or the message starts with a bridge command.
- Allowlist chat ids and sender ids in configuration before enabling production writes.
- Apply command-level sender allowlists. `/codex` and `/issue` should start with a very small trusted sender set, even inside an allowlisted chat.
- Store only the triggered message and required metadata, not full surrounding chat history.
- Keep `HeXiaobo/hxa-dash` private because source blocks include internal Feishu ids.

## Architecture

```
Feishu message event
        |
        v
Bridge input adapter
        |
        v
Command parser -> policy checks -> dedupe
        |
        v
GitHub writer
        |
        +--> Feishu acknowledgement
        |
        +--> Codex handoff marker
```

### Input Adapter

The bridge should support one interface with multiple implementations:

```js
async function handleFeishuMessage(event) {
  // normalized event enters the shared bridge pipeline
}
```

MVP adapter options:

1. `lark-cli event consume im.message.receive_v1 --as bot`
   - Fastest to validate with the current toolchain.
   - Runs as the dedicated bridge PM2 worker, not inside comm-bridge.
   - Emits NDJSON that the worker normalizes.

2. Feishu Open Platform event delivery
   - Better long-term production shape.
   - Can use webhook or persistent connection depending on deployment constraints.
   - The normalized payload should match the same internal event shape.

Internal normalized event:

```json
{
  "chat_id": "oc_xxx",
  "message_id": "om_xxx",
  "sender_id": "ou_xxx",
  "sender_name": "Name",
  "message_type": "text",
  "content": "/issue Title\\nBody",
  "message_link": "https://applink.feishu.cn/...",
  "created_at": 1781147600000
}
```

### Policy Checks

Before writing to GitHub:

- `enabled` must be true.
- `dry_run` must be false for writes.
- `chat_id` must be allowed, unless `allow_all_chats` is explicitly true.
- `sender_id` must be allowed, unless `allow_all_senders` is explicitly true.
- The command must be recognized.
- The message id must not have been processed already.

### GitHub Writer

Use GitHub REST issue APIs through a small local wrapper:

- `POST /repos/HeXiaobo/hxa-dash/issues` for `/issue` and `/codex`.
- `POST /repos/HeXiaobo/hxa-dash/issues/{issue_number}/comments` for `/comment`.

Each created issue should include a source block:

```md
---
Source: Feishu
Chat: oc_xxx
Message: om_xxx
Sender: Name (ou_xxx)
Sent at: 2026-06-11 09:30
Link: https://applink.feishu.cn/...
```

Suggested labels:

- `source:feishu`
- `codex-ready` for `/codex`
- `needs-triage` for `/issue`

### Codex Handoff

MVP handoff is GitHub-native:

- `/codex` creates a GitHub issue labeled `codex-ready`.
- The issue body includes enough context for a Codex thread to start.
- A human or later automation can create a Codex thread from that issue.

Future automation can add a Codex adapter that creates or wakes a Codex desktop thread when a `codex-ready` issue appears. This should remain optional because Codex desktop thread management depends on local app state and permissions.

`/codex` issues should use this body template:

```md
## Problem

<what needs to be solved>

## Scope

<files, product area, or system boundary if known>

## Acceptance Criteria

- <observable outcome>

## Source Links

- Feishu message: <link>
- Related issue/PR/doc: <link>
```

## Configuration

Add a non-committed config file, for example `config/bridge.json`:

```json
{
  "enabled": false,
  "dry_run": true,
  "github": {
    "owner": "HeXiaobo",
    "repo": "hxa-dash",
    "token_env": "GITHUB_TOKEN"
  },
  "feishu": {
    "mode": "lark-cli",
    "allowed_chat_ids": [],
    "allowed_sender_ids": [],
    "command_allowed_sender_ids": {
      "issue": [],
      "comment": [],
      "codex": []
    }
  },
  "commands": {
    "issue": true,
    "comment": true,
    "codex": true
  }
}
```

Add `config/bridge.example.json` with safe defaults.

## Data Storage

The bridge needs durable dedupe and audit storage. SQLite is enough for MVP.

Suggested table:

```sql
create table if not exists bridge_events (
  message_id text primary key,
  chat_id text not null,
  sender_id text,
  command text not null,
  github_issue_number integer,
  github_comment_id integer,
  status text not null,
  error text,
  created_at integer not null,
  processed_at integer not null
);
```

Statuses:

- `dry_run`
- `created_issue`
- `created_comment`
- `ignored`
- `failed`

## Token And Deployment Rules

- Use a fine-grained GitHub token limited to `issues:write` on `HeXiaobo/hxa-dash`.
- Read the token from the configured environment variable only.
- Keep GitHub and Codex/OpenAI credentials scoped to the dedicated bridge service environment.
- Do not inject bridge credentials into comm-bridge, the C4 message path, or shared dispatcher config.
- Never embed GitHub tokens in git remotes, URLs, logs, config files, issue bodies, or source code.
- Run the bridge as an independent PM2 service so it can be restarted, rolled back, or disabled without interrupting comm-bridge.
- Deploy the bridge from a pinned Git commit, following the reproducibility work tracked in #4.
- Do not run production bridge code from an uncommitted working tree.

## Feishu Acknowledgement

After processing, the bridge should reply in Feishu:

- Dry run: "Dry run: would create issue ..."
- Issue created: "Created GitHub issue #N: <url>"
- Comment created: "Commented on #N: <url>"
- Failure: concise error plus whether retry is safe.

Acknowledgements should avoid leaking secrets or raw stack traces.

## Failure Handling

- GitHub API failure: keep audit row with `failed`; reply with a short error.
- Duplicate Feishu event: return the existing GitHub issue/comment result.
- Unknown command: reply with `/bridge help`.
- Permission failure: reply "not allowed" without exposing allowlist details.
- Rate limiting: mark failed with retryable error; do not spin in a tight loop.

## Implementation Plan

1. Create `config/bridge.example.json`.
2. Add bridge command parser tests.
3. Add GitHub writer wrapper with dry-run support.
4. Add SQLite audit/dedupe helpers.
5. Add a dedicated bridge worker script for `lark-cli event consume im.message.receive_v1`.
6. Add Feishu acknowledgement send path.
7. Add independent PM2 service documentation.
8. Test in dry-run mode with a private allowlisted chat.
9. Enable GitHub writes for one allowlisted chat.

## Acceptance Criteria

- A design document exists before code implementation starts.
- Dry-run mode logs the intended GitHub issue/comment without writing.
- An allowlisted Feishu `/issue` message creates a GitHub issue.
- An allowlisted Feishu `/comment #N` message comments on the issue.
- An allowlisted Feishu `/codex` message creates a GitHub issue with `codex-ready`.
- Non-triggered messages are ignored.
- Messages outside the allowlist are ignored or rejected.
- Duplicate Feishu events do not create duplicate GitHub issues.

## Resolved Decisions

- Feishu bot/app ownership: v1 uses a dedicated bridge bot/app and independent bridge service. It does not run inside the existing comm-bridge command handler.
- Codex handoff for v1: GitHub `codex-ready` remains the contract; desktop-thread automation is deferred.

## Open Questions

- Which chats and senders should be allowlisted first?
  - Proposed MVP: a single private chat plus a very small trusted sender set.
- Should bridge-created issues use a dedicated project board or labels only?
  - Proposed MVP: labels only.
- Who owns production deployment and token rotation?
  - Proposed owner should align with #4 production deployment cleanup.
