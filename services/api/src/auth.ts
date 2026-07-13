import type { FastifyReply, FastifyRequest } from "fastify";
import { pool } from "./db.js";
import { config } from "./config.js";
import { hashSecret, verifyToken } from "./security.js";

export type Principal = { kind: "user" | "api_key"; id: string; role?: string; scopes: string[]; accountIds?: string[] };

declare module "fastify" { interface FastifyRequest { principal?: Principal } }

export async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) { await reply.code(401).send({ error: "unauthorized", message: "缺少访问凭据" }); return; }
  const token = authorization.slice(7);
  if (token.startsWith("rdk_")) {
    const result = await pool.query("SELECT id,scopes,account_ids FROM api_keys WHERE secret_hash=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())", [hashSecret(token)]);
    if (!result.rowCount) { await reply.code(401).send({ error: "invalid_api_key" }); return; }
    request.principal = { kind:"api_key", id:result.rows[0].id, scopes:result.rows[0].scopes, accountIds:result.rows[0].account_ids ?? undefined };
    void pool.query("UPDATE api_keys SET last_used_at=now() WHERE id=$1", [result.rows[0].id]);
    return;
  }
  const payload = verifyToken(token, config.JWT_SECRET);
  if (!payload?.sub || !payload.role) { await reply.code(401).send({ error: "invalid_token" }); return; }
  request.principal = { kind:"user", id:String(payload.sub), role:String(payload.role), scopes:["*"] };
}

export function canAccessAccount(principal: Principal | undefined, accountId: string): boolean {
  return Boolean(principal && (!principal.accountIds || principal.accountIds.includes(accountId)));
}
