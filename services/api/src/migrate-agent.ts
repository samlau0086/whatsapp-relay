import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pool } from "./db.js";

export async function migrateAgentSchema():Promise<void>{
  const candidates=[join(process.cwd(),"migrations","014_ai_agent.sql"),join(process.cwd(),"..","..","infra","postgres","migrations","014_ai_agent.sql"),join(process.cwd(),"infra","postgres","migrations","014_ai_agent.sql")];
  let sql="";
  for(const file of candidates){try{sql=await readFile(file,"utf8");break;}catch{}}
  if(!sql)throw new Error("agent_schema_migration_missing");
  await pool.query(sql);
}
