# Changelog

本文以中文为准。发布流程见 [docs/RELEASING.md](docs/RELEASING.md)；
v0.4.0 及更早的发布说明在 `docs/RELEASE_NOTES_v*.md`。

## v0.5.0 —— 标准接入层（ACP）与 UI 重构

### 标准接入层（ACP）

- 接入层统一为标准 ACP 协议：`AcpAdapter` / `AcpConnection` /
  `AcpToolMapper` + `AgentCatalog`。Pi、Codex 与所有其他 agent 都经同一层驱动；
  新增 agent 是加一条 profile 数据，不是加代码分支。
- 删除了全部深度耦合代码：Pi/Codex/DSH 各自的 adapter、`codex app-server`
  私有协议客户端、shell 接管（`AbsenceShell` / `ExecServer` / `CodexShell` /
  `ShellEnvironment`）、capabilities 配置管理（读写 agent 的
  mcp.json / skills / config.toml）、Pi 私有会话文件合并。
- Absence 不给 agent 提供接口、不处理 agent 请求，只做监控与转发：`/` 命令整行
  原文进 `session/prompt`；审批选项原样回传；认证走 agent 自己的
  `authenticate`；模型/thinking 档位来自 agent 的 `configOptions`。
- 只读配置策略：picker 的认证状态与声明模型来自对 agent 配置目录的只读探测，
  从不写入；npx 兜底默认关闭（`ABSENCE_ALLOW_NPX=1` 显式开启）。
- 事件保真：每条事件带 `source` / `fidelity`（`exact` / `reported` / `inferred` /
  `unknown`）；不存在的信息标 unknown，不猜。
- 归档：分页事件接口、归档删除、会话保留策略
  （`ABSENCE_SESSION_RETENTION_DAYS` / `ABSENCE_MAX_ARCHIVED_SESSIONS`）。
- 修复：agent 启动 chunk 不再被误报为一个 speaking 回合（新建会话不再卡在
  speaking）；停止未被确认时 UI 本地解锁；静默溢出与看门狗强制了结如实报错。

### UI 重构

- 探测式 agent 选择器：方格布局，每行显示真实探测结果（状态、发现来源、声明
  的模型、适配器安装提示），未安装的 agent 不占格子。
- 最后一格永远是 **"+"** 自定义 ACP 入口：label / command / args / env / cwd
  写入 `~/.absence/agents.json`，任意 ACP agent 无需改代码即可接入。
- 提示流：选中 agent 的事实（认证、模型来源、launch 覆盖）以同级 note 流入，
  不再是弹窗或硬编码分支。
- 命令面板是补全器：只列 agent 广告的命令 + `/auth`。

### 破坏性变更

- **历史只来自 Absence 归档**（`~/.absence/absence.db`）：不再读取或合并 Pi 的
  私有会话文件。旧 JSONL 归档仍在首次启动时一次性导入；agent 侧上下文经归档里
  的 ACP resume handle 恢复（历史列名 `piSessionFile` / `piSessionId` 保留兼容）。
- **`/` 命令纯转发**：Absence 自己实现的 `/model` / `/skill` / `/mcp` /
  `/thinking` 等全部删除；整行原文发给 agent，认不认由 agent 决定。唯一的本地
  动作是 `/auth <methodId>`。
- **删除 `GET /api/sessions/:id/commands/:name/options`**：命令选项由 agent 的
  `configOptions` / `available_commands_update` 承载。
- 会话快照/状态里的 `capabilities` 字段删除（无生产来源）；`AgentProfile` 的
  `discoverCapabilities` 字段删除（无消费方）。
- 环境变量 `ABSENCE_PI_TOOLS` 随 shell 接管一并删除。

### 已知债务（下一版处理）

- `agents/AgentAdapter.ts` 的 legacy 接口、`BaseAdapter` 与 `toAgentSessionPort`
  shim 是兼容壳：无新增调用方，v0.5.0 保留，下一版移除。
- 头像皮肤 / 提示音 / egg 过滤器仍写在安装目录（`apps/server/src/process/`），
  只读 asar 下上传失败；待迁到 `~/.absence/`。
- `ProcessWatcher.noteMarker` 仅供内核验收检查使用，生产未接线（有意保留）。
