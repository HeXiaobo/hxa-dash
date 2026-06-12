function splitTitleAndBody(raw) {
  const lines = String(raw || '').replace(/\r\n/g, '\n').split('\n');
  const title = (lines.shift() || '').trim();
  const body = lines.join('\n').trim();
  return { title, body };
}

function parseCommand(content) {
  const text = String(content || '').trim();
  if (!text.startsWith('/')) return null;

  if (/^\/bridge\s+help\b/i.test(text) || text === '/bridge') {
    return { name: 'help' };
  }

  const issueMatch = text.match(/^\/issue(?:\s+|\n)([\s\S]+)$/i);
  if (issueMatch) {
    return { name: 'issue', ...splitTitleAndBody(issueMatch[1]) };
  }

  const codexMatch = text.match(/^\/codex(?:\s+|\n)([\s\S]+)$/i);
  if (codexMatch) {
    return { name: 'codex', ...splitTitleAndBody(codexMatch[1]) };
  }

  const commentMatch = text.match(/^\/comment\s+#?(\d+)(?:\s+|\n)?([\s\S]*)$/i);
  if (commentMatch) {
    return {
      name: 'comment',
      issueNumber: Number(commentMatch[1]),
      body: String(commentMatch[2] || '').trim(),
    };
  }

  return { name: 'unknown', raw: text };
}

module.exports = {
  parseCommand,
  splitTitleAndBody,
};
