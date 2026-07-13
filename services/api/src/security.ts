import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

function b64(value: string | Buffer): string { return Buffer.from(value).toString("base64url"); }

export function hashPassword(password: string, salt = randomBytes(16).toString("hex")): string {
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString("hex")}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  const [algorithm, salt, expectedHex] = encoded.split("$");
  if (algorithm !== "scrypt" || !salt || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, "hex");
  const actual = scryptSync(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function signToken(payload: Record<string, unknown>, secret: string, ttlSeconds = 900): string {
  const now = Math.floor(Date.now() / 1000);
  const body = b64(JSON.stringify({ ...payload, iat: now, exp: now + ttlSeconds }));
  const header = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const signature = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
}

export function verifyToken(token: string, secret: string): Record<string, unknown> | null {
  const [header, body, signature] = token.split(".");
  if (!header || !body || !signature) return null;
  const actual = createHmac("sha256", secret).update(`${header}.${body}`).digest();
  const expected = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
  return typeof payload.exp === "number" && payload.exp > Date.now() / 1000 ? payload : null;
}

export const hashSecret = (secret: string): string => createHash("sha256").update(secret).digest("hex");
export const signWebhook = (secret: string, timestamp: string, body: string): string => `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;

export function encryptAtRest(value:string,masterKey:string):string{const key=createHash("sha256").update(masterKey).digest();const iv=randomBytes(12);const cipher=createCipheriv("aes-256-gcm",key,iv);const encrypted=Buffer.concat([cipher.update(value,"utf8"),cipher.final()]);return `v1:${Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString("base64url")}`;}
export function decryptAtRest(value:string,masterKey:string):string{if(!value.startsWith("v1:"))throw new Error("Unsupported encrypted value");const packed=Buffer.from(value.slice(3),"base64url");const key=createHash("sha256").update(masterKey).digest();const decipher=createDecipheriv("aes-256-gcm",key,packed.subarray(0,12));decipher.setAuthTag(packed.subarray(12,28));return Buffer.concat([decipher.update(packed.subarray(28)),decipher.final()]).toString("utf8");}

export function cursorEncode(date: Date, id: string): string { return b64(JSON.stringify([date.toISOString(), id])); }
export function cursorDecode(cursor?: string): [string, string] | null {
  if (!cursor) return null;
  try { const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); return Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "string" ? [value[0],value[1]] : null; } catch { return null; }
}
