/**
 * Server-Sent Events manager
 *
 * Keeps track of all connected browser clients and lets any part of the
 * backend broadcast a JSON event to all of them at once.
 *
 * Usage (in any module):
 *   import { broadcast } from "./sse.js";
 *   broadcast({ type: "new_post", post });
 */

const clients = new Set();

/**
 * Express middleware — call this on GET /api/events.
 * Keeps the HTTP connection open and registers the response as a client.
 */
export function sseHandler(req, res) {
  // Required SSE headers
  res.writeHead(200, {
    "Content-Type":  "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection":    "keep-alive",
    // Allow the Vercel frontend (or any origin in dev) to connect
    "Access-Control-Allow-Origin":  process.env.FRONTEND_URL || "*",
    "Access-Control-Allow-Headers": "Cache-Control",
    "X-Accel-Buffering": "no", // Disable nginx buffering so events flush immediately
  });

  // Keep-alive ping every 25s so the connection doesn't time out through proxies
  res.write(": ping\n\n");
  const ping = setInterval(() => {
    try { res.write(": ping\n\n"); } catch { clearInterval(ping); }
  }, 25_000);

  // Greet the client
  send(res, { type: "connected", ts: Date.now() });

  // Register
  clients.add(res);
  console.log(`[sse] Client connected. Total: ${clients.size}`);

  // Clean up when the browser tab closes
  req.on("close", () => {
    clearInterval(ping);
    clients.delete(res);
    console.log(`[sse] Client disconnected. Total: ${clients.size}`);
  });
}

/**
 * Broadcast a JSON payload to all currently connected clients.
 * Silently removes any client whose connection has broken.
 */
export function broadcast(payload) {
  if (clients.size === 0) return;
  for (const res of clients) {
    try {
      send(res, payload);
    } catch {
      clients.delete(res);
    }
  }
  console.log(`[sse] Broadcast "${payload.type}" to ${clients.size} client(s)`);
}

function send(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}
