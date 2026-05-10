import crypto from "node:crypto";
import { config } from "./config.js";

// AES-256-GCM cho page access token storage
// Format đầu ra: <iv_hex>:<authTag_hex>:<ciphertext_hex>

const KEY = Buffer.from(config.encryptionKey, "hex");
const ALGO = "aes-256-gcm";
const IV_LENGTH = 12; // GCM khuyến nghị 12 bytes

export function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined) return null;
  const text = String(plaintext);

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);

  const encrypted = Buffer.concat([
    cipher.update(text, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decrypt(payload) {
  if (!payload) return null;

  const parts = payload.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted payload format");
  }

  const [ivHex, authTagHex, ciphertextHex] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");

  const decipher = crypto.createDecipheriv(ALGO, KEY, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

// Generate verify token random cho mỗi page (dùng cho webhook subscription)
export function generateVerifyToken() {
  return crypto.randomBytes(16).toString("hex");
}
