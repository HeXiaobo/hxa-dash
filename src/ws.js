const { WebSocketServer } = require('ws');
const { authenticateRequest } = require('./auth/middleware');

let wss = null;
const clients = new Set();
let snapshotProvider = null;

function init(server, getSnapshot) {
  snapshotProvider = getSnapshot;
  wss = new WebSocketServer({
    server,
    path: '/ws',
    verifyClient: (info, done) => {
      const result = authenticateRequest(info.req);
      if (result.ok) return done(true);
      console.warn(`[WS] Rejected unauthenticated client: ${result.code || 'unauthorized'}`);
      return done(false, result.status || 401, result.code || 'Unauthorized');
    },
  });

  wss.on('connection', (ws) => {
    clients.add(ws);
    console.log(`[WS] Client connected (${clients.size} total)`);

    // Send current snapshot to new client
    if (snapshotProvider) {
      try {
        const snapshot = snapshotProvider();
        ws.send(JSON.stringify({ type: 'snapshot', data: snapshot, ts: Date.now() }));
      } catch (err) {
        console.error('[WS] Snapshot error:', err.message);
      }
    }

    ws.on('close', () => {
      clients.delete(ws);
      console.log(`[WS] Client disconnected (${clients.size} total)`);
    });

    ws.on('error', (err) => {
      console.error('[WS] Error:', err.message);
      clients.delete(ws);
    });
  });
}

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  for (const ws of clients) {
    if (ws.readyState === 1) {
      ws.send(msg);
    }
  }
}

function sendSnapshot(data) {
  broadcast('snapshot', data);
}

function getClientCount() {
  return clients.size;
}

module.exports = { init, broadcast, sendSnapshot, getClientCount };
