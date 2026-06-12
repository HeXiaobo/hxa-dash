function list(value) {
  return Array.isArray(value) ? value : [];
}

function isAllowed(value, allowedValues, allowAll = false) {
  if (allowAll) return true;
  return list(allowedValues).includes(value);
}

function shouldIgnoreSender(event, config) {
  const feishu = config.feishu || {};
  const senderType = String(event.sender_type || '').toLowerCase();
  const ignoredTypes = list(feishu.ignored_sender_types).map(type => String(type).toLowerCase());
  if (senderType && ignoredTypes.includes(senderType)) {
    return { ignored: true, reason: 'ignored_sender_type' };
  }
  if (list(feishu.bridge_bot_sender_ids).includes(event.sender_id)) {
    return { ignored: true, reason: 'bridge_bot_sender' };
  }
  return { ignored: false };
}

function evaluatePolicy(event, command, config) {
  if (!config.enabled) return { ok: false, reason: 'disabled' };
  if (!command || command.name === 'unknown') return { ok: false, reason: 'unknown_command' };
  if (command.name === 'help') return { ok: true };
  if (config.commands?.[command.name] !== true) return { ok: false, reason: 'command_disabled' };

  const feishu = config.feishu || {};
  if (!isAllowed(event.chat_id, feishu.allowed_chat_ids, feishu.allow_all_chats)) {
    return { ok: false, reason: 'chat_not_allowed' };
  }
  if (!isAllowed(event.sender_id, feishu.allowed_sender_ids, feishu.allow_all_senders)) {
    return { ok: false, reason: 'sender_not_allowed' };
  }

  const commandAllowed = feishu.command_allowed_sender_ids?.[command.name];
  if (commandAllowed && !commandAllowed.includes(event.sender_id)) {
    return { ok: false, reason: 'command_sender_not_allowed' };
  }

  if ((command.name === 'issue' || command.name === 'codex') && !command.title) {
    return { ok: false, reason: 'missing_title' };
  }
  if (command.name === 'comment' && (!command.issueNumber || !command.body)) {
    return { ok: false, reason: 'missing_comment_body' };
  }

  return { ok: true };
}

module.exports = {
  evaluatePolicy,
  shouldIgnoreSender,
};
