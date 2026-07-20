import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pool } from "./db.js";

export async function migrateAgentSchema():Promise<void>{
  for(const migration of ["014_ai_agent.sql","016_conversation_ai_takeover.sql","017_conversation_agent_modes.sql"]){
    const candidates=[join(process.cwd(),"migrations",migration),join(process.cwd(),"..","..","infra","postgres","migrations",migration),join(process.cwd(),"infra","postgres","migrations",migration)];
    let sql="";
    for(const file of candidates){try{sql=await readFile(file,"utf8");break;}catch{}}
    if(!sql)throw new Error(`agent_schema_migration_missing:${migration}`);
    await pool.query(sql);
  }
}
