# GitHub Actions 自动部署到 VPS

推送到 `main` 后，工作流会先校验 Web、API 和 Worker，再把当前提交上传到 VPS，使用 Docker Compose 更新整套 RelayDesk 服务。数据库、Redis 和 MinIO 使用固定的 `relaydesk` Compose 项目名，因此更新版本时会继续使用原有数据卷。

## 1. 准备 VPS

VPS 需要安装 Docker Engine、Docker Compose 插件、`curl` 和 `tar`。部署用户必须能运行 `docker compose`，并且应只允许使用专用 SSH 密钥登录。

首次部署前创建服务器端环境文件：

```bash
sudo mkdir -p /opt/relaydesk/shared
sudo chown -R "$USER":"$USER" /opt/relaydesk
curl -fsSL https://raw.githubusercontent.com/OWNER/REPOSITORY/main/.env.example \
  -o /opt/relaydesk/shared/.env
chmod 600 /opt/relaydesk/shared/.env
nano /opt/relaydesk/shared/.env
```

将 `OWNER/REPOSITORY` 换成实际仓库。必须替换全部示例密码，并设置：

- `PUBLIC_API_URL=https://你的域名`（该值会在构建 Web 镜像时写入前端）
- `CORS_ORIGIN=https://你的域名`
- `BIND_ADDRESS=127.0.0.1`（让 Web 和 API 只监听 VPS 回环地址，由反向代理对外提供服务）
- 独立且足够长的 `POSTGRES_PASSWORD`、`JWT_SECRET`、`DATA_ENCRYPTION_KEY`、`ADMIN_PASSWORD`、`S3_SECRET_KEY` 和 `MINIO_ROOT_PASSWORD`

如果修改了 `.env` 中会进入 Web 构建的值，手动重新运行一次部署工作流即可。

## 2. 配置 GitHub production 环境

在仓库的 **Settings → Environments → New environment** 创建 `production`。建议只允许 `main` 部署，并按需启用人工审批。

添加 Environment secrets：

| 名称 | 内容 |
| --- | --- |
| `VPS_HOST` | VPS 域名或 IP |
| `VPS_USER` | 专用部署用户 |
| `VPS_SSH_KEY` | 专用 SSH 私钥的完整内容 |
| `WEB_PORT` | VPS 上的 Web 监听端口；未配置时默认为 `3200` |

工作流会在部署时自动获取 VPS 的 SSH 主机公钥，无需额外配置主机指纹 Secret。这简化了首次配置，但不会通过独立渠道预先核验服务器指纹。

可选 Environment variables：

| 名称 | 默认值 | 用途 |
| --- | --- | --- |
| `VPS_PORT` | `22` | SSH 端口 |
| `VPS_DEPLOY_PATH` | `/opt/relaydesk` | 服务器部署根目录；只使用不含空格的绝对路径 |

## 3. 配置 HTTPS 反向代理

只应通过 HTTPS/WSS 对外提供 Web、API 和 Agent WebSocket。反向代理需要将 `/api/`、`/agent/ws` 和 `/health` 转发到 `127.0.0.1:8080`，其余请求转发到 `127.0.0.1:3200`（或 `WEB_PORT` 配置的端口），并为 `/agent/ws` 启用 WebSocket Upgrade。防火墙不要向公网开放 PostgreSQL、Redis 或 MinIO。

## 4. 部署与回退

- 推送到 `main` 会自动部署，也可在 **Actions → Deploy to VPS → Run workflow** 手动部署。
- 新版本健康检查失败时，工作流会自动用上一个成功版本重建服务。
- 每个提交保存在 `/opt/relaydesk/releases/<commit-sha>`，`current` 指向最近成功版本。确认稳定后可人工清理旧版本目录；不要删除 `shared` 或 Docker 数据卷。

部署日志可在 GitHub Actions 中查看；服务器上可使用：

```bash
cd /opt/relaydesk/current
docker compose -p relaydesk ps
docker compose -p relaydesk logs --tail=200 web api worker
```
