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

#### 渠道配置项说明

每个渠道名称下方的配置决定该 LiveChat 渠道的转化回传到哪个 Google Ads 账号及转化动作。“已授权 · OAuth 已配置”只代表连接已建立，不代表该渠道已经启用回传；还需完成下表配置并保存。

启用开关及五个 ID 字段的标签后提供问号图标，鼠标悬停、键盘聚焦或手机点击时显示用途和操作／获取步骤。鼠标可移入浮层继续阅读，支持 Escape 或点击外部关闭；浮层会按视口边界调整位置和滚动，不改变字段草稿或自动提交配置。

| 界面配置项 | 用途与填写方式 |
| --- | --- |
| 启用 Ads 回传 | 当前渠道的回传开关。填写并核对账号与动作后勾选，再点击“保存 Ads 配置”才生效；不影响 LiveChat 聊天或原有 GA4 流程。 |
| Google Ads 客户 ID | 接收转化、拥有下方转化动作的 Ads 账号 ID，通常是实际投放的广告账号；使用跨账号转化跟踪时需核对动作所属账号。填写不带横线的 10 位数字。例如 `123-456-7890` 填成 `1234567890`。不是 OAuth Client ID。 |
| 管理账号 ID（可选） | 通过 Google Ads 管理账号（MCC）访问目标广告账号时，填写该管理账号不带横线的 10 位 ID。直接使用目标广告账号授权时通常留空；不是坐席或管理员的用户 ID。 |
| 合格线索转化动作 ID | 对应 `qualify_lead`，将后台人工标记的合格线索回传到此动作，例如已确认客户有真实需求并符合目标客户条件。填写对应动作的数字 ID。 |
| 成交线索转化动作 ID | 对应 `close_convert_lead`，将后台人工标记的成交线索回传到此动作。它与购买是独立事件，不会自动互相触发。填写对应动作的数字 ID。 |
| 购买转化动作 ID | 对应 `purchase`，后台人工标记购买并选择符合条件的已付款订单后，回传商品小计与订单币种。填写对应动作的数字 ID。 |

三个转化动作 ID 都不是动作名称、`AW-…` 标签、转化标签字符串或完整资源路径。动作需支持从点击导入（`UPLOAD_CLICKS`）；某项留空时不回传该类事件。建议三个事件分别对应三个动作，以便区分线索质量和购买结果。

#### 获取客户 ID 和管理账号 ID

这两个值从 Google Ads 获取，不是在 Google Cloud 创建 OAuth 凭据的页面获取。

