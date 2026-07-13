import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export class AgentStore {
  private db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive:true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,name TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'offline',last_error TEXT,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS event_outbox(cursor INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL UNIQUE,event_kind TEXT NOT NULL,payload TEXT NOT NULL,acked INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS command_inbox(sequence INTEGER PRIMARY KEY,command_id TEXT NOT NULL UNIQUE,account_id TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'received',result TEXT,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS message_map(command_id TEXT PRIMARY KEY,whatsapp_message_id TEXT,outcome TEXT NOT NULL,updated_at TEXT NOT NULL);
    `);
  }
  get(key:string):string|undefined { return (this.db.prepare("SELECT value FROM settings WHERE key=?").get(key) as {value:string}|undefined)?.value; }
  set(key:string,value:string):void { this.db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key,value); }
  upsertAccount(id:string,name:string,status:string):void { this.db.prepare("INSERT INTO accounts(id,name,status,created_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status").run(id,name,status,new Date().toISOString()); }
  accounts():unknown[] { return this.db.prepare("SELECT * FROM accounts ORDER BY created_at").all(); }
  setAccountStatus(id:string,status:string,error?:string):void { this.db.prepare("UPDATE accounts SET status=?,last_error=? WHERE id=?").run(status,error??null,id); }
  enqueueEvent(eventId:string,kind:string,payload:unknown):number { const result=this.db.prepare("INSERT OR IGNORE INTO event_outbox(event_id,event_kind,payload,created_at) VALUES(?,?,?,?)").run(eventId,kind,JSON.stringify(payload),new Date().toISOString()); if(result.changes===0){const row=this.db.prepare("SELECT cursor FROM event_outbox WHERE event_id=?").get(eventId) as {cursor:number};return row.cursor;} return Number(result.lastInsertRowid); }
  pendingEvents(limit=100):Array<{cursor:number;event_id:string;event_kind:string;payload:string}> { return this.db.prepare("SELECT cursor,event_id,event_kind,payload FROM event_outbox WHERE acked=0 ORDER BY cursor LIMIT ?").all(limit) as Array<{cursor:number;event_id:string;event_kind:string;payload:string}>; }
  ack(cursor:number):void { this.db.prepare("UPDATE event_outbox SET acked=1 WHERE cursor<=?").run(cursor); this.set("lastAckedCursor",String(cursor)); }
  saveCommand(sequence:number,commandId:string,accountId:string,payload:unknown):boolean { return this.db.prepare("INSERT OR IGNORE INTO command_inbox(sequence,command_id,account_id,payload,created_at) VALUES(?,?,?,?,?)").run(sequence,commandId,accountId,JSON.stringify(payload),new Date().toISOString()).changes===1; }
  completeCommand(commandId:string,result:unknown):void { this.db.prepare("UPDATE command_inbox SET state='completed',result=? WHERE command_id=?").run(JSON.stringify(result),commandId); }
  priorResult(commandId:string):unknown|undefined { const row=this.db.prepare("SELECT result FROM command_inbox WHERE command_id=? AND state='completed'").get(commandId) as {result:string}|undefined; return row?JSON.parse(row.result):undefined; }
}
