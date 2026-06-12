const path = require('path');
const Database = require('better-sqlite3');

class BridgeAuditStore {
  constructor(dbPath = path.join(__dirname, '..', '..', 'bridge.db')) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bridge_events (
        message_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        sender_id TEXT,
        command TEXT NOT NULL,
        github_issue_number INTEGER,
        github_comment_id INTEGER,
        status TEXT NOT NULL,
        error TEXT,
        created_at INTEGER NOT NULL,
        processed_at INTEGER NOT NULL
      )
    `);
    this.reserveStmt = this.db.prepare(`
      INSERT INTO bridge_events (
        message_id, chat_id, sender_id, command, status, created_at, processed_at
      ) VALUES (?, ?, ?, ?, 'processing', ?, ?)
    `);
    this.getStmt = this.db.prepare('SELECT * FROM bridge_events WHERE message_id = ?');
    this.updateStmt = this.db.prepare(`
      UPDATE bridge_events
      SET status = @status,
          github_issue_number = @github_issue_number,
          github_comment_id = @github_comment_id,
          error = @error,
          processed_at = @processed_at
      WHERE message_id = @message_id
    `);
  }

  reserve(event, command, now = Date.now()) {
    try {
      this.reserveStmt.run(
        event.message_id,
        event.chat_id,
        event.sender_id || null,
        command.name,
        now,
        now
      );
      return { inserted: true, row: this.get(event.message_id) };
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
        return { inserted: false, row: this.get(event.message_id) };
      }
      throw err;
    }
  }

  update(messageId, patch, now = Date.now()) {
    this.updateStmt.run({
      message_id: messageId,
      status: patch.status,
      github_issue_number: patch.github_issue_number ?? null,
      github_comment_id: patch.github_comment_id ?? null,
      error: patch.error ?? null,
      processed_at: now,
    });
    return this.get(messageId);
  }

  get(messageId) {
    return this.getStmt.get(messageId) || null;
  }

  close() {
    this.db.close();
  }
}

module.exports = {
  BridgeAuditStore,
};