1. 登录 [Google Ads](https://ads.google.com/)，先切换到接收本渠道转化的账号。
2. 点击右上角头像／账号菜单，在账号名称下查看客户 ID；界面右上角也可能直接显示该 ID。复制后去掉横线，填写到 RelayDesk 的“Google Ads 客户 ID”。例如界面显示 `123-456-7890`，填写 `1234567890`。
3. 如果通过管理账号（MCC）访问目标账号，切换到该管理账号，点击左上角管理账号名称旁的下拉箭头，查看管理账号名称附近的客户 ID。去掉横线后填写到“管理账号 ID（可选）”。这里填管理账号自己的 ID，不要再重复填写被管理的广告账号 ID。
4. 若授权用户直接拥有目标账号访问权限，不经过管理账号访问，可将管理账号 ID 留空。填写管理账号 ID 本身不会授予权限，该管理账号必须确实能够访问目标账号。

使用 MCC 跨账号转化跟踪时，转化动作可能由管理账号而非子账号持有。Data Manager API 要求“Google Ads 客户 ID”对应的账号拥有所填转化动作；不能把子账号 ID 与其他账号创建的动作 ID 随意拼接。此时先确认 Google Ads 中的转化跟踪归属，再配置目标账号及登录管理账号。

官方参考：[查找 Google Ads 客户 ID（含管理账号）](https://support.google.com/google-ads/answer/1704344?hl=zh-Hans)、[Data Manager API 目标账号与动作归属要求](https://developers.google.com/data-manager/api/devguides/events/google-ads/offline/send-events)。

#### 获取三个转化动作 ID

三个 ID 均在 Google Ads 的转化动作详情中获取，分别对应三个独立动作；本系统不会自动替你创建 Google Ads 转化动作。

1. 在拥有转化动作的 Google Ads 账号内，进入 **Goals（目标）→ Conversions（转化）→ Summary（摘要）**。
2. 如果已有适用于本集成的动作，点击动作名称进入详情；如果尚未创建，点击 **Create conversion action（创建转化动作）**，选择 **Conversions offline（离线转化）**，按页面引导配置离线／CRM 数据来源并创建动作。部分版本入口显示为“导入”“CRM、文件或其他数据源”或“通过 API 或上传手动导入”，应选择从广告点击导入的路径，而非只通过网页标签触发的动作。
3. 分别创建／选择下表三个动作。名称可以自定义，建议包含渠道和业务阶段以便识别；名称不是要填写到 RelayDesk 的 ID。

| RelayDesk 字段 | 建议动作名称示例 | 业务类别 |
| --- | --- | --- |
| 合格线索转化动作 ID | `BelaroPrecision - Qualified lead` | 合格线索（Qualified lead） |
| 成交线索转化动作 ID | `BelaroPrecision - Converted lead` | 成交线索（Converted lead） |
| 购买转化动作 ID | `BelaroPrecision - Purchase` | 购买（Purchase），仍须使用离线点击导入动作 |

4. 打开每个动作的**详情页**，查看浏览器地址栏。若地址包含 `ctId=数字`，复制该参数的数字部分，分别填入对应字段。例如：

   ```text
   https://ads.google.com/aw/conversions/detail?...&ctId=111111111&...
   ```

   对应的转化动作 ID 为 `111111111`。不要复制 `ocid`、`cid`、整个 URL、`AW-…` 或标签设置中的 Conversion label；三项必须分别取自各自动作的详情页，不能将一个动作的 ID 填入全部三个字段。

5. 核对动作所属账号与上面的“Google Ads 客户 ID”一致，并确认动作支持 `UPLOAD_CLICKS`；Data Manager API 文档将其界面来源称为 **Website (Import from clicks)**。仅有名称或类别相符还不够，网页标签、GA4 导入等其他类型动作不能仅换个名字用于本接口。
6. 回到 RelayDesk 填入 ID，核对后勾选启用并保存；随后用受控测试事件检查投递状态。Google Ads 页面若仍提示数据来源未完成，应按当前账号向导完成适用的 API／数据来源连接，创建动作或保存 ID 本身不代表已经接收转化。

Google Ads 页面改版可能改变菜单或地址参数；如果详情页没有 `ctId`，不要猜测其他数字的含义。可由有 API 权限的技术人员查询 `conversion_action.id`、`conversion_action.name`、`conversion_action.type` 和 `conversion_action.resource_name`，确认类型与归属后取 ID。资源名如 `customers/1234567890/conversionActions/111111111` 时，本界面只填写最后的 `111111111`；RelayDesk 当前不提供自动列出或创建远端动作的功能。

参考：[Google 官方离线点击转化设置步骤](https://support.google.com/google-ads/answer/7012522?hl=zh-Hans)、[Data Manager API 动作类型要求](https://developers.google.com/data-manager/api/devguides/events/google-ads/offline/send-events)、[Google Ads API conversion_action 字段](https://developers.google.com/google-ads/api/fields/latest/conversion_action)、[Twilio 官方集成文档对详情页 ctId 的说明](https://www.twilio.com/docs/segment/connections/destinations/catalog/actions-google-enhanced-conversions)。菜单与参数说明以实际账号界面为准。

以下仅为填写格式示例，必须替换为实际账号及动作 ID，不可直接使用：

```text
Google Ads 客户 ID：1234567890
管理账号 ID：直接授权时留空
合格线索转化动作 ID：111111111
成交线索转化动作 ID：222222222
购买转化动作 ID：333333333
```

保存前注意：

- 聊天开始、发送 Email、修改客户阶段或订单状态本身不会触发 Ads 回传，必须在后台明确标记转化。
- 原 LiveChat 内的后续 Email 沟通沿用归因；独立 Email 会话必须先人工确认关联原 LiveChat，不能仅凭邮箱相同自动归因。
- 启用后不补发历史事件；没有有效广告点击标识或已明确拒绝广告数据使用的记录不会上传。
- 修改配置会停止尚未发送的旧版本事件，建议核对完成后再启用，避免频繁切换配置；已接收或处理成功也不等于最终广告归因成功。

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
