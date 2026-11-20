import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {existsSync} from "node:fs";
import {mkdtemp,mkdir,readFile,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

const bash=[process.env.DEPLOY_TEST_BASH,"/bin/bash","C:/Program Files/Git/bin/bash.exe"].find(path=>path&&existsSync(path));

test("部署重试和回滚前收集 API 日志，诊断失败不掩盖原始退出码",{skip:!bash},async()=>{
  const workflow=await readFile(new URL("../../../.github/workflows/deploy-vps.yml",import.meta.url),"utf8");
  const activate=workflow.slice(workflow.indexOf("- name: Activate release"));
  const remote=activate.match(/<<'REMOTE'\r?\n([\s\S]*?)\r?\n          REMOTE/);
  assert.ok(remote,"应找到完整远程部署脚本");
  const syntax=spawnSync(bash!,["-n"],{encoding:"utf8",input:remote[1].replace(/^          /gm,"").replace(/\r\n/g,"\n")});
  assert.equal(syntax.status,0,syntax.stderr);
  const helpers=activate.slice(activate.indexOf("          deployment_diagnostics()"),activate.indexOf("          trap rollback ERR"));
  assert.ok(helpers.includes("deployment_diagnostics()"));
  const retry=activate.slice(activate.indexOf("for attempt in 1 2 3 4 5"),activate.indexOf("for attempt in $(seq 1 90)"));
  assert.ok(retry.includes("deployment_diagnostics"));
  assert.ok(retry.indexOf("deployment_diagnostics")<retry.indexOf('if [ "$attempt" -eq 5 ]'));
  const directory=await mkdtemp(join(tmpdir(),"relay-deploy-diagnostics-test-"));
  try{
    for(const name of ["release","previous"]){await mkdir(join(directory,name));await writeFile(join(directory,name,"compose.yaml"),"services: {}\n");}
    const result=spawnSync(bash!,["-s"],{encoding:"utf8",env:{...process.env,DEPLOY_FIXTURE:directory},input:`
      release="$DEPLOY_FIXTURE/release"
      previous="$DEPLOY_FIXTURE/previous"
      web_port=3200
      env_changed=1
      had_shared_env=1
      env_backup="$release/compose.yaml"
      shared_env=unused
      install() { echo RESTORE_ENV >&2; }
      docker() {
        echo "DOCKER $*" >&2
        case "$*" in
          *"ps --all --quiet api") echo fixture-api; return 0 ;;
          *" logs "*) return 9 ;;
          *"inspect --format"*) return 8 ;;
          *" up "*) return 7 ;;
        esac
      }
      `+helpers+`
      (exit 42)
      rollback
    `});
    assert.equal(result.status,42,result.stderr);
    assert.match(result.stderr,/--tail=200 api postgres worker web gateway minio minio-init/);
    assert.match(result.stderr,/inspect --format .*fixture-api/);
    assert.ok(result.stderr.indexOf("--tail=200 api postgres worker")<result.stderr.indexOf("RESTORE_ENV"));
    assert.match(result.stderr,/Rollback failed\. Database migrations were not reversed/);
    assert.match(result.stderr,/--tail=200 api postgres\s/);
  }finally{await rm(directory,{recursive:true,force:true});}
});
