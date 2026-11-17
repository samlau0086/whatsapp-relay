import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import {pool} from "../src/db.js";
import {config} from "../src/config.js";
import {signToken} from "../src/security.js";
import {registerMailboxRoutes} from "../src/mailbox-routes.js";

test("发件配置返回渠道 Provider 名称和地址，并按账号权限过滤且不查询密钥",async t=>{
  const statements:Array<{sql:string;values:unknown[]}>=[];
  t.mock.method(pool,"query",async(sql:string,values:unknown[]=[])=>{
    statements.push({sql,values});
    if(sql.includes("FROM account_permissions"))return {rows:[{account_id:"channel-a"}],rowCount:1};
    if(sql.includes("FROM account_email_mailboxes"))return {rows:[],rowCount:0};
    assert.match(sql,/binding\.provider_id IS NULL AND p\.is_default/);
    assert.match(sql,/p\.enabled AND p\.secret_encrypted IS NOT NULL/);
    assert.match(sql,/a\.id=ANY\(\$1\)/);
    assert.doesNotMatch(sql.split("FROM")[0],/secret|host|username|config\s*[,\n]/);
    return {rows:[{account_id:"channel-a",name:"belaroprecision.com",address:"info@belaroprecision.com",display_name:"BelaroPrecision"}],rowCount:1};
  });
  const app=Fastify();registerMailboxRoutes(app);
  try{
    assert.equal((await app.inject({url:"/api/v1/mailboxes"})).statusCode,401);
    const response=await app.inject({url:"/api/v1/mailboxes",headers:{authorization:`Bearer ${signToken({sub:"agent-a",role:"agent"},config.JWT_SECRET)}`}});
    assert.equal(response.statusCode,200);
    assert.equal(response.json().senders[0].name,"belaroprecision.com");
    assert.equal(response.json().senders[0].address,"info@belaroprecision.com");
    assert.deepEqual(response.json().data,[]);
    assert.deepEqual(statements.at(-1)?.values,[["channel-a"]]);
  }finally{await app.close();}
});
