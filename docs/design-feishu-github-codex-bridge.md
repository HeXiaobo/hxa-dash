# Design: Feishu -> GitHub/Codex Bridge

**Issue:** #3
**Author:** Codex
**Status:** Draft v1

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

## Trigger Model

The bridge only acts on explicit triggers visible to the bridge bot.

Supported MVP triggers:

| Trigger | Action |
|---|---|
| `/issue <title/body>` | Create a GitHub issue in `HeXiaobo/hxa-dash` |
| `/comment #<issue> <body>` | Append a GitHub issue comment |
| `/codex <title/body>` | Create a GitHub issue with a `codex-ready` label |
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
- Store only the triggered message and required metadata, not full surrounding chat history.

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
   - Runs as a PM2 sidecar worker.
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
    "allowed_sender_ids": []
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
5. Add a worker script for `lark-cli event consume im.message.receive_v1`.
6. Add Feishu acknowledgement send path.
7. Add PM2 service documentation.
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

## Open Questions

- Which Feishu bot/app should own the bridge?
- Which chats and senders should be allowlisted first?
- Should `/codex` create a new Codex desktop thread immediately, or should GitHub `codex-ready` remain the handoff contract for v1?
- Should bridge-created issues use a dedicated project board or labels only?
- Who owns production deployment and token rotation?

