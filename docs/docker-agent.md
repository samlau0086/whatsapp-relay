# Docker Relay Agent 部署

Docker Agent 是 Windows 桌面 Agent 的 Linux 版本，带有浏览器管理界面。一个容器可管理多个 WhatsApp 账号；每个账号都有独立的登录会话、二维码和执行器。运行状态、登录会话和待同步事件保存在 Docker volume 中，因此升级或重启不会要求重新扫码。

> 容器需要能访问公网 RelayDesk HTTPS/WSS 地址和 WhatsApp。它不需要开放入站端口。

## 1. 创建 Agent 注册码

登录 RelayDesk，在 **设置 → Agent 管理** 中为 Docker Agent 生成一次性注册码。注册码有效期为 15 分钟。

## 2. 配置并启动

在服务器上复制 `apps/agent/compose.yaml` 和 `apps/agent/.env.docker.example`，然后把示例文件另存为本地私有的 `.env`。不要直接修改仓库里的示例文件；`.env` 里至少填写：

```bash
mkdir -p /opt/relaydesk-agent && cd /opt/relaydesk-agent
curl -fsSLO https://raw.githubusercontent.com/samlau0086/whatsapp-relay/main/apps/agent/compose.yaml
curl -fsSLo .env https://raw.githubusercontent.com/samlau0086/whatsapp-relay/main/apps/agent/.env.docker.example
chmod 600 .env
```

- `RELAY_CENTRAL_URL`：RelayDesk 对外 HTTPS 根地址，例如 `https://relay.example.com`。
- `RELAY_ENROLLMENT_CODE`：刚生成的一次性注册码。
- `RELAY_MASTER_KEY`：执行 `openssl rand -hex 32` 生成的 64 位十六进制密钥。

`RELAY_ACCOUNT_ID` 和 `RELAY_ACCOUNT_NAME` 是可选的兼容配置：仅在全新 Docker volume 首次启动时预创建第一个账号。通常保持 `RELAY_ACCOUNT_ID` 为空，启动后在本地管理页点击 **添加账号** 即可创建任意数量的账号，无需手动生成 UUID。

启动容器：

```bash
docker compose pull
docker compose up -d
```

在服务器本机浏览器打开 `http://127.0.0.1:8788`，即可查看 Agent 状态、添加 WhatsApp 账号并扫描关联二维码。

如果你不打算把 8788 端口直接暴露到公网，推荐先建立 SSH 隧道，再在本机浏览器访问本机地址：

```bash
ssh -L 8788:127.0.0.1:8788 <user>@<server>
```

隧道建立后，在本机浏览器打开 `http://127.0.0.1:8788`。点击 **添加账号**，输入一个便于识别的名称，再用手机 WhatsApp 的 **关联设备** 扫描该账号二维码；页面变为“已连接”即完成。可重复添加多个账号。
管理界面支持查看中心和账号状态、添加、编辑、重新连接、清除当前会话后重新配对，以及移除账号。默认 Compose 将管理端口仅绑定到服务器 `127.0.0.1`，不会暴露给公网。若修改 `RELAY_UI_BIND` 对外开放，请务必置于具备身份认证的 HTTPS 反向代理之后。

首次注册成功后，从 `.env` 删除 `RELAY_ENROLLMENT_CODE` 的值，再执行：

```bash
docker compose up -d
```

注册码已不能重复使用，保留它没有必要。

## 运维

```bash
# 当前状态与最近日志
docker compose ps
docker compose logs --tail=200 agent

# 升级至最新镜像（保留 volume 中的会话）
docker compose pull && docker compose up -d

# 停止，不删除 WhatsApp 会话
docker compose down
```

不要执行 `docker compose down -v`，除非你确定要删除本地 Agent 数据并重新注册、重新扫码。

若 WhatsApp 或 GitHub 访问需经代理，可配置 `RELAY_PROXY_URL=http://proxy-host:port`。容器中的 `localhost` 指向容器自身；访问宿主机代理时请使用宿主机可达地址。

## 发布镜像

`.github/workflows/docker-agent-release.yml` 会在 `main` 的 Agent 代码变更后发布 `ghcr.io/samlau0086/relaydesk-agent:latest`。创建 `agent-docker-v<version>` 标签会额外发布同名不可变标签：

```bash
git tag agent-docker-v0.1.31
git push origin agent-docker-v0.1.31
```

首次发布后，如 GitHub Packages 默认设为私有，请在包设置中将镜像设为公开，或在部署服务器上先执行 `docker login ghcr.io`。
