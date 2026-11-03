# 测试策略

[English](testing-strategy.md) | [简体中文](testing-strategy.zh-CN.md)

[testing.zh-CN.md](testing.zh-CN.md) 列出检查项与运行命令。本文说明分层：每一层能证明什么、不能证明什么，以及拆分检查时为何以所需环境为依据。

## 方法

仓库没有单元测试框架，也不设覆盖率目标。检查钉住的是曾经失败过、或失败时不会产生类型错误的行为：一条命令下了哪个进程、容器有没有成为蛋、指标序列能否跨重启保留、工具调用载荷有没有被补上协议未提供的字段。系统边界之内的规则保持为纯函数，用伪造数据驱动；边界本身对真实进程、真实文件、真实 server、真实内核助手与 docker 运行。

每个检查都是独立脚本、独立进程，单独运行、单独输出、单独返回退出码。

## 存储模块分层

SQLite 访问分布在 `apps/server/src/sessions/storage/` 下的四个文件：

| 文件 | 职责 |
|---|---|
| `db.ts` | 打开连接（`node:sqlite` 的 `DatabaseSync`）、设置 WAL 与 pragma、定义 schema 与迁移、写入与读取会话事件；`openDatabase()` 从这里导出。 |
| `files.ts` | `FileIndex` 接收已打开的句柄，为 `file_versions` 表准备自己的语句。 |
| `runs.ts` | `RunIndex` 接收已打开的句柄，为 `runs` 表与 `store_meta` 准备自己的语句。 |
| `metrics.ts` | 准备指标 chunk、host chunk 与 egg summary 语句并执行删除；直接调用 `openDatabase()`。 |

存储层的改动可能落在四个文件中的任意一个。`check-storage` 按整体核对归档接缝：旧归档导入、事件往返、缓冲 drain、归档列表与导入幂等。该检查是进程内的离线检查，使用私有 `ABSENCE_STATE_DIR`，不按文件拆分。

## 分层

29 条离线检查分为三层，另有 ACP 家族；5 条手动检查构成最后一层。

| 层 | 所需环境 | 检查 | 能确立的结论 |
|---|---|---|---|
| 1. 纯函数 | 伪造的进程表与事件数组；不启动进程、不写文件 | 13 条：`eggs`、`classify`、`outside-attr`、`report`、`markdown`、`format`、`views`、`chimes`、`settings`、`capability-commands`、`mcp-events`、`incremental`、`metrics-ranges` | 归因、分类、报告归约、视图模型与策略分支，仅靠数据驱动 |
| 2. 隔离 I/O | 临时目录与 `ABSENCE_STATE_DIR`；在进程内引用生产存储与 diff 模块 | 4 条：`storage`、`metrics`、`metrics-persist`、`fsdiff` | 对真实 SQLite 文件的归档与指标往返，不写入用户档案 |
| 3. 自起 server | 临时端口与隔离 state 目录；检查启动并结束真 server | 6 条：`history`、`lifecycle`、`metrics-restart`、`observed-lifetime`、`session-close`、`session-dwell` | server 生命周期、会话关闭、dwell 计时、经 HTTP 读取历史、重启后的指标 |
| ACP 家族 | 脚本化 fixture agent 与临时目录中的子进程；不启动 server | 6 条：`acp`、`acp-lifecycle`、`acp-transport`、`acp-mapping`、`acp-proxy`、`agent-catalog` | ACP 契约：能力门控、传输、映射、代理、catalog 发现 |
| 4. 手动 | 内核观察助手、docker daemon，或真 server 加 mock 会话 | 5 条：`agentwatch`、`ebpf`、`docker`、`docker-eggs`、`e2e` | 内核级进程捕获、容器蛋、以及一次运行内的全链路 |

13 + 4 + 6 + 6 = 29 条离线检查；加上 5 条手动检查，登记总数为 34。

第 1 层把系统调用推到边界之外，使中间逻辑成为可传入数据的函数。`check-eggs` 把伪造进程表喂给真实的归因代码：

