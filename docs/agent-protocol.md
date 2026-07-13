# Agent 协议 v1

Agent 通过 TLS WebSocket 主动连接 `/agent/ws`，并在 HTTP Upgrade 请求中使用设备 Bearer Credential。所有帧为 JSON。

1. Agent 发送 `hello`，包含 `protocolVersion`、Agent 版本、平台和最后确认游标。
2. 中心不支持该协议版本时返回 `incompatible` 并停止派发。
3. Agent 每 10 秒发送 `heartbeat`，携带各账号状态和本地队列深度。
4. Agent 以连续游标发送 `event_batch`。中心在事件和业务数据同一事务提交后返回 `ack`。
5. 中心通过单调递增 `sequence` 派发 `command`。Agent 先持久化命令，再执行并缓存 `command_result`。
6. 相同 `commandId` 再次到达时，Agent 返回已缓存结果，不再次执行。

传输采用至少一次语义。数据库唯一约束和稳定业务 ID 提供幂等性，不宣称跨 WhatsApp 上游的“恰好一次”。
