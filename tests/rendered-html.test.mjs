import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    {
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the RelayDesk inbox", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /RelayDesk/);
  assert.match(html, /GeekMT/);
  assert.match(html, /私有消息工作台/);
  assert.match(html, /与 Meta 或 WhatsApp 无隶属、赞助或背书关系/);
  assert.doesNotMatch(
    html,
    /type="password"|codex-preview|Your site is taking shape/,
  );
});

test("workspace includes the reliable-sync UI and responsive breakpoints", async () => {
  const [component, conversationRow, css] = await Promise.all([
    readFile(new URL("../app/whatsapp-inbox.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/conversation-list-row.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  const clipboard = await readFile(new URL("../app/clipboard-files.ts", import.meta.url), "utf8");
  assert.match(component, /离线队列已启用/);
  assert.match(component, /中心真实数据/);
  assert.match(component, /Agent 管理/);
  assert.match(component, /移除 Agent/);
  assert.match(component, /新建 WhatsApp 会话/);
  assert.match(component, /创建会话并发送/);
  assert.match(component, /tokenRole/);
  assert.match(component, /45_000/);
  assert.match(component, /aria-live="polite"/);
  assert.match(component, /生成一次性注册码/);
  assert.match(component, /\/api\/v1\/agents\/enrollment/);
  assert.match(component, /\/api\/v1\/agents/);
  assert.match(component, /\/api\/v1\/conversations/);
  assert.match(component, /\/api\/v1\/media/);
  assert.match(component, /EmojiPicker/);
  assert.match(component, /MediaDialog/);
  assert.match(component, /MaterialLibrarySendDialog/);
  assert.match(component, /打开素材库/);
  const materialSendDialog = await readFile(new URL("../app/material-library-send-dialog.tsx", import.meta.url), "utf8");
  assert.match(materialSendDialog, /拼接发送/);
  assert.match(materialSendDialog, /逐个发送/);
  assert.match(materialSendDialog, /竖向/);
  assert.match(materialSendDialog, /横向/);
  assert.match(materialSendDialog, /一次最多选择 10 张素材图片/);
  assert.match(materialSendDialog, /已跨库选择/);
  assert.match(materialSendDialog, /materialBatchIds/);
  assert.match(materialSendDialog, /assetCache/);
  assert.doesNotMatch(materialSendDialog, /setSelectedMediaIds\(\[\]\)/);
  assert.match(materialSendDialog, /materials\/batches/);
  assert.match(component, /onDrop=/);
  assert.match(clipboard, /clipboardData\?\.files/);
  assert.match(clipboard, /clipboardData\?\.items/);
  assert.match(clipboard, /navigator\.clipboard\?\.read/);
  assert.match(clipboard, /randomText\(7\)/);
  assert.match(component, /window\.addEventListener\("paste"/);
  assert.match(component, /拖拽文件到这里/);
  assert.match(component, /发送所选附件/);
  assert.match(component, /uploadComposerImages/);
  assert.match(component, /onPaste=\{\s*\(?event\)?\s*=>/);
  assert.match(component, /松开即可发送图片/);
  assert.match(component, /可粘贴或拖入图片发送/);
  assert.match(css, /\.composer\.image-dragging/);
  assert.match(css, /\.composer-image-drop-hint/);
  assert.doesNotMatch(
    component,
    /aria-label="添加附件" disabled|Pharah House|Penny Valeria|Richard Hammon/,
  );
  assert.match(
    css,
    /\.relay-shell \{ width:100vw; height:100vh; height:100dvh/,
  );
  assert.match(css, /border-radius:0; box-shadow:none/);
  assert.match(css, /\.new-conversation-dialog/);
  assert.match(css, /\.media-dialog/);
  assert.match(css, /\.material-send-dialog/);
  assert.match(css, /\.emoji-picker/);
  assert.match(css, /\.management-panel/);
  assert.match(css, /@media\(max-width:980px\)/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(component, /messagesRef/);
  assert.match(component, /scrollMessagesToEnd=useCallback\(\(\)=>/);
  assert.match(
    component,
    /container\.scrollTo\(\{top:container\.scrollHeight,behavior:"smooth"\}\)/,
  );
  assert.doesNotMatch(component, /scrollMessagesToEnd\("smooth"\)/);
  assert.match(component, /container\.scrollTop=container\.scrollHeight/);
  assert.match(component, /onLoad=\{onReady\}/);
  assert.match(
    css,
    /\.messages \{ flex:1 1 auto; min-height:0; overflow-y:auto/,
  );
  assert.match(
    css,
    /\.chat-panel \{ height:100%; min-height:0; display:flex; flex-direction:column; overflow:hidden/,
  );
  assert.match(
    component,
    /不要输入 WhatsApp \/ Meta 密码、短信验证码或两步验证 PIN/,
  );
  assert.match(component, /function AccessPortal/);
  assert.match(css, /\.access-shell/);
  assert.match(component, /当前会话 · AI 双向翻译/);
  assert.match(component, /此会话偏好会跨浏览器同步/);
  assert.match(component, /TranslationPreviewDialog/);
  assert.match(component, /IncomingTranslation/);
  assert.match(component, /VoiceTranslation/);
  assert.match(component, /AI 翻译语音为/);
  assert.match(component, /翻译服务暂时不可用/);
  assert.match(component, /gpt-4o-mini-transcribe/);
  assert.match(component, /conversationId/);
  assert.match(component, /\/api\/v1\/me\/translation-preferences/);
  assert.match(component, /\/api\/v1\/translations\/preview/);
  assert.match(component, /\/api\/v1\/translations\/messages/);
  assert.match(component, /cached_translation_text/);
  assert.match(component, /cachedTranslations/);
  assert.match(component, /Custom Provider/);
  assert.match(component, /gpt-5\.6-luna/);
  assert.match(css, /\.translation-menu/);
  assert.match(css, /\.incoming-translation/);
  assert.match(css, /\.voice-translate-action/);
  assert.match(css, /\.settings-tabs/);
  assert.match(component, /原文（仅坐席可见）/);
  assert.match(component, /translationSourceText/);
  assert.match(component, /generateAudio/);
  assert.match(component, /value\.status==="idle"/);
  assert.match(css, /\.outgoing-translation-source/);
  assert.match(component, /CrmDetailsPanel/);
  assert.match(component, /function ContactManagement/);
  assert.match(component, /function ContactEditDialog/);
  assert.match(component, /function ContactCreateDialog/);
  assert.match(component, /function ContactAvatar/);
  assert.match(component, /function ContactAddressDialog/);
  assert.match(component, /\/api\/v1\/contacts/);
  assert.match(component, /Primary Email/);
  assert.match(component, /编辑联系人/);
  assert.match(css, /\.contact-management/);
  assert.match(css, /\.contact-dialog/);
  assert.match(css, /label\.primary-email-radio input\[type="radio"\]/);
  assert.match(css, /\.contact-address-grid/);
  assert.match(css, /\.contact-avatar-editor/);
  assert.match(component, /创建订单/);
  assert.match(component, /编辑订单/);
  assert.match(component, /重新发送/);
  assert.match(component, /英文原文/);
  assert.match(component, /order-send-mode/);
  assert.match(conversationRow, /conversation-stage stage-\$\{stageValue\(item\.customerStage\)\}/);
  assert.match(component, /last_message_direction/);
  assert.match(component, /last_message_status/);
  assert.match(conversationRow, /ArrowDownLeft/);
  assert.match(conversationRow, /ArrowUpRight/);
  assert.match(css, /\.conversation-direction\.in/);
  assert.match(css, /\.conversation-direction\.out\.sent/);
  assert.match(css, /\.conversation-direction\.out\.delivered/);
  assert.match(css, /\.conversation-direction\.out\.uncertain/);
  assert.match(css, /\.conversation-direction\.out\.failed/);
  assert.match(css, /\.conversation-meta>\.stage-new/);
  assert.match(css, /\.conversation-meta>\.stage-considering/);
  assert.match(css, /\.conversation-meta>\.stage-qualified/);
  assert.match(css, /\.conversation-meta>\.stage-won/);
  assert.match(css, /\.conversation-meta>\.stage-lost/);
  assert.doesNotMatch(component, /order-send-english/);
  assert.match(component, /目标翻译语言/);
  assert.match(component, /LanguagePicker value=\{targetLanguage\}/);
  assert.match(component, /setTranslate\(false\)/);
  assert.match(component, /clientSendId\s*:\s*crypto\.randomUUID/);
  assert.match(component, /method\s*:\s*order\s*\?\s*"PATCH"\s*:\s*"POST"/);
  assert.match(component, /客户阶段/);
  assert.match(component, /我的提醒/);
  assert.match(component, /添加团队共享备注/);
  assert.match(component, /新标签名称/);
  assert.match(component, /添加商品/);
  assert.match(component, /Additional fees/);
  assert.doesNotMatch(component, /AI translation on send/);
  assert.match(component, /defaultTargetLanguage=\{translationPreference\.customerLanguage\}/);
  assert.match(component, /useState\(!isEnglishLanguage\(initialTargetLanguage\)\)/);
  assert.match(component, /Save order draft/);
  assert.match(component, /orders\/\$\{order\.id\}\/send/);
  assert.match(component, /按当前模板重新生成/);
  assert.match(component, /JSON\.stringify\(\{regenerate:true\}\)/);
  assert.match(component, /item\.sku\?`\$\{item\.sku\} · `/);
  assert.match(component, /Sandbox 与 Live 凭据分别加密保存/);
  assert.match(component, /sandboxClientId:credentials\.sandbox\.clientId/);
  assert.match(component, /liveClientId:credentials\.live\.clientId/);
  assert.match(component, /method:"DELETE"/);
  assert.match(component, /文字版详情/);
  assert.match(component, /图片版完整详情/);
  assert.match(component, /不会撤回已发送的 WhatsApp 消息/);
  assert.match(component, /\/api\/v1\/tasks\?contactId=/);
  assert.match(component, /快捷添加/);
  assert.match(component, /该联系人暂无任务/);
  assert.match(css, /\.crm-details/);
  assert.match(css, /\.details-backdrop/);
  assert.match(css, /\.order-builder/);
  assert.match(css, /\.order-send-options/);
  assert.match(css, /\.order-send-language/);
  assert.match(css, /max-height:calc\(100dvh - 100px\)/);
  assert.match(css, /touch-action:pan-y/);
  assert.match(css, /\.order-edit/);
  assert.match(css, /\.order-delete/);
  assert.match(component, /ProductManagement/);
  assert.match(component, /团队共享目录/);
  assert.match(component, /\/api\/v1\/products\?limit=100/);
  assert.match(component, /\/api\/v1\/products\/media/);
  assert.match(component, /clientProductId/);
  assert.match(component, /历史商品 · 不自动入库/);
  assert.match(component, /产品库已有同名产品/);
  assert.match(css, /\.product-grid/);
  assert.match(css, /\.product-dialog/);
  assert.match(component, /全选本页/);
  assert.match(component, /ProductBulkEditDialog/);
  assert.match(component, /\/api\/v1\/products\/bulk-edit/);
  assert.match(component, /按比例增加/);
  assert.match(css, /\.product-bulk-toolbar/);
  assert.match(css, /\.product-bulk-dialog/);
  assert.match(component, /PRODUCT_PAGE_SIZES = \[24,32,36,48,64\]/);
  assert.match(component, /每页产品数/);
  assert.match(css, /\.product-page-size/);
  assert.match(css, /\.order-product-mode/);
  assert.match(component, /ProductSearchDropdown/);
  assert.match(component, /role="combobox"/);
  assert.match(component, /搜索产品名称、SKU、价格或标签/);
  assert.match(component, /ProductCardSendDialog/);
  assert.match(component, /产品卡片模板/);
  assert.match(component, /priceTiers/);
  assert.match(css, /\.product-card-send-dialog/);
  assert.match(css, /\.product-tier-editor/);
  assert.match(css, /\.product-search-dropdown/);
  assert.match(component, /AI Agent/);
  assert.match(component, /TaskCenter/);
  assert.match(component, /任务中心/);
  assert.match(component, /TaskAgentSettingsPanel/);
  assert.match(component, /知识库/);
  assert.match(component, /编辑知识库/);
  assert.match(component, /删除知识库/);
  assert.match(css, /\.knowledge-item-actions/);
  assert.match(component, /聊天记忆/);
  assert.match(component, /谨慎接管/);
  assert.match(component, /完全接管/);
  assert.match(component, /人工接管/);
  assert.match(component, /会话接管方式/);
  assert.match(component, /conversations\/\$\{conversationId\}\/agent/);
  assert.match(css, /\.takeover-switch/);
  assert.match(component, /确认发送/);
  assert.match(component, /中文参考/);
  assert.match(component, /reply_zh/);
  assert.match(css, /\.agent-draft-copy/);
});

test("modal backdrops do not dismiss dialogs", async () => {
  const modalSources = await Promise.all([
    "product-card-send-dialog.tsx",
    "product-editor-dialog.tsx",
    "product-image-media-dialog.tsx",
    "product-import-dialog.tsx",
    "whatsapp-inbox.tsx",
  ].map((file) => readFile(new URL(`../app/${file}`, import.meta.url), "utf8")));

  assert.doesNotMatch(modalSources.join("\n"), /event\.target\s*===\s*event\.currentTarget/);
});

test("product workspace stays inside one root grid item", async () => {
  const [component,inbox,css]=await Promise.all([
    readFile(new URL("../app/collage-materials.tsx",import.meta.url),"utf8"),
    readFile(new URL("../app/whatsapp-inbox.tsx",import.meta.url),"utf8"),
    readFile(new URL("../app/globals.css",import.meta.url),"utf8"),
  ]);
  assert.match(component,/return <div className="product-workspace"><nav className="product-workspace-tabs">/);
  assert.match(css,/\.product-workspace\{grid-column:2\/-1;/);
  assert.match(css,/\.product-workspace>\.management-panel\{grid-column:auto;flex:1;/);
  assert.match(component,/applyGridPreset\(2\)/);
  assert.match(component,/applyGridPreset\(3\)/);
  assert.match(component,/applyGridPreset\(4\)/);
  assert.match(component,/applyGridPreset\(customRows,customColumns\)/);
  assert.match(component,/sourceProductTexts=sourceImage\?draft\.layers\.filter/);
  assert.match(component,/\{\.\.\.sourceText,id:`product-text-\$\{index\}-\$\{textIndex\+1\}`,slotId/);
  assert.doesNotMatch(inbox,/onOpenMaterials/);
  assert.match(inbox,/onGenerated=\{\(\)=>\{setGenerating\(false\);setSelected\(\[\]\);onToast\("拼图素材已生成"\);\}\}/);
  assert.match(component,/>Padding<input/);
  assert.match(component,/className="canvas-padding-guide"/);
  assert.match(css,/\.collage-grid-presets\{/);
  assert.match(css,/\.collage-custom-grid\{/);
  assert.match(css,/\.canvas-padding-guide\{/);
});

test("workspace navigation is URL based", async () => {
  const [component, route] = await Promise.all([
    readFile(new URL("../app/whatsapp-inbox.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/[view]/page.tsx", import.meta.url), "utf8"),
  ]);
  for (const view of ["inbox", "contacts", "tasks", "orders", "products", "agents", "settings", "help"]) {
    assert.match(component, new RegExp(`${view}:"/${view}"`));
    assert.match(route, new RegExp(`"${view}"`));
  }
  assert.match(component, /router\.push\(WORKSPACE_PATHS\[nextView\]\)/);
  assert.match(component, /const pathView=pathname\.split\("\/"\)\[1\] as WorkspaceView/);
  assert.match(component, /const view=pathView in WORKSPACE_PATHS\?pathView:initialView/);
});

test("task requests stay stable and the realtime feed is scoped to inbox", async () => {
  const [component,feed] = await Promise.all([
    readFile(new URL("../app/whatsapp-inbox.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/use-conversation-feed.ts", import.meta.url), "utf8"),
  ]);
  assert.match(component, /const taskRequest=useCallback\(\(path:string,init\?:RequestInit\)=>authorizedFetch\(path,apiToken,init\),\[apiToken\]\)/);
  assert.match(component, /<TaskCenter\s+token=\{apiToken\}\s+accounts=\{accounts\}\s+request=\{taskRequest\}/);
  assert.doesNotMatch(component, /<TaskCenter[^>]+request=\{\(path,init\)=>authorizedFetch/);
  assert.match(component, /enabled:view==="inbox"&&Boolean\(apiToken\)/);
  assert.match(feed, /60_000/);
  assert.doesNotMatch(component, /setInterval\(\(\)=>void loadConversations\(apiToken/);
  assert.match(component, /if\(view!=="inbox"\|\|!apiToken\|\|!effectiveActiveId\)return;const initial=/);
});

test("agent provider reload selects the enabled provider", async () => {
  const component = await readFile(new URL("../app/whatsapp-inbox.tsx", import.meta.url), "utf8");
  assert.match(
    component,
    /setProviderId\(value=>body\.data\.find\(item=>item\.enabled\)\?\.provider\?\?\(body\.data\.some\(item=>item\.provider===value\)\?value:"openai"\)\)/,
  );
  assert.doesNotMatch(
    component,
    /setProviderId\(value=>body\.data\.some\(item=>item\.provider===value\)\?value:\(body\.data\.find\(item=>item\.enabled\)\?\.provider\?\?"openai"\)\)/,
  );
});

test("inbox supports replying to a specific WhatsApp message", async () => {
  const [component,css]=await Promise.all([
    readFile(new URL("../app/whatsapp-inbox.tsx",import.meta.url),"utf8"),
    readFile(new URL("../app/globals.css",import.meta.url),"utf8"),
  ]);
  assert.match(component,/quotedMessageId:quoted\.id/);
  assert.match(component,/className="message-reply-action"/);
  assert.match(component,/className="composer-reply-preview"/);
  assert.match(component,/function QuotedMessage/);
  assert.match(css,/\.quoted-message\{/);
  assert.match(css,/\.composer-reply-preview\{/);
});

test("inbox quick replies support search, media types, and conversation translation", async () => {
  const [component,css]=await Promise.all([
    readFile(new URL("../app/whatsapp-inbox.tsx",import.meta.url),"utf8"),
    readFile(new URL("../app/globals.css",import.meta.url),"utf8"),
  ]);
  assert.match(component,/function QuickReplyDropdown/);
  assert.match(component,/placeholder="搜索标题、内容或标签"/);
  assert.match(component,/\["text","文本"\]/);
  assert.match(component,/\["image","图文"\]/);
  assert.match(component,/\["audio","语音"\]/);
  assert.match(component,/\["video","视频"\]/);
  assert.match(component,/\["document","文件"\]/);
  assert.match(component,/translationEnabled/);
  assert.match(component,/sendQuickReplyMedia/);
  assert.match(component,/targetLanguage:translationPreference\.customerLanguage/);
  assert.match(component,/className="message-save-quick-reply"/);
  assert.match(component,/aria-label="加入快捷回复"/);
  assert.match(component,/function addMessageToQuickReplies/);
  assert.match(component,/quickReplyStorageKey/);
  assert.match(component,/savedReplies=\{savedQuickReplies\}/);
  assert.match(component,/item\.sourceMessageId!==message\.id/);
  assert.match(component,/function QuickReplyEditorDialog/);
  assert.match(component,/aria-label="新增快捷回复"/);
  assert.match(component,/编辑 \$\{item\.title\}/);
  assert.match(component,/删除 \$\{item\.title\}/);
  assert.match(component,/function saveQuickReply/);
  assert.match(component,/function deleteQuickReply/);
  assert.match(component,/loadQuickReplyStore/);
  assert.match(css,/\.quick-reply-menu\{/);
  assert.match(css,/\.quick-reply-options\{/);
  assert.match(css,/\.quick-reply-options\{flex:1 1 auto;min-height:0;/);
  assert.match(css,/\.composer-tools \.quick-reply-options>button\{place-items:initial;/);
  assert.match(css,/\.quick-reply-filters\{min-height:42px;/);
  assert.match(css,/\.message-actions\{/);
  assert.match(css,/\.message-save-quick-reply/);
  assert.match(css,/\.quick-reply-item-actions\{/);
  assert.match(css,/\.quick-reply-editor-dialog\{/);
});

test("failed and uncertain messages expose a manual resend action", async () => {
  const [component,css,server]=await Promise.all([
    readFile(new URL("../app/whatsapp-inbox.tsx",import.meta.url),"utf8"),
    readFile(new URL("../app/globals.css",import.meta.url),"utf8"),
    readFile(new URL("../services/api/src/server.ts",import.meta.url),"utf8"),
  ]);
  assert.match(component,/message\.status==="failed"\|\|message\.status==="uncertain"/);
  assert.match(component,/重新发送这条消息/);
  assert.match(component,/消息可能已经送达/);
  assert.match(component,/api\/v1\/messages\/\$\{message\.id\}\/retry/);
  assert.match(css,/\.message-retry-action\{/);
  assert.match(css,/\.message-queue-diagnostic\{/);
  assert.match(component,/if\(ids\.includes\(effectiveActiveId\)\)await loadMessages\(apiToken,effectiveActiveId\)/);
  assert.match(component,/function QueueDiagnostic/);
  assert.match(server,/LEFT JOIN LATERAL \(SELECT oc\.id,oc\.state,oc\.attempt,oc\.last_error/);
  assert.match(server,/app\.post\("\/api\/v1\/messages\/:id\/retry"/);
  assert.match(server,/UPDATE messages SET status='queued',failure_code=NULL,failure_message=NULL,whatsapp_message_id=NULL/);
  assert.match(server,/messageId:id,status:"queued"/);
  assert.doesNotMatch(server,/retryOfMessageId/);
  assert.match(component,/className="clear-failed-messages-button"/);
  assert.match(component,/clearFailedMessages/);
  assert.match(component,/清除失败消息/);
  assert.match(css,/\.clear-failed-messages-button\{/);
  assert.match(server,/app\.delete\("\/api\/v1\/conversations\/:id\/messages\/failed"/);
  assert.match(server,/status IN \('failed','uncertain'\)/);
});
