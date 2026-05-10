// Server-Sent Events: push real-time updates về frontend dashboard
// Frontend subscribe: GET /api/events?pageId=<optional>

const clients = new Set();

export function sseHandler(req, res) {
  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable nginx buffering
  res.flushHeaders();

  // Initial event để client confirm connection
  res.write(`event: connected\ndata: {"ok":true,"ts":${Date.now()}}\n\n`);

  const client = {
    res,
    pageId: req.query.pageId || null, // optional filter
  };
  clients.add(client);

  // Keep-alive ping mỗi 30s
  const pingInterval = setInterval(() => {
    try {
      res.write(`: ping ${Date.now()}\n\n`);
    } catch {
      clearInterval(pingInterval);
    }
  }, 30000);

  req.on("close", () => {
    clearInterval(pingInterval);
    clients.delete(client);
  });
}

/**
 * Broadcast event tới tất cả client đang connected.
 * Nếu event có pageId, chỉ push tới client đang filter page đó (hoặc client không filter).
 */
export function broadcast(event) {
  const data = JSON.stringify(event);
  const eventType = event.type || "message";
  const payload = `event: ${eventType}\ndata: ${data}\n\n`;

  for (const client of clients) {
    // Filter: nếu client subscribe pageId cụ thể, chỉ push event của page đó
    if (client.pageId && event.pageId && client.pageId !== event.pageId) {
      continue;
    }

    try {
      client.res.write(payload);
    } catch (err) {
      clients.delete(client);
    }
  }
}
