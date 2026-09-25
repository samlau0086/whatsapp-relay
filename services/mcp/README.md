# RelayDesk MCP

独立的 MCP stdio 服务。服务通过 RelayDesk REST API 工作，不直接访问数据库。默认只读，写操作需要单独授权。

## 配置

```powershell
$env:RELAY_API_BASE_URL = "http://localhost:8080"
$env:RELAY_API_KEY = "rdk_..."
$env:RELAY_ACCOUNT_ID = "<account uuid>"
npm run start --prefix services/mcp
```

`RELAY_ACCOUNT_ID` 支持两种模式：填写某个账号 UUID 时只读取该 WhatsApp 账号；填写 `all` 时不限制账号范围，读取 API Key 当前有权限的全部账号。API Key 不会进入工具结果或审计日志。

写工具默认不注册。要启用，在 MCP 客户端的 `env` 中增加 `RELAY_MCP_WRITE_SCOPES`，值为逗号分隔的 `messages:send`、`conversations:write`、`contacts:write` 中所需权限，例如 `"conversations:write,contacts:write"`。同时在后台创建勾选相同 scope 的 **新 API Key**；旧密钥的权限不会自动升级。修改配置或重新构建后，要在 MCP 客户端关闭并重新启用此服务，让新进程加载配置。

启用后可使用 `send_message`（单条文本消息）、`update_conversation`（状态/收藏/已读/客户阶段）、`set_conversation_tags`（整体替换标签）、`update_contact`（姓名、公司、别名、备注等有限字段）。发送消息必须由客户端对具体操作授权、提供稳定的 UUID `idempotencyKey`，重试时沿用原键；标签整体替换也要求 `confirm: true`。`confirm` 只是调用意图声明，不能替代 MCP 客户端的人工审批。操作在 API 层再次检查 Key scope 和账号权限。暂不开放订单、删除、群发和附件发送。

`RELAY_API_BASE_URL` 必须是 **MCP 进程所在机器能访问到的 API 地址**，不能仅因为浏览器能打开工作台就使用 `localhost`。MCP 与 API 在同一台宿主机运行时可用 `http://localhost:8080`；在其他机器运行时应填写部署的公网 API 地址（或可访问的内网地址）。该地址下的 `/api/v1/contacts` 必须返回 JSON，不能返回 Web 页面的 HTML。

若工具返回 `upstream_unavailable`，检查错误中的 `message`：`Cannot connect` 表示 MCP 所在机器无法连接 API，`timeout` 表示 API 未及时响应，`non-JSON response` 表示地址/代理返回了页面，`HTTP 5xx` 表示 API 或代理报错。排查时不要将 API Key 粘贴到聊天或日志中。

## MCP 客户端配置

```json
{
  "mcpServers": {
    "relaydesk": {
      "command": "node",
      "args": ["C:/path/to/whatsapp-relay/services/mcp/dist/server.js"],
      "env": {
        "RELAY_API_BASE_URL": "http://localhost:8080",
        "RELAY_API_KEY": "rdk_...",
        "RELAY_ACCOUNT_ID": "<account uuid>"
      }
    }
  }
}
```

只读工具为 `list_conversations`、`get_conversation`、`list_messages`、`search_contacts`、`get_contact`、`list_whatsapp_groups`、`get_conversation_details` 和 `list_tags`。设置会话标签前，可先通过 `list_tags` 获取标签 ID。
