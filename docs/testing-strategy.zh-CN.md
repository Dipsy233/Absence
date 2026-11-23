# 测试策略

[English](testing-strategy.md) | [简体中文](testing-strategy.zh-CN.md)

[testing.zh-CN.md](testing.zh-CN.md) 列出检查项与运行命令。本文说明分层：每一层能确立什么、不能确立什么，以及检查按所需环境拆分的原因。

## 1. 方法

仓库没有单元测试框架，也不设覆盖率目标。检查钉住的是曾经失败过、或失败时不会产生类型错误的行为：一条命令下了哪个进程、容器有没有成为蛋、指标序列能否跨重启保留、工具调用载荷有没有被补上协议未提供的字段、重启后的转录续采会不会重复历史。系统边界之内的规则保持为纯函数，用伪造数据驱动；边界本身对真实进程、真实文件、真实 server、真实内核助手与 docker 运行。

每个检查都是独立脚本、独立进程，单独运行、单独输出、单独返回退出码。

## 2. 存储模块分层

SQLite 访问分布在 `apps/server/src/sessions/storage/` 下的四个文件：

| 文件 | 职责 |
|---|---|
| `db.ts` | 打开连接（`node:sqlite` 的 `DatabaseSync`）、设置 WAL 与 pragma、定义 schema 与迁移、写入与读取会话事件、保存转录 checkpoint；`openDatabase()` 从这里导出。 |
| `files.ts` | `FileIndex` 接收已打开的句柄，为 `file_versions` 表准备自己的语句。 |
| `runs.ts` | `RunIndex` 接收已打开的句柄，为 `runs` 表与 `store_meta` 准备自己的语句。 |
| `metrics.ts` | 准备指标 chunk、host chunk 与 egg summary 语句并执行删除；直接调用 `openDatabase()`。 |

存储层的改动可能落在四个文件中的任意一个。`check-storage` 按整体核对归档接缝：旧归档导入、事件往返、缓冲 drain、归档列表与导入幂等。该检查是进程内的离线检查，使用私有 `ABSENCE_STATE_DIR`，不按文件拆分。

## 3. 分层

35 个离线脚本分为四层，5 个手动脚本构成最后一层。两个离线脚本同时登记在两个组，因此登记表包含 37 次离线登记，覆盖 35 个脚本。

| 层 | 所需环境 | 检查 | 能确立的结论 |
|---|---|---|---|
| 1. 纯函数 | 伪造的进程表、事件数组与转录行；不启动进程、不写文件 | 13 条：`eggs`、`classify`、`outside-attr`、`report`、`chart-allrun`、`markdown`、`format`、`views`、`chimes`、`settings`、`mcp-events`、`acp-mapping`、`metrics-ranges` | 归因、分类、报告归约、视图模型、工具映射与策略分支，仅靠数据驱动 |
| 2. 隔离 I/O | 临时目录与 `ABSENCE_STATE_DIR`；在进程内引用生产存储、观察、watcher 与 diff 模块 | 10 条：`storage`、`metrics`、`metrics-persist`、`fsdiff`、`outside-scope`、`incremental`、`agentwatch-external`、`observe-midway`、`observe-transcript`、`observe-proxy` | 对真实 SQLite 文件与真实文件观察的归档与指标往返、转录回填与续采、代理持久化、外部进程配对 |
| 3. 自起 server | 临时端口与隔离 state 目录；检查启动并结束真 server | 12 条：`history`、`lifecycle`、`metrics-restart`、`observed-lifetime`、`session-close`、`session-dwell`、`session-isolation`、`observe-board`、`observe-watch`、`observe-os`、`cli-observe`、`acp-proxy` | server 生命周期、会话关闭、dwell 计时、经 HTTP 读取历史、重启后的指标、目标选择、租约、重启恢复、仅 OS 监控、令牌处理 |
| 4. 手动 | 内核观察助手、docker daemon，或真 server 加 mock 会话 | 5 条：`agentwatch`、`ebpf`、`docker`、`docker-eggs`、`e2e` | 内核级进程捕获、容器蛋，以及一次运行内的全链路 |