```ts
check("a process that appeared since the last look is a candidate", candidates.includes(1002));
check("the shell Absence drove is not an egg",                     !claimed.includes(1001));
```

`candidatePids`、`attributeProcesses` 与 `buildEggs` 接收数据，因此命令窗口、祖先链与“孤儿不做猜测”这几条规则不需要启动任何进程即可验证。

第 2 层依赖 import 顺序。state 目录必须在存储模块被加载之前重定向，所以这些检查使用动态 import：

```ts
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "absence-metrics-"));
process.env.ABSENCE_STATE_DIR = stateDir;          // 必须先于模块加载
const { appendMetricsFrame } = await import("../../apps/server/src/sessions/storage/metrics");
```

静态 import 会让模块对用户的真实归档打开连接。

第 3 层的检查作为客户端，访问自己启动的 server。它们不依赖任何预先存在的资源：端口是临时的，state 目录是私有的，server 在清理阶段结束。CI 环境没有内核助手；`ci.yml` 的注释写明 watcher 会退回进程表采样，因此这些检查核对的是不依赖内核助手的会话、归档与指标行为。

ACP 家族驱动的是 fixture agent，它确立 Absence 处理协议的方式，不确立 Pi、Codex、Claude Code、Qwen Code、Gemini 或 DSH 自身的行为。mock agent runner 在同一协议之上补充端到端覆盖：真 server 把 mock agent 作为子进程拉起，产生的事件从 WebSocket 与 SQLite 两侧读取。该仿真是独立门禁（`check:mock-agent`，别名 `absence-sim`），不包含在 `check:offline` 中。

## 各层不覆盖的内容

- **内核与 docker 路径。** `check-agentwatch` 在非 Windows 平台说明原因并以退出码 0 结束，`check-ebpf` 在非 Linux 平台同样处理。在其他平台上得到的通过结果不覆盖 job object 或 eBPF 路径。容器蛋需要可访问的 daemon 才能验证。
- **产品 agent 自身的行为。** ACP 检查与仿真使用脚本化 fixture agent，不核对各厂商 agent 的工具载荷或沙箱实现。
- **界面渲染。** 仓库没有浏览器测试 runner。界面行为由 `check-views` 在视图模型层核对；CSS、布局与桌面壳不在检查范围内。

## 失败可读性

`scripts/checks/harness.ts` 共 51 行，四个导出：`check`、`finish`、`section`、`waitFor`。

1. 标签用直述语句写明产品规则，例如 `"the shell Absence drove is not an egg"`。
2. `detail` 带上实际值，失败行会显示观察到的内容。
3. 块注释写明该检查钉住的历史回归。

`finish()` 在任一检查失败时返回非零退出码，在一条检查都没跑时也返回非零，因此空脚本无法通过。每个脚本是独立进程，runner 直接消费它的退出码。输出格式与 runner 的消息见 [testing.zh-CN.md](testing.zh-CN.md) 的「失败信号」一节。

## 数字

| 项目 | 数值 | 来源 |
|---|---|---|
| 登记检查 | 35 | `scripts/checks/groups.ts` |
| 离线检查 | 30 | `groups.ts` 的 `checks` 条目 |
| 手动检查 | 5 | `groups.ts` 的 `platform` 条目 |
| 检查组 | 12 | `groups.ts` 的 `GROUPS` |
| mock agent 场景 | 14 | `scripts/mock-agent/scenarios/` |
| harness | 51 行，4 个导出 | `scripts/checks/harness.ts` |
| CI | typecheck + `check:offline` | `.github/workflows/ci.yml` |
| 提交门禁 | `npm run verify` | 根 `package.json` |

## 延伸阅读

- [testing.zh-CN.md](testing.zh-CN.md)：全部已登记检查及运行方式。
- [architecture.zh-CN.md](architecture.zh-CN.md)：这些检查所练的事件管道。
