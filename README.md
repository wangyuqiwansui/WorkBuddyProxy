# WorkBuddy 代理助手

一个 Electron 桌面工具，用于把 WorkBuddy 自定义模式接入 OpenAI Codex Auto 登录态。WorkBuddy 请求会先进入本地代理，再由本应用调用 `https://chatgpt.com/backend-api/codex/responses`，最后把 Codex 返回结果转换成 OpenAI-compatible 格式返回给 WorkBuddy。

本项目不依赖每次请求启动 `codex app-server`，也不需要在 WorkBuddy 里填写 OpenAI API Key。

## 当前能力

- OpenAI Codex OAuth 浏览器登录。
- 本地 OpenAI-compatible 代理：`http://127.0.0.1:<port>/v1`。
- 本地代理 API Key 自动生成，可在界面查看和复制。
- 手动开启 / 停止 WorkBuddy 本地代理。
- 支持 WorkBuddy 调用 `GET /v1/models`、`POST /v1/chat/completions`、`POST /v1/responses`。
- 支持非流式和流式 Chat Completions。
- WorkBuddy 自定义模型名自动映射到当前选中的 Codex 模型。
- 运行日志展示代理请求、模型映射、返回状态、输出长度和耗时。
- Electron 网络请求会优先读取环境变量代理或 Windows 系统代理，避免 OAuth token 交换直连失败。

## 快速开始

1. 双击 `start_workbuddy_proxy.bat`。
2. 首次启动会自动执行 `npm install` 安装 Electron 依赖。
3. 点击“管理登录”，在浏览器完成 OpenAI Codex OAuth 授权。
4. 点击“测试连接”，确认本应用能访问 Codex。
5. 在模型下拉框选择当前要使用的 Codex 模型。
6. 点击“开启代理”。
7. 在界面复制接口地址和 API Key，填入 WorkBuddy 自定义模式。
8. 在 WorkBuddy 里发送测试消息。
9. 不需要代理时，点击“停止代理”。

也可以在终端启动：

```powershell
cd C:\Users\12698\Desktop\AI接入日志\workbuddy_proxy_app
npm install
npm start
```

## WorkBuddy 配置

界面会显示以下字段：

- 本地 IP：固定为 `127.0.0.1`。
- 端口：默认 `8765`，如果被占用会自动尝试后续端口。
- 接口地址：例如 `http://127.0.0.1:8765/v1`。
- API Key：例如 `wbp-...`。

双击任意字段可复制该字段；点击“复制配置”可复制完整 JSON 配置。

配置示例：

```json
{
  "接口地址": "http://127.0.0.1:8765/v1",
  "API Key": "wbp-示例代理密钥",
  "模型": ["gpt-5.5", "gpt-5.4", "gpt-5.2"]
}
```

## 请求转发流程

1. WorkBuddy 请求本地代理地址，例如 `/v1/chat/completions`。
2. 本地代理校验 `Authorization: Bearer <代理 API Key>`。
3. 代理读取 WorkBuddy 传来的模型名。
4. 如果 WorkBuddy 模型名存在于 Codex 模型列表，直接使用该模型。
5. 如果 WorkBuddy 模型名是自定义显示名，例如 `代理GPT`，自动映射到界面当前选中的 Codex 模型。
6. 代理把消息转换成 Codex Responses 后端请求。
7. Codex 返回后，代理再转换成 OpenAI-compatible 响应返回 WorkBuddy。

运行日志会显示类似：

```text
代理请求 a1b2c3d4：POST /v1/chat/completions，WorkBuddy模型=代理GPT，Codex模型=gpt-5.5，stream=false，messages=1
代理返回 a1b2c3d4：HTTP 200，Codex模型=gpt-5.5，输出=18 字符，耗时=1234ms
```

日志不会记录代理 API Key，也不会记录完整提示词内容。

## 支持接口

- `GET /v1/models`
- `GET /v1/models/{id}`
- `POST /v1/chat/completions`
- `POST /v1/responses`

限制：

- Codex Auto 模式不提供 embeddings；`/v1/embeddings` 会返回错误。
- 工具调用默认关闭，代理主要返回文本结果。

