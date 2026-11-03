# 测试与验收检查

[English](testing.md) | [简体中文](testing.zh-CN.md)

Absence 没有单元测试框架。验收行为由一组以 `tsx` 运行的独立脚本核对，覆盖进程归因、事件投影、归档往返、指标持久化与 ACP 传输；这些环节出错时不会表现为类型错误。[testing-strategy.md](testing-strategy.zh-CN.md) 说明分层与取舍；本文列出跑什么、怎么跑、失败时输出什么。

## 门禁

```bash
npm run typecheck       # packages/core、apps/server、apps/web 的 tsc
npm run build           # Web 生产构建，产物在 dist/web
npm run check:offline   # 全部 30 条离线检查
npm run check:acp-all   # 7 条已登记的 agent 层检查，随后跑 mock agent 仿真
npm run absence-sim     # 端到端仿真（与 check:mock-agent 同一 runner）
npm run verify          # typecheck + build + check:offline
```

`npm run verify` 是提交门禁。CI（`.github/workflows/ci.yml`）在 Node 22.23.4 上运行 `npm run typecheck --workspaces --if-present` 与 `npm run check:offline`。`check:acp-all` 与 `absence-sim` 是 agent 接入层变更的附加门禁；仿真不包含在 `check:offline` 中。

## 登记

`scripts/checks/groups.ts` 是检查登记位置，定义 12 个组、35 条已登记检查：30 条分布在各组的 `checks` 列表中（离线），5 条在 `platform` 列表中（手动）。`run-offline.ts` 与 `run-group.ts` 都读取该文件；`package.json` 只保留逐脚本别名。未登记的脚本只能按路径直接调用。

| 组 | 覆盖范围 | 离线检查 |
|---|---|---|
| `report` | 报告事实引擎、Markdown、格式化 | 3 条：`check-report`、`check-markdown`、`check-format` |
| `views` | face 视图模型：回放当前行、播放态、feed 折叠、成本面板、词汇完整性、viewMode 回退 | 1 条：`check-views` |
| `history` | 历史重建、run 分组、滑动窗口、事件缓存 | 2 条：`check-history`、`check-incremental` |
| `settings` | 阈值归一化、i18n 表完整性 | 1 条：`check-settings` |
| `chimes` | 提示音策略分支 | 1 条：`check-chimes` |
| `eggs` | 进程识别、分类、过滤器、项目外改动归属 | 3 条：`check-eggs`、`check-classify`、`check-outside-attr` |
| `metrics` | 采样、ring、重启存活、区间、观察会话寿命 | 5 条：`check-metrics`、`check-metrics-persist`、`check-metrics-ranges`、`check-metrics-restart`、`check-observed-lifetime` |
| `agent` | ACP 契约、命令转发、MCP 事件、观察器契约、catalog | 9 条：`check-capability-commands`、`check-mcp-events`、`check-observer`、`check-acp`、`check-acp-lifecycle`、`check-acp-transport`、`check-acp-mapping`、`check-acp-proxy`、`check-agent-catalog` |
| `session` | 归档存储、dwell 时钟、关闭、生命周期 | 4 条：`check-storage`、`check-session-dwell`、`check-session-close`、`check-lifecycle` |
| `io` | fsdiff 引擎 | 1 条：`check-fsdiff` |
| `pipeline` | 自起 server 的全链路 | 0 条离线；手动：`check-e2e` |
| `docker` | 容器蛋 | 0 条离线；手动：`check-docker`、`check-docker-eggs` |

`eggs` 组还登记了手动检查 `check-agentwatch` 与 `check-ebpf`。

每条登记带一个超时，启动 server 的检查使用更长的超时。runner 为每个脚本起一个子进程，非零退出或超时记为失败。

## 只跑一部分

```bash
npm run check:group -- list                     # 列出组、检查与手动项
npm run check:group -- report settings          # 按组名
npm run check:group -- affected                 # 只跑拥有改动文件的组（对比 HEAD）
npm run check:group -- affected --base main     # 对比指定基线
npm run check:group -- affected --all           # 包含手动检查
npm run check:process                           # eggs + agent + io，含手动检查
```

`affected` 用改动文件路径（含未跟踪文件）匹配各组的 `paths` glob 与该组自己的检查脚本。匹配不到任何组的改动会被说明为“由 typecheck 与 Web 构建覆盖”，命令以退出码 0 结束。

## 离线检查

30 条脚本。离线检查只需要 Node：不需要内核观察器二进制、不需要 docker、不需要提权，也不需要预先启动的 server。检查可以在临时端口上启动自己的 server，并使用私有的 `ABSENCE_STATE_DIR`；会话检查、`check-metrics-restart` 与 `check-history` 采用这种方式，仍属于离线集合。

按组列出的覆盖面：

- **报告与界面模型**：run 事实、时间线、注意力规则、Markdown 渲染、格式化、回放行、feed 折叠、历史重建与增量 memo。
- **设置与声音**：阈值归一化、i18n 完整性、提示音策略的各个分支。
- **进程蛋**：用伪造进程表核对归因、分类顺序、项目外改动归属、egg 折叠与退役。
- **指标**：采样输出、ring 行为、持久化、区间选择、server 重启后的存活、观察会话的寿命。
- **agent 层**：ACP 会话契约、能力门控、传输、工具映射、透明代理、catalog 发现与状态、斜杠命令转发、MCP 事件，以及不依赖随包适配器的观察器契约。
- **会话与存储**：旧归档导入、事件往返、缓冲 drain、归档列表、dwell 时钟、关闭与生命周期。
- **文件 diff**：fsdiff 引擎。

