// 使用真实组件与全局样式，不连接业务 API。
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";
import { chromium } from "playwright";

const require = createRequire(new URL("../services/api/package.json", import.meta.url));
const { build } = require("esbuild");
const root = fileURLToPath(new URL("..", import.meta.url));
const entry = `import React from 'react';
import {createRoot} from 'react-dom/client';
import {UiLab} from './app/ui-lab/ui-lab';
createRoot(document.getElementById('root')).render(<React.StrictMode><UiLab/></React.StrictMode>);`;
const bundle = await build({ stdin: { contents: entry, resolveDir: root, loader: "tsx" }, bundle: true,
  write: false, format: "iife", platform: "browser", define: { "process.env.NODE_ENV": '"development"' } });
const globalCss = (await postcss([tailwindcss()]).process(await readFile(resolve(root, "app/globals.css"), "utf8"),
  { from: resolve(root, "app/globals.css") })).css;
const css = [globalCss, await readFile(resolve(root, "app/ui/ui.css"), "utf8"),
  await readFile(resolve(root, "app/ui-lab/ui-lab.css"), "utf8")].join("\n");
const server = createServer(async (request, response) => {
  if (request.url === "/bundle.js") { response.setHeader("content-type", "text/javascript"); response.end(bundle.outputFiles[0].text); }
  else if (request.url === "/relaydesk-icon-64.png") {
    response.setHeader("content-type", "image/png"); response.end(await readFile(resolve(root, "public/relaydesk-icon-64.png")));
  } else {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script src="/bundle.js"></script></html>`);
  }
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const output = resolve(root, "outputs/ui-lab");
  await mkdir(output, { recursive: true });
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 },
    { width: 320, height: 568 }, { width: 844, height: 390 }, { width: 720, height: 500 }]) {
    const page = await browser.newPage({ viewport });
    const errors = [], apiCalls = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (request.url().includes("/api/")) apiCalls.push(request.url()); });
    await page.goto(`http://127.0.0.1:${server.address().port}/ui-lab`);
    await page.getByRole("heading", { name: "组件验收" }).waitFor();
    const boundary = page.getByRole("region", { name: "会话已结束" });
    assert.equal(await boundary.getByRole("separator").textContent(), "-------Chat Ended-------");
    await boundary.getByRole("button", { name: "发送 transcript" }).click();
    assert.equal(await page.getByRole("status").textContent(), "已选择示例历史段，未发送邮件");
    assert.equal(await page.locator(".rd-lab").evaluate(el => el.scrollWidth > el.clientWidth), false);
    assert.equal(await page.locator("img").evaluate(el => el.complete && el.naturalWidth > 0), true);
    const loadingButton = page.getByRole("button", { name: "保存配置", exact: true });
    const before = await loadingButton.boundingBox();
    await loadingButton.click();
    assert.equal(await loadingButton.isDisabled(), true);
    assert.equal(Math.round((await loadingButton.boundingBox()).width), Math.round(before.width));
    await loadingButton.waitFor({ state: "visible" });

    const selector = page.getByLabel("数据状态");
    for (const state of ["loading", "refreshing", "empty", "error", "partial", "ready"]) {
      await selector.selectOption(state);
      assert.equal(await page.locator(".rd-lab-records li").count(), ["ready", "refreshing", "partial"].includes(state) ? 3 : 0);
    }
    await selector.selectOption("error");
    await page.getByRole("button", { name: "重试", exact: true }).click();
    assert.equal(await selector.inputValue(), "ready");
    await selector.selectOption("partial");
    await page.screenshot({ path: resolve(output, `page-${viewport.width}x${viewport.height}.png`), fullPage: true });

    await page.getByRole("button", { name: "更多操作" }).click();
    const popover = page.getByRole("region", { name: "更多操作" });
    await popover.waitFor({ state: "visible" });
    await assertBounds(popover);
    await page.keyboard.press("Escape");
    await popover.waitFor({ state: "hidden" });
    await page.waitForFunction(element => element.getAttribute("aria-expanded") === "false",
      await page.getByRole("button", { name: "更多操作" }).elementHandle());
    assert.equal(await page.getByRole("button", { name: "更多操作" }).getAttribute("aria-expanded"), "false");

    const trigger = page.getByRole("button", { name: "编辑渠道", exact: true });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "编辑渠道", exact: true });
    const save = dialog.getByRole("button", { name: "保存渠道", exact: true });
    const field = dialog.getByRole("textbox", { name: "渠道名称", exact: true });
    await dialog.waitFor({ state: "visible" });
    assert.equal(await field.evaluate(el => el === document.activeElement), true);
    await assertBounds(dialog); await assertBounds(save);
    await page.mouse.click(2, 2);
    assert.equal(await dialog.isVisible(), true);
    await dialog.locator(".rd-overlay-body").evaluate(element => { element.scrollTop = element.scrollHeight; });
    await assertBounds(save);
    await save.focus(); await page.keyboard.press("Tab");
    assert.equal(await dialog.getByRole("button", { name: "关闭", exact: true }).evaluate(el => el === document.activeElement), true);
    await page.keyboard.press("Shift+Tab");
    assert.equal(await save.evaluate(el => el === document.activeElement), true);
    await field.fill("未保存的新渠道名称");
    await dialog.getByLabel("备注", { exact: true }).fill("失败后应保留的输入内容");
    await save.click();
    assert.equal(await save.isDisabled(), true);
    assert.equal(await field.isDisabled(), true);
    await page.keyboard.press("Escape");
    assert.equal(await dialog.isVisible(), true);
    await dialog.getByRole("alert").waitFor();
    await assertBounds(dialog.getByRole("alert"));
    assert.equal(await field.inputValue(), "未保存的新渠道名称");
    assert.equal(await dialog.getByLabel("备注", { exact: true }).inputValue(), "失败后应保留的输入内容");
    await assertBounds(save);
    await page.screenshot({ path: resolve(output, `error-${viewport.width}x${viewport.height}.png`) });
    await dialog.getByRole("button", { name: "渠道操作", exact: true }).click();
    const nestedPopover = dialog.getByRole("region", { name: "渠道操作" });
    await nestedPopover.waitFor({ state: "visible" }); await assertBounds(nestedPopover);
    await page.keyboard.press("Escape");
    await nestedPopover.waitFor({ state: "hidden" });
    assert.equal(await dialog.isVisible(), true);
    await page.keyboard.press("Escape");
    const confirmation = page.getByRole("alertdialog");
    await confirmation.waitFor({ state: "visible" });
    assert.equal(await confirmation.getByRole("button", { name: "继续编辑" }).evaluate(el => el === document.activeElement), true);
    await page.keyboard.press("Escape");
    await confirmation.waitFor({ state: "detached" });
    assert.equal(await dialog.isVisible(), true);
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await page.getByRole("button", { name: "放弃修改", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    assert.equal(await trigger.evaluate(el => el === document.activeElement), true);

    await trigger.click();
    await dialog.getByLabel("保存结果").selectOption("success");
    await save.click(); await dialog.waitFor({ state: "detached" });
    assert.equal(await page.locator(".rd-lab-notice").textContent(), "示例配置已保存");
    await page.getByRole("button", { name: "客户详情", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "客户详情", exact: true });
    await drawer.waitFor({ state: "visible" }); await assertBounds(drawer);
    await assertBounds(drawer.getByRole("button", { name: "完成", exact: true }));
    await page.screenshot({ path: resolve(output, `drawer-${viewport.width}x${viewport.height}.png`) });
    await page.mouse.click(2, 2); await drawer.waitFor({ state: "detached" });
    await page.getByRole("button", { name: "客户详情", exact: true }).click();
    await drawer.waitFor({ state: "visible" });
    await page.keyboard.press("Escape"); await drawer.waitFor({ state: "detached" });
    assert.deepEqual(errors, []); assert.deepEqual(apiCalls, []);
    await page.close();

    async function assertBounds(locator) {
      const bounds = await locator.boundingBox();
      assert.ok(bounds && bounds.x >= -1 && bounds.y >= -1 && bounds.x + bounds.width <= viewport.width + 1
        && bounds.y + bounds.height <= viewport.height + 1, JSON.stringify(bounds));
      assert.equal(await locator.evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
    }
  }
  console.log("UI 验收通过：5 种视口、加载尺寸、状态切换、浮层、焦点、嵌套 Escape、保存锁定、失败保留和成功关闭；无业务 API 请求。");
} finally {
  await browser?.close();
  await new Promise(done => server.close(done));
}
