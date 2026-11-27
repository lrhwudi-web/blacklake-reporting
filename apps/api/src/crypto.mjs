import { createHmac, createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export function normalizeName(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

export function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

export function fingerprintPhone(phone, secret) {
  return createHmac("sha256", secret).update(normalizePhone(phone)).digest("hex");
}

export function fingerprintText(value, secret) {
  return createHmac("sha256", secret).update(String(value)).digest("hex");
}

export function hashConfirmationCode(operatorId, code, secret) {
  return fingerprintText(`binding-code:${operatorId}:${code}`, secret);
}

export function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export function newSessionToken() {
  return randomBytes(32).toString("base64url");
}

export function newConfirmationCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function safeEqualText(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function stableHash(value) {
  const sorted = Object.keys(value).sort().reduce((result, key) => {
    result[key] = value[key];
    return result;
  }, {});
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}