## 手动平台检查

5 条脚本，在 `groups.ts` 的 `platform` 列表中登记。它们不进入 `check:offline`；`affected` 默认跳过，只有传 `--all` 才运行；`check:group -- list` 会把它们列在手动项中。

| 检查 | 前提 | 核对内容 |
|---|---|---|
| `check-agentwatch` | Windows 与 `agentwatch` 助手 | Job Object 观察器能报告短命子进程，并带上命令行与归因 |
| `check-ebpf` | Linux、`agentwatch-linux` 助手及其所需权限 | eBPF 观察器能报告短命子进程，并带上命令行与归因 |
| `check-docker` | Windows 与 WSL 中可访问的 docker daemon | agent 驱动 docker 时 Job Object 观察器看到的内容与边界 |
| `check-docker-eggs` | 可访问的 docker daemon（PATH，或 Windows 上的 WSL 发行版） | 从命令窗口到容器启动事件、归因后的蛋、`docker stats` 资源、退出码，以及会话恢复时的重新 attach |
| `check-e2e` | 只需要 Node，但会启动真 server 与 mock 会话 | 一次运行内的命令事件、蛋、docker 可达时的容器蛋、指标帧与 SQLite 持久化 |

`check-agentwatch` 在非 Windows 平台会说明原因并以退出码 0 结束；`check-ebpf` 在非 Linux 平台同样处理，`check-docker` 在非 Windows 平台同样处理。在错误平台上得到的通过结果不覆盖内核路径或 Windows docker 路径。没有可访问的 docker 时，`check-docker-eggs` 以非零退出码结束。

内核与 docker 检查调用 `ProcessWatcher.noteMarker` 标记自己拉起的进程。生产代码不调用它。

## ACP 家族与 mock agent 仿真

`npm run check:acp-all` 按以下顺序执行八步：

```text
check:acp → check:acp-lifecycle → check:acp-transport → check:acp-mapping
→ check:acp-proxy → check:agent-catalog → check:observer → check:mock-agent
```

前七步是 `agent` 组中的 7 条已登记离线检查，第八步使用另一个 runner。

`scripts/mock-agent/agent.mjs` 是一个按 ACP 协议应答的脚本化 agent，不需要模型与凭据。`scripts/mock-agent/run.ts` 为每个场景建立一次性 home、state 目录与 workspace，用自定义 ACP profile 启动真 server，由 server 把 mock agent 作为真实子进程拉起，再从会话 WebSocket 与 SQLite 两侧读取产生的事件，核对场景的 `expect` 块。它把 `agent-trace.ndjson` 与 `absence-events.jsonl` 并排写在 `--out` 目录下。

`scripts/mock-agent/scenarios/` 下有 14 个场景：冷启动、流式 thinking、文件操作、命令重试、长输出、多轮、中途取消、并发工具、进程树、各 agent 的事件形状、diff 片段保真、部分读取保真、并发 execute、审批拒绝。

```bash
npm run absence-sim                          # 全部场景（= npm run check:mock-agent）
npm run mock:agent -- --list                 # 列出场景
npm run mock:agent -- --scenario 03-file-ops
```

仿真不在 `groups.ts` 中登记，也不属于 `check:offline`；它的门禁入口是 `check:mock-agent`，别名 `absence-sim`。

## 失败信号

每个检查都引用 `scripts/checks/harness.ts`（51 行，4 个导出：`check`、`finish`、`section`、`waitFor`）。

- `check(label, condition, detail)` 打印 `ok   <label>` 或 `FAIL <label>  — <detail>`。
- `finish()` 打印 `<passed>/<total> checks passed`；任一检查失败时退出码为 1。一条检查都没跑时也以退出码 1 结束，空脚本无法通过。
- `run-offline.ts` 打印 `all 30 offline checks passed`，或 `<n> check script(s) failed`；被超时终止的脚本会连同名称与 `groups.ts` 中的超时一起报告。
- `run-group.ts` 打印 `<n> check script(s) passed across <m> group(s)`，或 `<n> check script(s) failed`。

每个检查脚本是一个独立进程，runner 消费它的退出码；一个脚本失败不会被另一个脚本的汇总掩盖。

## 编写检查

1. 新建 `scripts/checks/check-<area>.ts`，从 harness 引用 `check`、`finish`，按需引用 `section`、`waitFor`。
2. 在 `groups.ts` 登记：写入组的 `checks` 并给出超时；需要内核助手、docker 或预先启动的 server 时写入 `platform`。把它涉及的源码路径加入该组的 `paths`，使 `affected` 能选中它。
3. 先按路径运行（`npx tsx scripts/checks/check-<area>.ts`），再通过 `npm run check:offline` 或 `npm run check:group -- <组>` 运行。

检查的标签用直述语句写明规则，`detail` 带上实际值，块注释写明它钉住的历史回归。需要重定向 state 目录的检查在 import 存储模块之前设置 `ABSENCE_STATE_DIR`；import 顺序的原因见 [testing-strategy.zh-CN.md](testing-strategy.zh-CN.md)。

## 开发辅助

- `npm run probe:acp -- <scenario>` 单跑一次采集并打印事件；`ABSENCE_ACP_BIN` 可指向真实 agent。
- `npm run registry:sync` 拉取 ACP 注册表到 `~/.absence/registry.json`。
- `npm run release:notes -- v<版本>` 从提交记录生成发布说明草稿。
