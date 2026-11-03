# 测试与验收检查

Absence 没有单元测试框架。它难的不是纯函数，而是**观察一个真实操作系统**与
**讲一个真实协议**，所以仓库带一组自包含的验收检查脚本，每个钉住一条容易悄悄
弄错的规则。策略与分层理念见 [TESTING-STRATEGY.md](TESTING-STRATEGY.md)；
本文是"跑什么、怎么跑"。

> 自 v0.5.0 起本文以中文为准（原 `TESTING.zh-CN.md` 已合并删除）。

## 门禁

```bash
npm run typecheck       # core / server / web 三个 workspace 的 tsc
npm run build           # web 生产构建（产物在 dist/web）
npm run check:acp-all   # ACP 接入层门禁（见下）
npm run check:mock-agent  # 端到端仿真（mock agent + 真 server）
npm run check:offline   # 全部离线检查（CI 跑的就是它）
```

`npm run verify` = typecheck + build + check:offline。

## `check:acp-all` —— 标准接入层门禁

一条命令按序跑完以下八个检查（任一失败即红）：

| 检查 | 钉住的规则 |
|---|---|
| `check:acp` | ACP 驱动面：会话生命周期、tool call 映射、审批原样回传、模型/命令来自 agent 而非 Absence；并断言代码里不存在按产品名分支、不存在对 agent 配置的扫描（如 `discoverCapabilities` 字样不得出现在 profile 数据里） |
| `check:acp-lifecycle` | 能力门控：`session/resume` / `load` / `close` 只在 `initialize` 声明后发送；取消顺序与看门狗了结 |
| `check:acp-transport` | NDJSON/JSON-RPC 传输：Windows shim 解析（PATHEXT）、批处理安全 spawn、错误 `data` 透传、退出清理 |
| `check:acp-mapping` | 投影保真：`kind`/形状规则、流式输出累计、不发明行号、source/fidelity 标注、溢出与强制了结如实报错 |
| `check:acp-proxy` | 透明代理模式：字节原样转发、两端关闭后退出并释放句柄 |
| `check:agent-catalog` | 发现顺序、状态机、`+` 自定义入口、注册表缓存、`ABSENCE_ALLOW_NPX` 门控 |
| `check:observer` | 观察器契约：删掉 `apps/server/src/agents/` 后 `absence watch` 仍可用 |
| `check:mock-agent` | 端到端仿真（见下） |

单独跑某一个：`npx tsx scripts/checks/check-acp.ts`（其余同理）。

## 端到端仿真（mock agent）

`scripts/mock-agent/` 是一个**讲真 ACP 协议的脚本化 agent**（`agent.mjs`，不需要
模型和凭据）加一组场景（`scenarios/*.json`）。runner（`run.ts`）为每个场景造一个
一次性 home/state/workspace，用自定义 profile 让**真 server** 拉起 mock agent
进程（包在 Job Object 里，和真实 agent 一模一样），然后同时从 WebSocket 与
SQLite 两端核对 `AbsenceEvent`。

```bash
npm run mock:agent                          # 全部场景
npm run mock:agent -- --list                # 列出场景
npm run mock:agent -- --scenario 03-file-ops
```

场景覆盖冷启动、流式 thinking、文件操作、命令重试、长输出、多轮、中途取消、
并发工具、进程树、各 agent 的事件形状、diff 片段保真、部分读取保真、并发
execute、审批拒绝。两端痕迹（`agent-trace.ndjson` / `absence-events.jsonl`）写在
`--out` 目录下便于对照。

## 其他检查分组

`npm run check:group -- <组名>` 只跑一个领域；`run-offline.ts` 注册的离线检查由
`scripts/checks/groups.ts` 统一登记（唯一的注册点）：

| 组 | 覆盖 |
|---|---|
| `report` / `views` / `history` | 事实引擎、face 视图模型、历史重建与增量 |
| `settings` / `chimes` | 阈值归一化与 i18n、提示音策略 |
| `eggs` | 进程识别/分类/过滤器（`agentwatch`、`ebpf` 内核检查为手动层） |
| `metrics` | 指标采样与持久化（重启存活、区间、观察会话寿命） |
| `agent` | 上表中的 ACP 系列 + `check-capability-commands`（`/` 转发契约）+ `check-mcp-events` |
| `session` | 归档存储、dwell 时钟、关闭与生命周期 |
| `io` | fsdiff 引擎 |
| `pipeline` / `docker` | 手动层：全链路 e2e、docker eggs（需要内核观察器/docker） |

手动层（tier 4）需要内核权限或 docker，不进 `check:offline`。

`ProcessWatcher.noteMarker` 只被 `check-agentwatch` / `check-docker*` 这些内核检查
用来标记自己拉起的进程；**生产代码不调用它**（Absence 不再驱动 agent 的 shell），
这不是休眠代码，是检查专用探针。

## 开发辅助

- `npm run probe:acp -- <scenario>` —— 单跑一次采集管道并打印事件（可用
  `ABSENCE_ACP_BIN` 指向真实 agent）。
- `npm run registry:sync` —— 拉取 ACP 官方注册表到 `~/.absence/registry.json`。
- `npm run release:notes -- v<版本>` —— 从提交记录生成发布说明草稿。

## 检查的书写规则

由 `scripts/checks/harness.ts`（一个 `check()` 出口）强制：

1. 标签是产品规则的大白话，不是 `assertEquals`；
2. `detail` 带实际值，红了能看见发生了什么；
3. 块注释写明它在钉哪个历史 bug。