13 + 10 + 12 = 35 个离线脚本。加上 5 个手动脚本，登记表覆盖 40 个不同脚本、共 42 次登记。

第 1 层把系统调用推到边界之外，使中间逻辑成为可传入数据的函数。`check-eggs` 把伪造进程表喂给真实的归因代码：

```ts
check("a process that appeared since the last look is a candidate", candidates.includes(1002));
check("the shell Absence drove is not an egg",                     !claimed.includes(1001));
```

`candidatePids`、`attributeProcesses` 与 `buildEggs` 接收数据，因此命令窗口、祖先链与「孤儿不做猜测」这几条规则不需要启动任何进程即可验证。

第 2 层依赖 import 顺序。state 目录必须在存储模块被加载之前重定向，所以这些检查使用动态 import：

```ts
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "absence-metrics-"));
process.env.ABSENCE_STATE_DIR = stateDir;          // 必须先于模块加载
const { appendMetricsFrame } = await import("../../apps/server/src/sessions/storage/metrics");
```

静态 import 会让模块对用户的归档打开连接。

第 3 层的检查作为客户端，访问自己启动的 server。它们不依赖任何预先存在的资源：端口是临时的，state 目录是私有的，server 在清理阶段结束。CI 不安装内核观察器；`ci.yml` 的注释写明 watcher 会退回进程表采样，因此这些检查核对的是不依赖内核助手的会话、归档、指标与观察行为。

## 4. 分层未覆盖的内容

- **内核与 docker 路径。** `check-agentwatch` 在非 Windows 平台说明原因并以退出码 0 结束，`check-ebpf` 在非 Linux 平台同样处理。在其他平台上的通过不覆盖 Job Object 或 eBPF 路径。容器蛋只在可访问 docker daemon 时验证。
- **厂商 agent 行为。** `check-acp-mapping` 与 `check-acp-proxy` 使用脚本化 fixture agent，确立的是 Absence 处理协议的方式，不是厂商 agent 如何产生载荷。
- **真实 pi 会话。** 转录检查使用检查自身写出的 fixture 转录，确立的是解析、回填、续采与分歧处理，不是运行中的 pi 进程行为。
- **UI 渲染。** 仓库没有浏览器测试运行器。UI 行为由 `check-views` 在视图模型层覆盖；CSS、布局与桌面壳不在检查范围内。
- **mock agent 仿真。** `scripts/mock-agent/run.ts` 仍通过已移除的 ACP profile 路径创建会话，在本构建上失败。同一 mock 会话由 `check:e2e` 通过受支持的路径覆盖。

## 5. 失败可读性

`scripts/checks/harness.ts` 导出 `check`、`finish`、`section` 与 `waitFor`。

1. label 用平实语言陈述产品规则，例如 `"the shell Absence drove is not an egg"`。
2. `detail` 携带实际观察值，失败行因此显示看到了什么。
3. 块注释写明该检查钉住的回归。

`finish()` 在任一检查失败时退出非零，在一条检查都没跑时同样退出非零，因此不做断言的脚本无法通过。每个脚本是独立进程，runner 直接消费其退出状态。输出格式见 [testing.zh-CN.md](testing.zh-CN.md)。

## 6. 数字

| 项目 | 值 | 来源 |
|---|---|---|
| 登记条目 | 42 | `scripts/checks/groups.ts` |
| 不同登记脚本 | 40 | `scripts/checks/groups.ts` |
| 离线登记 | 37 | `groups.ts` 中的 `checks` 条目 |
| 不同离线脚本 | 35 | `groups.ts` 中的 `checks` 条目 |
| 手动检查 | 5 | `groups.ts` 中的 `platform` 条目 |
| 组 | 13 | `groups.ts` 的 `GROUPS` |
| CI | typecheck + `check:offline` | `.github/workflows/ci.yml` |
| 提交门禁 | `npm run verify` | 根 `package.json` |

## 7. 相关文档

- [testing.zh-CN.md](testing.zh-CN.md)：每条已登记检查与运行方式。
- [architecture.zh-CN.md](architecture.zh-CN.md)：这些检查所验证的事件管线。
