# Absence（发呆症）

[English](README.md) | [简体中文](README.zh-CN.md)

**向智能臣服**

AI 的发展速度超过人类思考的速度，人因此落后于 agent 的思路并陷入静止，本项目称这种状态为发呆症（Absence）。

Absence 是 AI agent 的只读可视化观察器。agent 在用户自己的终端或编辑器中运行，使用方式不变。Absence 读取 agent 软件本来就会写下的会话记录与它本来就会启动的进程，呈现发生过的事，并保留可回看的归档。

## 展示内容

- **正在进行的动作。** Stage 渲染当前事实：文件读取、diff、带输出与退出码的命令、审批请求、MCP 调用。Activity 流保留同一 run 的时间顺序记录。
- **agent 眼中的项目。** Agent Folder 列出 agent 读过、写过、编辑过的文件，包含读取行段与完整版本；旁边的项目树从磁盘读取。
- **run 的开销与遗留。** 资源指标覆盖 agent 进程树、每个 egg、Docker 容器与主机。Agent Eggs 按行为分类汇总 agent 启动的进程。
- **run 结束后的回看。** 会话归档在 SQLite。History 重新打开已归档会话；回放依据事件流与周期快照重建文件内容、agent 状态与当前 Stage 动作。
- **Absence Report。** 对单个 run 的确定性归约：时间线、文件变化、命令执行、已知事实、注意力项与结论。归约在客户端完成，不调用模型，不解析命令语义。

## 观察通道

Absence 不启动、不发送提示词、不取消、不应答任何 agent。三条只读通道汇入同一条事件管线：

| 通道 | 来源 | 覆盖内容 |
|---|---|---|
| `transcript` | pi 在其会话目录中自己写下的会话文件 | 消息、思考、工具调用与结果、文件写入与编辑、用量、回合边界 |
| `acp-proxy` | ACP 客户端指向 `absence proxy`，代理原样转发字节并旁听 | 协议携带的全部内容，进程归因精确 |
| `os` | 进程表扫描、内核观察器、文件观察、非 Windows 主机的 Docker 事件 | 进程、文件、资源、容器；不含对话内容 |

## 支持的 agent

- **Pi** — 转录尾随。这是 Absence 唯一解析的私有格式；pi 开源，格式文档为 `docs.pi.dev/latest/session-format.md`。
- **任意 ACP agent** — 客户端支持配置 ACP 入口时，通过透明代理观察。
- **其他 agent** — 仅 OS 观察：进程、文件与资源，不含对话内容。

## 要求

Node.js 22.19 或更高版本与 npm。Absence 不捆绑 agent 运行时。

## 从源码运行

```bash
git clone https://github.com/Dipsy233/Absence.git
cd Absence
npm ci
npm run build
npx tsx apps/server/src/cli.ts serve
```

服务端监听 `127.0.0.1:8848`。首个页面是观测台；选择目标即开始监控，面板地址为 `/s/<sessionId>`。

开发时 `npm run dev` 同时启动服务端与 Vite 开发服务器。`start-absence.sh` 与 `start-absence.bat` 安装依赖、在 Web 构建过期时重新构建、启动服务端并打开浏览器。

### 命令行

| 命令 | 作用 |
|---|---|
| `serve [--port N] [--host H] [--open]` | 启动服务端（默认命令） |
| `ls [--json]` | 列出本机可监控的目标 |
| `observe (--pid P \| --session FILE \| --cwd DIR \| --latest)` | 选择目标，记录监控租约并打印面板 URL |
| `open <sessionId>` | 打印会话的面板 URL |
| `unwatch <sessionId>` | 撤销监控租约；归档保留 |
| `proxy [--project DIR] [--label NAME] -- <command> …` | 把 ACP 客户端转发给 agent，并旁听流量 |

`ls`、`observe`、`open`、`unwatch` 访问已运行的服务端时读取 `ABSENCE_URL` 与 `ABSENCE_TOKEN`。

### 远程访问

服务端拒绝在缺少 `ABSENCE_TOKEN` 时绑定非回环地址。令牌不加密流量；应使用 SSH 隧道或带 TLS 的反向代理。

```bash
ssh -N -L 8848:127.0.0.1:8848 user@agent-host
```

## 配置

| 变量 | 默认值 | 含义 |
|---|---|---|
| `PORT` / `HOST` | `8848` / `127.0.0.1` | 监听地址 |
| `ABSENCE_TOKEN` | 未设置 | 非回环绑定必需；接受 `?token=` 或 `x-absence-token` |
| `ABSENCE_STATE_DIR` | `~/.absence` | 归档、指标与监控租约 |
| `ABSENCE_OBSERVE` | `1` | `0` 关闭观察子系统 |
| `ABSENCE_AUTO_ATTACH` | `0` | `1` 时未经选择即挂载近期写入的转录 |
| `ABSENCE_OBSERVE_PI_ROOT` | 未设置 | 覆盖 pi 会话目录（测试用） |
| `ABSENCE_ARCHIVE_SILENCE_MS` | `1800000` | 无租约的观察会话静默多久后归档；`0` 关闭 |
| `ABSENCE_LEASE_SILENCE_MS` | `7200000` | 有租约的观察会话静默多久后归档；`0` 永久保留 |
| `ABSENCE_ARCHIVE_SWEEP_MS` | `60000` | 空闲清扫间隔 |
| `ABSENCE_SESSION_RETENTION_DAYS` | `0` | 归档按天保留；`0` 全部保留 |
| `ABSENCE_MAX_ARCHIVED_SESSIONS` | `0` | 归档按数量保留；`0` 全部保留 |
| `ABSENCE_METRICS_RETENTION_DAYS` | `30` | 指标保留天数 |
| `ABSENCE_MAX_EGGS` | `200` | 每个会话保留的已结束 egg 数 |
| `ABSENCE_DOCKER` | 除 Windows 外开启 | Docker 容器观察 |
| `ABSENCE_WEB_DIST` | `dist/web` | 作为 Web 应用提供的目录 |

## 文档

[docs/index.zh-CN.md](docs/index.zh-CN.md) 是文档索引，列出每份文档的用途、适用对象与语言配对。常用入口：

- [docs/observation.zh-CN.md](docs/observation.zh-CN.md) — 启动服务、选择目标、中途挂载语义。
- [docs/architecture.zh-CN.md](docs/architecture.zh-CN.md) — 事件流、模块、存储与 API。
- [docs/ui-faces.zh-CN.md](docs/ui-faces.zh-CN.md) — 三个 face、Drip 与观测台。

## 许可证

MIT，见 [LICENSE](LICENSE)。
