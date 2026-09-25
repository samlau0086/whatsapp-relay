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