## OAuth 与本地保存

OpenAI Codex 的 OAuth 信息只保存在本机当前 Windows 用户目录，不上传 Git：

- 保存位置：`%APPDATA%\WorkBuddyProxy\config.json`
- 保存内容：Codex OAuth access token、refresh token、过期时间、本地代理端口和代理 API Key。
- 加密方式：OAuth token 使用 Electron `safeStorage` 加密保存；如果系统环境不支持 `safeStorage`，应用会降级为本机明文编码保存。
- 仓库内不保存 OAuth token，不读取、不展示、不复制 `.codex/auth.json`。

为了防误提交，仓库 `.gitignore` 已忽略：

- `node_modules/`
- `*.log`
- `config.json`
- `auth.json`
- `.env`
- `.env.*`
- `WorkBuddyProxy/`

如果需要清除本机登录态，可关闭应用后删除：

```powershell
Remove-Item -Force "$env:APPDATA\WorkBuddyProxy\config.json"
```

## 网络代理

如果 OAuth 登录时报：

```text
unsupported_country_region_territory
```

通常说明 OpenAI 的 token 交换请求没有走到受支持的网络出口。应用启动时会：

1. 优先读取 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`。
2. 没有环境变量时读取 Windows 系统代理。
3. 使用 Electron `net.fetch` 调用 OAuth 和 Codex 后端。

请先确认系统代理已开启，再重启应用并重新点击“管理登录”。

## Electron 安装卡住

如果安装停在：

```text
electron: Running postinstall script...
```

通常是 Electron 运行时下载源连接慢或不可用。项目已配置 npm / pnpm 使用国内镜像；先在卡住的终端按 `Ctrl+C` 停止安装，再执行：

```powershell
cd C:\Users\12698\Desktop\AI接入日志\workbuddy_proxy_app
Remove-Item -Recurse -Force node_modules
npm install
```

也可以直接重新双击 `start_workbuddy_proxy.bat`，脚本会自动带上 Electron 镜像地址后再安装。

## 开发与验证

运行测试：

```powershell
npm test
```

语法检查：

```powershell
node --check main.js
node --check preload.js
node --check renderer\renderer.js
node --check lib\proxyState.js
node --check lib\modelResolver.js
node --check lib\proxyLog.js
```

## 打包

项目使用 `electron-builder` 打包，产物输出到 `dist/`。

一次性声明 Windows 和 macOS 目标：

```powershell
npm run dist
```

等价命令：

```powershell
npm run dist:all
```

单独打 Windows 包：

```powershell
npm run dist:win
```

单独打 macOS 包：

```powershell
npm run dist:mac
```

说明：Windows 包可以在当前 Windows 环境构建；macOS 的 `.dmg` / `.zip` 建议在 macOS 或 GitHub Actions 的 macOS runner 上构建。脚本已经配置 macOS target，但 Windows 环境通常无法可靠完成 macOS DMG、签名和公证流程。

## 文件结构

```text
.
├─ main.js                         Electron 主进程、本地代理、Codex OAuth、请求转发
├─ preload.js                      Renderer 安全 IPC 桥
├─ renderer/
│  ├─ index.html                   桌面界面
│  ├─ renderer.js                  界面逻辑
│  └─ styles.css                   界面样式
├─ lib/
│  ├─ modelResolver.js             WorkBuddy 模型名到 Codex 模型映射
│  ├─ proxyLog.js                  代理请求/返回日志摘要
│  └─ proxyState.js                代理地址、端口、Key 状态
├─ test/                           Node 内置测试
├─ package.json
├─ .npmrc                          npm / Electron 镜像配置
├─ .gitignore
└─ start_workbuddy_proxy.bat       Windows 启动脚本
```

## 安全边界

- 本地代理只监听 `127.0.0.1`，不对局域网开放。
- 代理 API Key 只用于本机 WorkBuddy 到本应用之间的鉴权。
- OAuth token 不进仓库，不上传 Git，只存当前 Windows 用户目录。
- 关闭窗口会停止本次由应用启动的 WorkBuddy 代理。
