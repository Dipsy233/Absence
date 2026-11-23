# 测试与验收检查

[English](testing.md) | [简体中文](testing.zh-CN.md)

Absence 没有单元测试框架。验收行为由一组以 `tsx` 运行的独立脚本核对，覆盖进程归因、事件投影、归档往返、指标持久化与观察通道行为；这些环节出错时不会表现为类型错误。[testing-strategy.zh-CN.md](testing-strategy.zh-CN.md) 说明分层与取舍。

## 1. 门禁

```bash
npm run typecheck       # packages/core、apps/server、apps/web 的 tsc
npm run build           # Web 生产构建，产物在 dist/web
npm run check:offline   # 全部已登记的离线检查
npm run verify          # typecheck + build + check:offline
```

`npm run verify` 是提交门禁。CI（`.github/workflows/ci.yml`）在 Node 22.23.4 上运行 `npm run typecheck --workspaces --if-present` 与 `npm run check:offline`。

agent 层另有两个门禁：

```bash
npm run check:acp-all   # check:acp-mapping + check:acp-proxy
npm run check:e2e       # 真 server 加 mock 会话（手动平台检查）
```

`npm run absence-sim`（`scripts/mock-agent/run.ts`）仍通过已移除的 ACP profile 路径创建会话，在本构建上失败，不是可用的门禁。

## 2. 登记

`scripts/checks/groups.ts` 是检查登记位置，定义 13 个组、35 个脚本上的 37 次离线登记，以及 5 条手动平台登记。两个脚本同时登记在 `eggs` 与 `session` 组。`run-offline.ts` 与 `run-group.ts` 都读取该文件；`package.json` 只保留逐脚本别名。

| 组 | 覆盖范围 | 离线检查 |
|---|---|---|
| `report` | 报告事实引擎、全 run 汇总、Markdown、格式化 | 4 条：`check-report`、`check-chart-allrun`、`check-markdown`、`check-format` |
| `views` | face 视图模型：回放当前行、播放态、feed 折叠、成本面板、词汇完整性、viewMode 回退 | 1 条：`check-views` |
| `history` | 历史重建、run 分组、滑动窗口、事件缓存 | 2 条：`check-history`、`check-incremental` |
| `settings` | 阈值归一化、i18n 表完整性 | 1 条：`check-settings` |
| `chimes` | 提示音策略分支 | 1 条：`check-chimes` |
| `eggs` | 进程识别、分类、过滤器、项目外改动归属、会话隔离 | 6 条：`check-eggs`、`check-agentwatch-external`、`check-classify`、`check-outside-attr`、`check-outside-scope`、`check-session-isolation` |
| `metrics` | 采样、ring、重启存活、区间、进程蛋寿命 | 5 条：`check-metrics`、`check-metrics-persist`、`check-metrics-ranges`、`check-metrics-restart`、`check-observed-lifetime` |
| `agent` | 工具映射、MCP 事件、代理 | 3 条：`check-mcp-events`、`check-acp-mapping`、`check-acp-proxy` |
| `session` | 归档存储、dwell 时钟、关闭、生命周期、会话隔离 | 6 条：`check-storage`、`check-session-dwell`、`check-session-close`、`check-lifecycle`、`check-outside-scope`、`check-session-isolation` |
| `observe` | 转录发现、目标选择、租约、仅 OS 监控、中途挂载、断点续采、代理持久化、CLI | 7 条：`check-observe-board`、`check-observe-watch`、`check-observe-os`、`check-cli-observe`、`check-observe-midway`、`check-observe-transcript`、`check-observe-proxy` |
| `io` | fsdiff 引擎 | 1 条：`check-fsdiff` |
| `pipeline` | 自起 server 的全链路 | 0 条离线；手动：`check-e2e` |
| `docker` | 容器蛋 | 0 条离线；手动：`check-docker`、`check-docker-eggs` |

`eggs` 组还登记了手动检查 `check-agentwatch` 与 `check-ebpf`。

每条登记带一个超时，启动 server 的检查使用更长的超时。runner 为每个脚本起一个子进程，非零退出或超时记为失败。

## 3. 只跑一部分

```bash
npm run check:group -- list                     # 列出组、检查与手动项
npm run check:group -- report settings          # 按组名
npm run check:group -- affected                 # 只跑拥有改动文件的组（对比 HEAD）
npm run check:group -- affected --base main     # 对比指定基线
npm run check:group -- affected --all           # 包含手动检查
npm run check:process                           # eggs + agent + io，含手动检查
```

`affected` 用改动文件路径（含未跟踪文件）匹配各组的 `paths` glob 与该组自己的检查脚本。匹配不到任何组的改动会被说明为由 typecheck 与 Web 构建覆盖，命令以退出码 0 结束。

## 4. 离线检查

离线检查只需要 Node：不需要内核观察器二进制、不需要 docker、不需要提权，也不需要预先启动的 server。检查可以在临时端口上启动自己的 server，并使用私有的 `ABSENCE_STATE_DIR`。

