import { config } from "./config.js";
import crypto from "node:crypto";

/**
 * Middleware bảo vệ admin/api endpoints
 * Frontend gửi mật khẩu qua header `X-Auth-Password` hoặc query `?auth=<pass>` cho SSE
 */
export function requireAuth(req, res, next) {
  const provided =
    req.headers["x-auth-password"] ||
    req.query.auth ||
    "";

  if (!provided) {
    return res.status(401).json({ error: "Missing auth password" });
  }

  // Constant-time compare
  const expected = config.auth.password;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "Invalid password" });
  }

  next();
}

/**
 * Endpoint POST /api/auth/login - kiểm tra password, trả về OK
 * Frontend gọi 1 lần lúc login, lưu password vào localStorage, gửi kèm mỗi request
 */
export function loginHandler(req, res) {
  const { password } = req.body || {};
  if (!password) {
    return res.status(400).json({ error: "Password required" });
  }

  const expected = config.auth.password;
  const a = Buffer.from(String(password));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "Invalid password" });
  }

  res.json({ ok: true });
}
