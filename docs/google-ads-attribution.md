# Google Ads 广告归因与离线转化

## 业务边界

宿主网站从 URL 读取 `gclid`、`gbraid`、`wbraid`，按同一 origin、同一 LiveChat 渠道暂存最近一次有效广告访问，最长 90 天。一次访问整体保存，不将多个访问的标识拼接。首次发送聊天消息时锁定归因；失败重试沿用首次请求的快照，后续广告点击不能覆盖已锁定的归因。浏览器存储不可用时只能使用当前页面数据；不会跨域追踪或通过邮箱推测点击标识。

只有坐席在“转化事件”明确记录的 `qualify_lead`、`close_convert_lead`、`purchase` 才进入 Ads 判定流程。发送邮件、修改客户阶段和更新订单状态本身不触发回传。GA4 保留原有独立流程；两个平台各自显示状态。

在原 LiveChat 会话里使用 Email 沟通不改变归因。对于独立 Email 会话，坐席进入“转化事件 → Google Ads”，从同邮箱候选或经过确认的原 LiveChat 会话 ID 手动“确认关联”。邮箱相同不代表同一个访客，因此不会自动关联；双方渠道都需要读取及发送权限。已确认的 Email 关联不能通过此入口换绑，防止历史事件迁移到其他广告访问。

合格线索、成交线索按同一归因各记录一次，购买按同一内部订单 ID 记录一次，跨 LiveChat/Email 入口去重。重复标记不产生第二次 Ads 回传。`purchase` 只接受目标渠道同客户的已付款、非沙盒订单，金额采用订单商品小计、币种读取订单，不接受前端传金额。转化时间为后台记录时间，不回填为首次聊天或邮件时间。

## 配置与部署

### 获取 Client ID 和 Client Secret

这两个值来自 **Google Cloud 的 OAuth 2.0 Web 应用客户端**，不是 Google Ads 客户 ID、转化动作 ID 或 API Key，也不是网站点击参数。无需自己生成。

1. 打开 [Google Cloud Console](https://console.cloud.google.com/)，在顶部选择或新建一个由你管理的项目。已有 Gmail 集成可以沿用同一个 Cloud 项目，但建议为 Ads 新建独立 OAuth 客户端，避免影响已有 Gmail 授权。
2. 进入 **APIs & Services（API 和服务）→ Library（库）**，搜索 **Data Manager API** 并启用。请确认启用的是创建凭据的同一个项目。
3. 进入 **Google Auth Platform → Branding（品牌信息）**；首次使用时点击 **Get started（开始）**，按实际情况填写应用名称（例如 RelayDesk）、支持邮箱及联系邮箱。生产使用时补全控制台要求的网站、隐私政策和域名信息。
4. 在 **Audience（受众群体）** 选择适合实际使用者的类型。需要普通 Google 账号授权时使用 External；External 仍处于 Testing 时，将之后用于连接 Google Ads 的 Google 账号加入 Test users（测试用户）。发布、验证要求应按控制台提示处理，不要将测试授权等同于生产可用。
5. 在 **Data Access（数据访问）→ Add or remove scopes（添加或移除范围）** 中添加 `https://www.googleapis.com/auth/datamanager` 并保存。本集成不需要为 Ads 添加 Gmail 权限。
6. 进入 **Google Auth Platform → Clients（客户端）→ Create client（创建客户端）**，Application type 选择 **Web application（Web 应用）**，名称可填 `RelayDesk Google Ads`。不要选择 Desktop app 或创建 Service account；本项目使用服务端 Web OAuth 回调。
7. 在 **Authorized redirect URIs（已获授权的重定向 URI）** 中添加 `${PUBLIC_API_URL}/api/v1/google-ads/callback` 的实际完整地址。此处不能原样填写变量，也不要填到 Authorized JavaScript origins。比如 `PUBLIC_API_URL=https://wsdesk.geekmt.com` 时，填写 `https://wsdesk.geekmt.com/api/v1/google-ads/callback`；本地 API 使用 `http://localhost:8080` 时填写 `http://localhost:8080/api/v1/google-ads/callback`。地址必须与部署配置完全一致。
8. 点击 **Create（创建）**，在创建结果中立即复制 **Client ID** 和 **Client secret**，安全保存；如提供 Download JSON，可同时下载到私有位置。Client secret 创建后可能无法再次查看或下载，不能只关闭弹窗而不保存。已遗失时按 Google 控制台支持的方式新增／轮换密钥，并同步更新部署配置；不要先删除仍被其他服务使用的凭据。

对应关系：

| Google 创建结果 | RelayDesk 环境变量 |
| --- | --- |
| Client ID，通常以 `.apps.googleusercontent.com` 结尾 | `GOOGLE_ADS_CLIENT_ID` |
| Client secret | `GOOGLE_ADS_CLIENT_SECRET` |

Client secret 和下载的 JSON 只保存在私有服务器／密钥管理位置，不要提交仓库、放入 `NEXT_PUBLIC_*` 变量或发送到聊天中。

### 将凭据应用到服务器

使用本项目 GitHub Actions 部署时，进入仓库 **Settings → Environments → production**，在 **Environment variables** 添加 `GOOGLE_ADS_CLIENT_ID`，在 **Environment secrets** 添加 `GOOGLE_ADS_CLIENT_SECRET`，然后重新运行 **Deploy to VPS**。仅在 GitHub 保存配置不会更新正在运行的服务。

手动 Docker 部署时，将这两个变量填入与 `compose.yaml` 同目录的私有 `.env`，保留原有其他配置，再执行：

```bash
docker compose up -d --force-recreate api worker
```

仅执行 `docker compose restart` 不会让已有容器重新读取 `.env`。非 Docker 部署需向 API 和 Worker 进程传入相同环境变量，再重启两个服务；项目不会自动加载本地 `.env`。不要更换已有的 `DATA_ENCRYPTION_KEY`。

刷新 RelayDesk 的 Google Ads 设置：配置被 API 正确读取后，“服务器尚未配置 OAuth”应消失，但仍需点击授权，登录具有目标 Ads 账号权限的 Google 账号。创建 Cloud 凭据本身不会自动授权 Google Ads。

官方参考：[OAuth 客户端管理](https://support.google.com/cloud/answer/15549257?hl=en)、[Web 服务端 OAuth 与重定向地址](https://developers.google.com/identity/protocols/oauth2/web-server)、[Data Manager API 访问设置](https://developers.google.com/data-manager/api/devguides/quickstart/set-up-access)。

### 启用渠道回传

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
