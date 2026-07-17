function initializeHealthSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_health (
      name TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      reported_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_health_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      reported_at INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ahh_name_reported
      ON agent_health_history (name, reported_at);
    CREATE INDEX IF NOT EXISTS idx_ahh_reported
      ON agent_health_history (reported_at);
    CREATE TABLE IF NOT EXISTS agent_dashboard_state (
      name TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      observed_at INTEGER,
      received_at INTEGER NOT NULL
    );
  `);
}

module.exports = { initializeHealthSchema };
