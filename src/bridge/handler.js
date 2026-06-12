const { parseCommand } = require('./parser');
const { evaluatePolicy, shouldIgnoreSender } = require('./policy');

function sourceBlock(event) {
  return [
    '---',
    'Source: Feishu',
    `Chat: ${event.chat_id}`,
    `Message: ${event.message_id}`,
    `Sender: ${event.sender_name || 'Unknown'} (${event.sender_id || 'unknown'})`,
    `Sent at: ${new Date(event.created_at || Date.now()).toISOString()}`,
    `Link: ${event.message_link || ''}`,
  ].join('\n');
}

function issueBody(command, event) {
  return [command.body || '', sourceBlock(event)].filter(Boolean).join('\n\n');
}

function codexBody(command, event) {
  return [
    '## Problem',
    '',
    command.body || command.title,
    '',
    '## Scope',
    '',
    '<files, product area, or system boundary if known>',
    '',
    '## Acceptance Criteria',
    '',
    '- <observable outcome>',
    '',
    '## Source Links',
    '',
    `- Feishu message: ${event.message_link || event.message_id}`,
    '',
    sourceBlock(event),
  ].join('\n');
}

function duplicateAck(row) {
  if (row.github_issue_number) return `Already processed: GitHub issue #${row.github_issue_number}`;
  if (row.github_comment_id) return `Already processed: GitHub comment ${row.github_comment_id}`;
  return `Already processed with status ${row.status}`;
}

async function handleBridgeEvent(event, { config, store, writer, now = Date.now } = {}) {
  const ignoredSender = shouldIgnoreSender(event, config);
  if (ignoredSender.ignored) {
    return { action: 'ignored', reason: ignoredSender.reason, acknowledge: false };
  }

  const command = parseCommand(event.content);
  if (!command) return { action: 'ignored', reason: 'not_a_command', acknowledge: false };
  if (command.name === 'help') {
    return {
      action: 'help',
      acknowledge: true,
      ack: 'Supported commands: /issue <title>\\n<body>, /comment #<issue> <body>, /codex <title>\\n<body>',
    };
  }

  const policy = evaluatePolicy(event, command, config);
  if (!policy.ok) {
    return {
      action: 'rejected',
      reason: policy.reason,
      acknowledge: command.name !== 'unknown',
      ack: policy.reason === 'disabled' ? 'Bridge is disabled' : 'Not allowed',
    };
  }

  const reservation = store.reserve(event, command, now());
  if (!reservation.inserted) {
    return {
      action: 'duplicate',
      row: reservation.row,
      acknowledge: true,
      ack: duplicateAck(reservation.row),
    };
  }

  if (config.dry_run) {
    const row = store.update(event.message_id, { status: 'dry_run' }, now());
    return {
      action: 'dry_run',
      row,
      acknowledge: true,
      ack: `Dry run: would ${command.name === 'comment' ? `comment on #${command.issueNumber}` : `create ${command.name} issue "${command.title}"`}`,
    };
  }

  try {
    if (command.name === 'comment') {
      const comment = await writer.createComment(command.issueNumber, issueBody(command, event));
      const row = store.update(event.message_id, {
        status: 'created_comment',
        github_comment_id: comment.id,
      }, now());
      return {
        action: 'created_comment',
        row,
        acknowledge: true,
        ack: `Commented on #${command.issueNumber}: ${comment.html_url || ''}`.trim(),
      };
    }

    const issue = await writer.createIssue({
      title: command.title,
      body: command.name === 'codex' ? codexBody(command, event) : issueBody(command, event),
      labels: command.name === 'codex' ? ['source:feishu', 'codex-ready'] : ['source:feishu', 'needs-triage'],
    });
    const row = store.update(event.message_id, {
      status: 'created_issue',
      github_issue_number: issue.number,
    }, now());
    return {
      action: 'created_issue',
      row,
      acknowledge: true,
      ack: `Created GitHub issue #${issue.number}: ${issue.html_url || ''}`.trim(),
    };
  } catch (err) {
    const row = store.update(event.message_id, {
      status: 'failed',
      error: err.message,
    }, now());
    return {
      action: 'failed',
      row,
      acknowledge: true,
      ack: 'Bridge failed to write to GitHub; retry may be safe after checking the audit row.',
    };
  }
}

module.exports = {
  codexBody,
  handleBridgeEvent,
  issueBody,
  sourceBlock,
};
