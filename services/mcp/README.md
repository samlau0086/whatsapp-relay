# RelayDesk MCP

独立的只读 MCP stdio 服务。服务通过 RelayDesk REST API 工作，不直接访问数据库。

## 配置

```powershell
$env:RELAY_API_BASE_URL = "http://localhost:8080"
$env:RELAY_API_KEY = "rdk_..."
$env:RELAY_ACCOUNT_ID = "<account uuid>"
npm run start --prefix services/mcp
```

`RELAY_ACCOUNT_ID` 支持两种模式：填写某个账号 UUID 时只读取该 WhatsApp 账号；填写 `all` 时不限制账号范围，读取 API Key 当前有权限的全部账号。API Key 不会进入工具结果或审计日志。

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

首期工具为 `list_conversations`、`get_conversation`、`list_messages`、`search_contacts`、`get_contact`、`list_whatsapp_groups` 和 `get_conversation_details`。
