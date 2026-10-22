import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source=await readFile(new URL("../app/email-html-document.ts",import.meta.url),"utf8");
const javascript=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext}}).outputText;
const {emailHtmlDocument}=await import(`data:text/javascript,${encodeURIComponent(javascript)}`);

test("email document resolves only archived CID images and restricts active content",()=>{
  const document=emailHtmlDocument('<table><tr><td><img src="cid:LOGO%40example.com"><img src="cid:missing"><a href="https://example.com">button</a></td></tr></table>',[{contentId:"logo@example.com",url:"blob:archived-image"}]);
  assert.match(document,/src="blob:archived-image"/);
  assert.match(document,/src="about:blank"/);
  assert.doesNotMatch(document,/cid:/);
  assert.match(document,/script-src 'none'/);
  assert.match(document,/connect-src 'none'/);
  assert.match(document,/form-action 'none'/);
  assert.match(document,/referrer" content="no-referrer"/);
  assert.match(document,/<table><tr><td>/);
});
