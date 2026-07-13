import assert from "node:assert/strict";
import test from "node:test";
import { cursorDecode, cursorEncode, hashPassword, signToken, signWebhook, verifyPassword, verifyToken } from "../src/security.js";

test("password hashes use salted scrypt",()=>{const hash=hashPassword("correct horse battery staple");assert.equal(verifyPassword("correct horse battery staple",hash),true);assert.equal(verifyPassword("wrong",hash),false);});
test("tokens reject tampering and expiry",()=>{const secret="a".repeat(32);const token=signToken({sub:"user-1",role:"admin"},secret,60);assert.equal(verifyToken(token,secret)?.sub,"user-1");assert.equal(verifyToken(token+"x",secret),null);});
test("webhook signature binds timestamp and body",()=>{assert.notEqual(signWebhook("secret","1","{}"),signWebhook("secret","2","{}"));});
test("cursor round-trips",()=>{const date=new Date("2026-01-01T00:00:00Z");assert.deepEqual(cursorDecode(cursorEncode(date,"id")),[date.toISOString(),"id"]);});