按领域列出的覆盖面：

| 领域 | 检查 | 确立的结论 |
|---|---|---|
| 报告与视图模型 | `check-report`、`check-chart-allrun`、`check-markdown`、`check-format`、`check-views`、`check-history`、`check-incremental` | run 事实、全 run 汇总、时间线、注意力规则、Markdown 渲染、格式化、回放行、feed 折叠、历史重建与增量 memo |
| 设置与声音 | `check-settings`、`check-chimes` | 阈值归一化、i18n 完整性、提示音策略分支 |
| 进程蛋 | `check-eggs`、`check-classify`、`check-outside-attr`、`check-outside-scope`、`check-session-isolation`、`check-agentwatch-external` | 伪造进程表上的归因、分类顺序、项目外改动归属、会话隔离、egg 折叠与退役、外部扫描配对 |
| 指标 | `check-metrics`、`check-metrics-persist`、`check-metrics-ranges`、`check-metrics-restart`、`check-observed-lifetime` | 采样输出、ring 行为、持久化、区间选择、server 重启后的存活、进程蛋寿命 |
| agent 层 | `check-mcp-events`、`check-acp-mapping`、`check-acp-proxy` | 按 kind 与形状的工具映射、MCP 事件、代理转发、tap 投影、诊断、代理 CLI 退出 |
| 会话与存储 | `check-storage`、`check-session-dwell`、`check-session-close`、`check-lifecycle` | 旧归档导入、事件往返、缓冲 drain、归档列表、dwell 时钟、关闭与生命周期 |
| 观察 | `check-observe-board`、`check-observe-watch`、`check-observe-os`、`check-cli-observe`、`check-observe-midway`、`check-observe-transcript`、`check-observe-proxy` | 发现不自动挂载、目标选择与租约、重启恢复、转录 checkpoint 续采、前缀不一致、仅 OS 监控与升级、中途挂载、回填完整性、拒绝驱动、CLI 绑定守卫与令牌处理 |
| 文件 diff | `check-fsdiff` | diff 引擎 |

## 5. 手动平台检查

5 个脚本登记在各组的 `platform` 列表中，不进入 `check:offline`；`affected` 默认跳过，只有传 `--all` 才运行。

| 检查 | 前提 | 核对内容 |
|---|---|---|
| `check-agentwatch` | Windows 与 `agentwatch` 助手 | Job Object 观察器报告短命子进程，并带上命令行与归因 |
| `check-ebpf` | Linux、`agentwatch-linux` 助手及其权限 | eBPF 观察器报告短命子进程，并带上命令行与归因 |
| `check-docker` | 可访问的 docker daemon | agent 驱动 docker 时内核观察器看到的内容与边界 |
| `check-docker-eggs` | 可访问的 docker daemon | 从命令窗口到容器启动事件、归因后的蛋、`docker stats` 资源、退出码，以及会话恢复时的重新 attach |
| `check-e2e` | 只需要 Node；启动真 server 与 mock 会话 | 一次运行内的命令事件、蛋、指标帧与 SQLite 持久化 |

`check-agentwatch` 在非 Windows 平台说明原因并以退出码 0 结束；`check-ebpf` 在非 Linux 平台、`check-docker` 在非 Windows 平台同样处理。在其他平台上得到的通过结果不覆盖内核路径或 Windows docker 路径。没有可访问的 docker 时，`check-docker-eggs` 以非零退出码结束。

内核与 docker 检查调用 `ProcessWatcher.noteMarker` 标记自己拉起的进程。生产代码不调用它。

## 6. 失败信号

每个检查都引用 `scripts/checks/harness.ts`，它导出 `check`、`finish`、`section` 与 `waitFor`。

- `check(label, condition, detail)` 打印 `ok   <label>` 或 `FAIL <label>  — <detail>`。
- `finish()` 打印 `<passed>/<total> checks passed`；任一检查失败或一条检查都没跑时退出码为 1。
- `run-offline.ts` 打印 `all <n> offline checks passed`，或 `<n> check script(s) failed`；被超时终止的脚本连同名称与 `groups.ts` 中的超时一起报告。
- `run-group.ts` 打印 `<n> check script(s) passed across <m> group(s)`，或 `<n> check script(s) failed`。

每个检查脚本是一个独立进程，runner 消费它的退出码；一个脚本失败不会被另一个脚本的汇总掩盖。

## 7. 编写检查

1. 新建 `scripts/checks/check-<area>.ts`。
2. 从 `./harness` 引入 `check`、`section` 与 `finish`。
3. 在引入 server 模块之前设置 `ABSENCE_STATE_DIR` 等环境变量，赋值后再用动态 `import()`。
4. 在 `scripts/checks/groups.ts` 中登记脚本、所属组、paths 与超时。
5. 只有经常单独运行的脚本才在 `package.json` 中添加别名。

启动 server 的检查在不测试观察时设置 `ABSENCE_OBSERVE=0`，并始终使用私有的 `ABSENCE_STATE_DIR`。
