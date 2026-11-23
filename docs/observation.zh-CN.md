# 运行观察器

[English](observation.md) | [简体中文](observation.zh-CN.md)

本文说明 Absence 如何启动、如何选择目标，以及在 agent 已经工作之后开始观察时能恢复什么、不能恢复什么。模块结构见 [architecture.zh-CN.md](architecture.zh-CN.md)。

## 进程模型

Absence 是一个服务端进程，在同一个地址上提供 Web 应用、HTTP API 与会话 WebSocket。桌面壳在自己的进程内启动同一个服务端；无桌面的主机运行同一个服务端而不带桌面。

除代理通道外，agent 永远不是 Absence 的子进程。用户在自己的终端或编辑器中启动 agent，Absence 读取该 agent 写下的记录与启动的进程。

```text
agent 终端 ──写转录──▶ 转录尾随 ─┐
ACP 客户端 ──▶ absence proxy ──▶ agent ──tap──┼──▶ 事件管线 ──▶ Web、归档
OS:进程表、内核观察器、文件观察 ─────────────┘
```

## 启动

```bash
npx tsx apps/server/src/cli.ts serve            # 127.0.0.1:8848
npx tsx apps/server/src/cli.ts serve --port 9000 --open
```

`npm start` 运行同一入口。首个页面是观测台。

### 远程访问

服务端在缺少 `ABSENCE_TOKEN` 时拒绝绑定非回环地址，进程退出并输出变量名。设置令牌后，客户端以 `?token=<值>` 或 `x-absence-token` 请求头提交。令牌用于认证请求，不加密流量，因此网络绑定需要在服务端前面终止 TLS。

SSH 隧道使绑定保持在回环：

```bash
ssh -N -L 8848:127.0.0.1:8848 user@agent-host
```

## 选择目标

观测台包含三个区段：

| 区段 | 内容 | 操作 |
|---|---|---|
| 正在监控 | 服务端当前持有在内存中的会话 | 打开面板 |
| 可监控 | 已发现但无活动会话的目标 | 开始监控 |
| 历史 | 已归档的会话 | 重开记录 |

目标键在重启后保持稳定：

| 键 | 身份 |
|---|---|
| `transcript:<绝对文件>` | 转录文件 |
| `proc:<pid>@<启动毫秒>` | pid 与其启动时间 |
| `proxy:<会话 id>` | 代理会话 id |

发现只列目标，不创建会话、watcher 或采样器。`POST /api/observe/watch` 创建会话并记录监控租约。CLI 执行同一动作：

```bash
npx tsx apps/server/src/cli.ts ls
npx tsx apps/server/src/cli.ts observe --session /abs/path/session.jsonl
npx tsx apps/server/src/cli.ts observe --pid 12345
```

`--pid` 只选择 Absence 已匹配的目标，不监控任意进程。两个目标同时指向一个 pid 时拒绝该 pid；同一目录有多个目标时拒绝 `--cwd`。

`ABSENCE_AUTO_ATTACH=1` 恢复旧行为：最近十分钟写入的转录无需选择即挂载。

## 监控租约

租约记录用户选择监控某个会话。

| 属性 | 行为 |
|---|---|
| 持久化 | 存入 SQLite；启动时恢复 |
| 关闭标签页 | 不撤销租约 |
| `unwatch` 或观测台的 ✕ | 撤销租约；归档保留 |
| 空闲清扫 | 有租约的会话使用 `ABSENCE_LEASE_SILENCE_MS`（默认 2 小时），无租约的观察使用 `ABSENCE_ARCHIVE_SILENCE_MS`（默认 30 分钟）；正在回填或有 viewer 连接的会话跳过 |
| 归档的效果 | 停止 watcher 与采样；归档及其身份保留 |

## 中途挂载

观察可能在 agent 已经工作之后才开始。可恢复的内容取决于通道。

| 通道 | 挂载前 | 挂载后 |
|---|---|---|
| `transcript` | 文件中已有的完整记录按文件顺序交付。真实用户消息仍是真实 run 边界。文件在回合中间开始时，首个 run 标记 `boundarySource: "attach"` 与 `truncatedBefore: true`，prompt 为空，不编造提示词 | 同一解析器从字节偏移继续；没有换行结尾的记录在写入方写完后读取 |
| `os` | 只有挂载时仍存在且可归因的进程。已退出的短命进程、过去的采样与过去的对话不可恢复 | 累积进程活动与资源采样；活动记为 `boundarySource: "activity-burst"` 的 run |
| `acp-proxy` | 不能挂载到已有的终端进程。未经代理的流量不可得 | 只记录经代理连接携带的事实 |

### 回填与实时尾随

转录回填从字节 0 分块读取，块间让出事件循环，观测台与 socket 保持响应。单条 JSON 记录可以跨块；读取持续到换行。超过 200 MiB 的文件从末尾开始观察而不回填，行内不宣称已回填。

回填期间追加的记录在回填结束时读取一次。同一文件的并发挂载请求共用一个会话。

### 重启续采

schema v7 为每个会话保存一行 `transcript_checkpoints`：已消费字节偏移与已消费前缀的 SHA-256，与事件在同一事务中写入。

| 情况 | 行为 |
|---|---|
| 前缀与保存的摘要一致 | 从保存的偏移继续。历史不重复交付；服务端停止期间追加的记录会补上 |
| 前缀被改写或截断 | 观察停止合并，不再记录，观测台显示 `transcriptResumeBlocked`；用户重新选择目标以开始新的观察 |
| 无 checkpoint（旧 schema 的归档） | 解析器从字节 0 读取并丢弃解析结果，随后尾随实时事实 |

## 已知限制

| 限制 | 后果 |
|---|---|
| 超过 200 MiB 的转录 | 不做完整回填；从文件当前末尾开始观察 |
| 仅 OS 观察 | 挂载前的对话内容与指标不存在 |
| 内核观察器不可用 | 进程观察退化为进程表采样，可能漏掉短命进程；指标精度标为 `sampled` |
| Windows | Docker 容器捕获被禁用；不记录容器事件 |
| 未匹配的转录 | 转录与进程只在明确证据（`--session` 路径）或无歧义的一对一配对下绑定；有歧义时不绑定 |
