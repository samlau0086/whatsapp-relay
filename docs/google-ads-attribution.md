# Google Ads 广告归因与离线转化

## 业务边界

宿主网站从 URL 读取 `gclid`、`gbraid`、`wbraid`，按同一 origin、同一 LiveChat 渠道暂存最近一次有效广告访问，最长 90 天。一次访问整体保存，不将多个访问的标识拼接。首次发送聊天消息时锁定归因；失败重试沿用首次请求的快照，后续广告点击不能覆盖已锁定的归因。浏览器存储不可用时只能使用当前页面数据；不会跨域追踪或通过邮箱推测点击标识。

只有坐席在“转化事件”明确记录的 `qualify_lead`、`close_convert_lead`、`purchase` 才进入 Ads 判定流程。发送邮件、修改客户阶段和更新订单状态本身不触发回传。GA4 保留原有独立流程；两个平台各自显示状态。

在原 LiveChat 会话里使用 Email 沟通不改变归因。对于独立 Email 会话，坐席进入“转化事件 → Google Ads”，从同邮箱候选或经过确认的原 LiveChat 会话 ID 手动“确认关联”。邮箱相同不代表同一个访客，因此不会自动关联；双方渠道都需要读取及发送权限。已确认的 Email 关联不能通过此入口换绑，防止历史事件迁移到其他广告访问。

合格线索、成交线索按同一归因各记录一次，购买按同一内部订单 ID 记录一次，跨 LiveChat/Email 入口去重。重复标记不产生第二次 Ads 回传。`purchase` 只接受目标渠道同客户的已付款、非沙盒订单，金额采用订单商品小计、币种读取订单，不接受前端传金额。转化时间为后台记录时间，不回填为首次聊天或邮件时间。

## 配置与部署

1. 在 Google Cloud 项目启用 Data Manager API，配置 OAuth 同意屏幕与 Web 应用凭据，申请 `https://www.googleapis.com/auth/datamanager` scope。生产可用性仍取决于 Google 的账号访问、OAuth 发布及审核要求。
2. 回调地址精确配置为 `${PUBLIC_API_URL}/api/v1/google-ads/callback`，生产环境使用公开 HTTPS 地址。
3. 服务器设置 `GOOGLE_ADS_CLIENT_ID`、`GOOGLE_ADS_CLIENT_SECRET`。凭据与 Gmail OAuth 分开。自动部署读取 GitHub variable `GOOGLE_ADS_CLIENT_ID` 和 secret `GOOGLE_ADS_CLIENT_SECRET`；Compose 通过现有 `.env` 传递给 API/Worker。
4. 同步部署工作台、API、Worker。启动会执行 `112_google_ads_attribution.sql`，新增独立连接、渠道配置、首聊归因、Email 关联与事件队列，不修改历史事件。
5. 管理员打开“系统设置 → LiveChat → Google Ads”，授权具有目标 Ads 账号权限的 Google 账号，返回后“刷新授权状态”。Refresh token 加密保存；OAuth 使用一次性 state 和 PKCE，断开授权后旧授权回调不能恢复连接。
6. 为每个 LiveChat 渠道填写无横线的十位 Ads 客户 ID；使用管理账号访问时填写十位管理账号 ID。分别填写三个事件对应的数字转化动作 ID，不是动作名称、AW 标签或完整资源路径。动作应支持从点击导入（`UPLOAD_CLICKS`）。未填写的事件动作不会回传。确认配置后勾选启用并保存。

默认不启用，不因配置完成而补传历史事件。修改渠道配置或重连账号会改变版本，尚未发送的旧版本事件停止投递；需要核对事件记录，不能通过反复标记绕过去重。断开授权不会删除既有审计或已记录事件。

## 独立广告同意

Ads 不复用 GA4 的分析同意。宿主 CMP 在嵌入脚本加载完成后调用：

```javascript
RelayDeskLiveChat.setAdsConsent("公开渠道 UUID", {consent: "granted"});
// 用户拒绝或撤回时：
RelayDeskLiveChat.setAdsConsent("公开渠道 UUID", {consent: "denied"});
```

合法状态为 `unset`、`granted`、`denied`；返回 `false` 表示渠道脚本尚未注册或输入无效，宿主应在加载完成后重试。跨标签页同步依赖浏览器 storage 事件。

`unset` 按本项目的默认启用策略处理，但不发送虚假的已授权 consent；只有明确 `granted` 才发送 `adUserData: CONSENT_GRANTED`，本集成不授予广告个性化。明确 `denied` 会删除宿主点击缓存、清空后台归因标识，停止待上传事件。撤回与 Worker 上传检查通过数据库锁串行化，已经发送给 Google 的数据无法由本接口撤销。再次授权不会恢复已删除标识，也不会补发已跳过事件。网站运营方仍需按投放地区和实际使用场景确认其同意策略；本功能不替代 CMP 或合规评估。

## 投递与排障

通过 Data Manager API `events:ingest` 上传，每次只发一个事件，使用内部事件/订单 UUID 作为 transaction ID。上传字段仅包含点击标识、目标 Ads 动作、后台记录时间、内部去重标识、可选金额币种及广告同意，不发送姓名、邮箱、聊天内容、IP 或完整 URL。

- 等待回传、正在回传：Worker 尚未取得最终结果。
- API 已接收，待处理：Google 返回 request ID；Worker 后续只查询 `requestStatus:retrieve`，不会重复上传。
- Google 处理成功：API 异步处理完成，不代表 Google Ads 已成功匹配点击或已计入报表。
- 回传失败：Google 明确拒绝或处理失败；原始远程错误文本不写入事件，后台保存有限错误代码。
- 结果不确定：POST 超时、网络响应丢失、服务端 5xx、进程中断，或状态查询长期无结果。禁止盲目重传，先到 Google 侧核对。
- 无有效广告归因、已拒绝广告数据使用、未配置或配置已变更：只在后台保留标记，不上传、不自动补历史。

OAuth token 获取失败时可在尚未上传前有限退避重试。已接收请求最多查询七天；超过期限保留为不确定。Google 自身的点击有效期、转化窗口、动作配置、授权账号和数据质量仍决定最终归因。后台仅展示当前会话的记录，跨入口重复操作返回去重结果。

## 验证

在 `services/api` 执行 `npm run build`、`npm test`；根目录执行 `npm run lint`、`npm test`。

临时 PostgreSQL 回归：设置 `LIVECHAT_PG_BIN` 为 PostgreSQL bin 目录，在 `services/api` 执行 `node --import tsx --test test/livechat-analytics.postgres.test.ts test/google-ads.test.ts`。测试创建独立临时实例并模拟 Google 请求，不连接业务库。

浏览器回归：先编译 API，再于根目录运行 `node scripts/test-livechat-browser.mjs` 与 `node scripts/test-livechat-conversions-browser.mjs`。后者覆盖 Ads 配置、Email 显式关联、失败保留和多个视口；都使用模拟 API，不调用真实 Google。

真实上线前仍需用受控广告点击、测试客户和真实已授权账号，逐项核对 Ads 转化动作、处理状态、最终报表与去重。自动测试通过不能替代 Google 账号联调或保证广告优化效果。
