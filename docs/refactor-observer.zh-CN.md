# Absence 旁观化重构方案(re 分支)

> 状态:方案定稿,待实施。
> 目标生态位:**纯旁观监控看板**。Absence 不再启动、驱动、应答任何 agent;用户照常在终端/编辑器里使用 Claude Code、Pi、Codex、Gemini、Qwen 等,使用习惯零改变;Absence 只负责"看见",并保留现有全部监控能力。
>
> **决策记录:**
> 1. **完全脱离 ACP 依赖**:ACP 从"必需品"降级为三条采集通道中的一条(可选,仅服务编辑器 ACP 客户端用户)。监控核心 = 转录尾随 + OS 旁观,零 ACP 也可运行。
> 2. **随开随关 + 回填**:支持中途 attach;转录文件从头回填历史;detach(关 UI 继续监控)/ 关服(转录为事实源,重开重新探测)/ 归档 三层关闭语义。
> 3. **启动器降级**:不作为主路径(违背零习惯改变);可留一个可选"辅助启动"入口以换取精确归因(注入 ABSENCE_SESSION_ID),放最后阶段,视签名识别精度决定去留。
> 4. **最终修订(pi-only,已执行)**:转录源只做 pi——唯一承诺的私有格式耦合(开源,格式可审计,docs.pi.dev/latest/session-format.md 为真源)。claude-code/codex 的解析器与源声明**已移除**,不做任何通道预留;接口解耦落在 `AbsenceEvent`/`MonitorEvent` 契约与 source 注册上,未来换/加监听 = 新模块实现同一接口注册即可。历史会话只列出不挂载,自动挂载仅限活跃转录(10 分钟窗口),手动挂载走 `POST /api/observe/attach`。

---

## 1. 现状判断(重构依据)

### 1.1 当前生态位:"驾驶位 + 行车记录仪"

代码层面,Absence 同时扮演两个角色:

- **驾驶位(要拆除)**:服务端通过 ACP profile 自己 spawn agent(`apps/server/src/agents/acp/AcpConnection.ts` 的 `createStdioTransport` → `spawn`),Web UI 是唯一驱动者:chat 输入行发 prompt(`POST /api/sessions/:id/prompt`)、审批对话框替用户应答权限请求(`POST /api/sessions/:id/approval`)、`/model` `/auth` 命令切换(`POST /api/sessions/:id/command`)。会话生命周期与 picker 绑定:离开 UI(`POST /close`)即销毁运行时、watcher 和 metrics sampler(`apps/server/src/api/sessions.ts:489` 注释)。
- **行车记录仪(要保留并加强)**:Stage 渲染、Activity 流、Agent Folder、Eggs、资源指标、Docker 监控、MCP 事件、Absence Report(确定性归约,LLM-free)、历史归档(SQLite)、回放、三个 face + Drip。

### 1.2 已有的"旁观基因"(重构的地基,全部保留)

| 现有资产 | 位置 | 旁观化价值 |
|---|---|---|
| ACP proxy 只读 tap | `apps/server/src/agents/acp/proxy/tap.ts` | 已经是纯旁观:字节级转发原始行、只解析不改写、追踪权限请求与真实客户端的应答、投影为 MonitorEvent |
| proxy 转发层 | `proxy.ts` / `transport.ts` / `registry.ts` | 字节级转发已验证;TCP/stdio 双模式;**proxy 模式下 agent 由 proxy 自己 spawn**(`createAgentTransport`),因此可以做完整内核归因 |
| 事件 provenance | `packages/core/src/events.ts` 的 `source`/`fidelity` | 事件模型天然支持多来源(`acp` / `acp-proxy`),直接扩展 `transcript`、`os` 即可 |
| ACP 投影器 | `apps/server/src/monitor/projector.ts` + `AcpToolMapper.ts` | ACP 语义 → AbsenceEvent 的映射核心,两条新通道都复用 |
| FileWatcher | `apps/server/src/filesystem/FileWatcher.ts` | **项目级 watch,完全不依赖 agent 进程所有权**(归因靠内容/时间声明) |
| ProcessWatcher 轮询兜底 | `apps/server/src/process/ProcessWatcher.ts` | 轮询进程表本身不要求所有权;只是归因函数(`reachesOwned`)目前只认自己 spawn 的进程 |
| MetricsSampler 轮询路径 | `apps/server/src/process/ProcessMetrics.ts` | 进程表采样可用于任意 pid,当前仅被"owned 限定"束缚 |
| Docker 监控 | `process/DockerMonitor.ts` + `DockerEggs.ts` | 容器事件本来就不经过 Job Object,归因逻辑放宽即可复用 |
| Report 引擎 | `packages/core/src/report.ts` | 纯确定性归约,吃什么事件出什么报告,零改动 |
| SQLite 归档 | `apps/server/src/sessions/storage/*`,schema v4 | events/runs/file_versions/metric_chunks 全部沿用 |
| mock agent 测试基建 | `scripts/mock-agent/` | proxy 通道测试直接复用 |

### 1.3 关键限制(重构必须回答的问题)

1. **用户在终端直接跑 `claude` / `pi` / `codex` 时,根本没有 ACP 流**——CLI 直连模型 API。Absence 看不见 ACP 会话内容,除非:
   - a) 读 agent 自己写的**会话转录文件**(Claude Code:`~/.claude/projects/<escaped-cwd>/<uuid>.jsonl`;Codex:`~/.codex/sessions/rollout-*.jsonl`;pi/gemini/qwen 各有自己的目录)——这是唯一**零习惯改变**的内容级通道;
   - b) 或用户走编辑器 ACP 客户端(Zed 等)时,把 ACP 入口指向 Absence 的 proxy——一行配置的改动,换来字节级完整事件。
2. **Windows Job Object 只覆盖 server 的后代进程**(`native/agentwatch`):非 Absence 启动的 agent 在 Windows 上只能靠轮询进程表观察(已有兜底路径),归因要改用"签名识别 + pid 祖先链"。
3. **Run 的边界目前是"用户消息"**(`isRunBoundary`):prompt 文本既是 run 的身份,也是 Chart/History 的主键。旁观模式下必须重新定义。

---

## 2. 目标生态位与总体架构

### 2.1 一句话定位

> Absence 是 AI agent 的**行车记录仪 + 塔台雷达**:雷达(进程/文件/容器/资源)全天候扫描,记录仪(事件流)在用户允许的三条车道上录制;它不握方向盘,不坐副驾。

### 2.2 三条采集通道(全部只读)

```
┌─────────────────────────────────────────────────────────────────┐
│                        MonitoredSession(观测会话)               │
│   键 = (channel, agentKind, projectPath, externalId)             │
└──────────────┬──────────────────┬──────────────────┬────────────┘
               │                  │                  │
   ┌───────────▼─────┐  ┌─────────▼────────┐  ┌──────▼──────────┐
   │ 通道 A:转录尾随  │  │ 通道 B:ACP proxy │  │ 通道 C:OS 旁观  │
   │ TranscriptTail   │  │ AcpProxyTap      │  │ OS Layer        │
   ├─────────────────┤  ├──────────────────┤  ├─────────────────┤
   │ 尾随 agent 自己  │  │ 用户把 ACP 客户端 │  │ FileWatcher     │
   │ 写的会话 JSONL:  │  │ 指向 Absence 代理,│  │ ProcessWatcher  │
   │ ~/.claude/...   │  │ 字节级转发给 agent,│  │ (签名识别+祖先链)│
   │ ~/.codex/...    │  │ tap 只读投影事件; │  │ MetricsSampler  │
   │ pi / gemini /   │  │ proxy 亲自 spawn  │  │ DockerMonitor   │
   │ ~/.qwen/...     │  │ agent→内核级归因  │  │ JobMonitor/eBPF │
   └─────────────────┘  └──────────────────┘  └─────────────────┘
               │                  │                  │
               └──────────────────┴──────────────────┘
                                  ▼
                    MonitorBus → AbsenceSession 事件管线
              (handleEvent → applyToState → EventBus → SQLite → WS)
```

**通道选择哲学**:
- 用户在终端裸用 CLI → 通道 A + C(零习惯改变,内容靠转录,行为靠 OS);
- 用户走编辑器 ACP 客户端 → 通道 B + C(一行 endpoint 配置,事件字节级完整:含 thinking、MCP、权限问答、usage);
- 无论哪条车道,通道 C 始终在跑。

### 2.3 新增核心组件

**① TranscriptSource profile(转录源,数据化定义,延续"profile 即数据"哲学)**

```ts
// apps/server/src/observe/transcriptSources.ts
interface TranscriptSourceProfile {
  id: 'claude-code' | 'codex' | 'pi' | 'gemini' | 'qwen' | 'dsh' | custom;
  /** 会话文件的 glob(支持自定义覆盖) */
  glob: string;                       // e.g. '~/.claude/projects/**/*.jsonl'
  parserId: string;                   // 对应转录解析器
  /** 从记录里取项目 cwd 的字段路径;各 agent 转录里都带 cwd */
  cwdField?: string;
  enabledByDefault: boolean;
}
```

与现有 `AgentLaunch` profile(`profiles.ts`)同构:发现命令 → 变为发现转录目录;`~/.absence/agents.json` 继续作为用户覆盖点。

**② TranscriptTail(转录尾随器)**

- `chokidar` watch 各转录根目录(新增文件 + 修改事件),从文件末尾增量读(记录 offset);
- 每种 agent 一个 `TranscriptParser`:原生记录 → `MonitorEvent`(复用 `AcpMonitorProjector` 的语义层,tool_use/file_edit/thinking/usage/MCP 的映射逻辑大量可搬);
- Claude Code 转录含:用户消息、assistant 消息、tool_use(含 `mcp__server__tool`)、thinking、per-message `usage`、`toolUseResult`(权限拒绝痕迹)、`cwd`、`sessionId`、时间戳 → **内容级能力基本无损失**;
- Codex rollout 含 session_meta/response items → 命令、文件、消息可还原;
- 解析失败/版本漂移 → 记 `fidelity: 'partial'` 降级,不炸会话;
- pi/gemini/qwen/dsh 的目录与格式在实现期逐一核对,先以实验性 profile 落地。

**③ DiscoveryService(发现服务,替代"启动会话"的语义)**

- `TranscriptScanner`:周期扫描(或 watch)转录根目录 → 新文件 → 解析首条记录得 `(agentKind, cwd, externalId)` → **自动创建 MonitoredSession**;
- `ProcessScanner`:周期扫进程表,按签名(claude / codex / pi / gemini / qwen / dsh 及其 `-acp` 变体,可配置)识别 agent 进程 → 出现在"在场名单";与转录会话对齐(同 cwd)或独立展示;
- **检测双信号**:进程签名 + 转录文件出现。归因读进程 cwd(Windows 走已有 PEB 读取机制,`ProcessWatcher` 已有 PEB 访问;Linux 读 `/proc/<pid>/cwd`)与转录 cwd 对齐;
- **幂等 attach**:同一 `(agentKind, cwd, externalId)` 只建一个观测会话;用户在 Observatory 里点击的永远是 attach/detach,不是创建;
- proxy 会话在 client 接入时自动注册;
- **会话由"发现"产生,不再由"创建"产生**——这是生态位反转的枢纽。

**④ MonitoredSession(替换 AbsenceSession 聚合根)**

- 保留 `AbsenceSession` 的事件管线骨架(`handleEvent` / `applyToState` / bus / persist / scheduleState),剥离 adapter 驱动部分;
- **UI attach/detach 与观测生命周期解耦**:观察者断开 WS,采集继续;会话在"转录静默 N 分钟 + agent 进程离场"后自动归档(阈值可配);
- resume 语义 → **re-attach**:重开归档视图,不再 respawn agent(`AcpSession.open` 的 session/resume 整条路径删除)。

### 2.4 Run 语义重定义

| 通道 | run 开始 | run 结束 | run 身份 |
|---|---|---|---|
| ACP proxy | 用户 message 事件(与现在一致) | `agent_end` | 用户 prompt 文本 |
| 转录 | 转录中的用户消息记录 | assistant 收尾 / 静默 | 用户 prompt 文本 |
| 纯 OS(无内容源) | 活动突发起点(静默间隙后) | 静默超时 | 时间戳 + 首个命令/文件摘要 |

`packages/core/src/runs.ts` 的 `RunSummary` 增加 `boundarySource` 字段;报告引擎零改动(它只吃事件)。

### 2.5 权限(approval)的旁观化

- proxy 通道:tap 已追踪 `session/request_permission` 与真实客户端的应答(`tap.ts` 的 permission 计数与 unanswered 诊断)→ 前端 `ApprovalStage` 改为**只读卡片**:"agent 请求了 X,客户端已选择 Y / 尚未应答";
- 转录通道:Claude Code 的 `toolUseResult` 含权限结果 → 同样的只读展示;
- 删除 `respondApproval` 写回路径(`AcpPermissionBridge.respond`)。

### 2.6 ACP 依赖降级(能力对照)

事件管线(`MonitorBus` → `handleEvent` → SQLite → WS)通道无关:ACP 投影器与转录解析器产出同构的 `MonitorEvent`,provenance 字段区分来源。ACP 由此从"必需品"降级为可选通道。

| 能力 | 现在 | 脱离 ACP 后 |
|---|---|---|
| 文件读写/编辑版本链 | FS diff,不依赖 ACP | 原样保留 |
| 进程/eggs、指标、Docker | Job Object / eBPF / 进程表 / docker events | 原样保留(归因函数改造) |
| 消息、tool_use、MCP、thinking、usage、权限结果 | ACP 流 | **转录通道补上**(三种主流 agent 的会话 JSONL 均含) |
| 工具执行中的流式输出 | ACP 流式 update | 损失:Stage 显示"运行中,输出待完成" |
| agent 广播的 model 列表 | ACP config options | 损失:模型变化以事件形式从转录展示 |

pi 已具备落地条件:repo 已知其目录发现(`profiles.ts` inspect:`~/.pi/agent` + `PI_CODING_AGENT_DIR`),且 pi 的 ACP resume handle 就是其会话文件本身——文件是可解析的持久化 JSONL。

### 2.7 随开随关与回填

用户可以在会话任意时刻开始/停止监控,不必从 pi 启动那一刻在场:

- **attach 即回填**:点击监控 → 转录文件从第 0 行增量读入 → 既有消息、工具调用、文件写入(Write/Edit 的完整内容在转录里)补进观测会话;FS 只保留当前态,历史文件版本以转录带内容的为限;
- **三层关闭语义**:
  1. *detach*——关 UI / 离开会话,后台采集继续;
  2. *关闭 Absence*——监控停;转录文件是事实源,重开后 DiscoveryService 重新探测并做增量回填;
  3. *归档*——SQLite 历史照旧,archived 会话在 History 中可回放;
- attach/detach 幂等;`POST /close` 的"销毁运行时"语义删除。

### 2.8 启动器的定位(降级项)

"从 Absence 启动一个终端跑 pi"仅带来归因精度收益(spawn → 注入 `ABSENCE_SESSION_ID` → Windows Job Object 的精确 create/exit 事件,替代轮询 diff),不带来内容级事件(内容仍靠转录)。它违背零习惯改变的主定位,且跨平台拉起终端成本高。**决策**:主路径永远是检测;可在 Observatory 留一个可选"辅助启动"入口(驾驶位的无害残留:只 spawn,不驱动),放 Phase 5 之后,视 Phase 2 签名识别的实际精度决定去留或删除。

---

## 3. 拆除清单 / 保留清单

### 3.1 拆除(交互面,一次性移除)

**服务端:**
- `POST /api/sessions/:id/prompt`、`/abort`、`/approval`、`/command`(`api/sessions.ts:416-476`)
- `POST /api/sessions` 的 spawn 语义(改为 attach 已发现的会话;`sessionStore.create` 的 spawn 路径)
- `AcpAdapter.runTurn / cancel / respondApproval / setModel / authenticate`(`agents/acp/AcpAdapter.ts`)
- `AcpPermissionBridge.respond`(保留请求侧 tap)
- `AcpConnection` 的 prompt/cancel/setConfigOption/authenticate/resume(整条 drive-mode 客户端;proxy 走自己的 raw transport + tap,不需要它)
- `POST /api/sessions/:id/close` 的"销毁运行时"语义 → 改为"detach 观察者"

**Web 端:**
- `useChatInput.ts` / `ChatCommandPalette.tsx` / `FaceChat.tsx` 的发送能力(`sendPrompt`/`abort`/`runCommand`)/ `ContextChip`(+ Chat 上下文暂存)
- `sessionStore.models` 与 `/model` 选择面板(commit 2299aaf 引入的 chat 切模型)
- `ProjectPicker` 的"选 agent → 启动"流程 → 重生为 **Observatory 观测台**(见 §4 UI)
- `ApprovalStage` 的应答按钮

### 3.2 原样保留(全部监控能力)

Stage 全套渲染器、Activity 流、Agent Folder(FS diff 版本链 + 转录补全 read 行号)、Eggs 及分类器、`egg-filter` API、资源指标 + Prometheus 导出、Docker 监控、MCP 事件卡、Report 引擎(`packages/core/report.ts`,零改动)、SQLite 归档 + 历史检索 + 回放(0.25×–10×)、Chart/Rounds/Monitor/Drip 四 face、avatar skins、sounds、主题、desktop 壳(tray 文案改为"正在监控 N 个 agent")。

### 3.3 改造(复用骨架,换归因)

| 组件 | 改动 |
|---|---|
| `ProcessWatcher.reachesOwned` | → `reachesAttributed`:pid 祖先链上出现**已识别的 agent 根**(签名匹配或 proxy spawn 记录)即归属 |
| `ProcessMetricsSampler` | 目标集从"owned 树"扩为"attributed 树";Windows 非 owned 走轮询路径(已有),节流可配 |
| `JobMonitor` / eBPF | 保留;proxy 通道给 spawn 的 agent 注入 `ABSENCE_SESSION_ID` → Windows 上获得完整 Job 事件;eBPF 本来就是全机的 |
| `DockerEggs.lay()` | 归因从"本会话命令窗口"放宽为"attributed 会话 + 项目/镜像相关性" |
| `AgentCatalog` | 从"启动发现"转为"proxy 目标 + 转录源注册表" |
| WS 契约(`packages/core/ws.ts`) | 增加 `observation_state` 帧(在场 agent、通道健康度);其余帧不变 |

---

## 4. UI:从 Picker 到 Observatory

**Observatory(观测台)** — 无会话时的默认页,也是顶栏入口:

```
┌─ Observatory ────────────────────────────────────────────┐
│ ● 在场 agent(进程扫描)                                  │
│   claude · E:\proj\foo · pid 12345 · CPU 3% · [查看]     │
│   codex  · E:\proj\bar · pid 23456 · 未发现转录 · [查看]  │
│ ○ 活跃观测(转录尾随)                                    │
│   claude/foo #a1b2 · 3 分钟前活跃 · 通道A+C              │
│ ○ ACP 代理                                               │
│   :9001 → codex-acp · 1 客户端 · [新建代理]              │
│ ○ 历史(SQLite 归档,不变)                                │
└──────────────────────────────────────────────────────────┘
```

- chat 行 → **Transcript 视图**(只读对话流;`ChatThread` 本来就是纯展示,删发送器即可);
- `/model` 面板 → 删除(模型变化以事件形式展示);
- `ApprovalStage` → 只读权限卡;
- FaceBar / 三 face / Drip / 回放 / 历史全部不动。

---

## 5. 数据与契约变更

**SQLite schema v4 → v5:**
- `sessions` 表:`+ channel`('transcript'|'acp-proxy'|'os'), `+ external_id`(agent 侧会话 id), `+ agent_kind`;移除 resume handle 依赖;
- `events`:provenance 列已存在,source 值域扩展(`acp-proxy` / `transcript` / `os`);
- `runs`:`+ boundary_source`('user-message'|'activity-burst'|'agent-end');
- 旧归档照常可读(v4 历史会话进 History 无需迁移)。

**REST 调整:**
- 新增:`GET /api/observe/agents`(在场名单)、`GET /api/observe/sources`(转录源状态)、proxy 会话升级为持久化观测会话;
- 删除:prompt / abort / approval / command 四个写回端点;
- `POST /api/sessions` → `POST /api/observe/attach`(绑定到已发现会话,不 spawn)。

---

## 6. 实施阶段(每阶段保持 checks 绿)

> 分支:`re`(已建)。每个阶段完成即跑 `npm run check:offline` + 相关专项 check,阶段末更新 `docs/architecture.md` 双语。
>
> **进度:** Phase 1 完成 + pi-only 修订已执行(2026-11-21,re 分支)。解析器 = `observe/parsers/pi.ts`(显式 stopReason/toolResult 生命周期,复用 AcpToolMapper);claudeCode.ts 已删除;Discovery 三态(unknown→header-only 解析 / attached→增量尾随 / missing),自动挂载仅限 10 分钟内活跃转录,历史会话 `POST /api/observe/attach` 手动回填。
> - `observe/` 落地:`transcriptSources.ts`(claude-code 实装,codex/pi 声明待实现)、`parsers/claudeCode.ts`(转录 → AbsenceEvent,复用 AcpToolMapper,Write/Edit 由解析器直映射)、`ObserveAdapter.ts`(no-op 适配器 = 事件注入点,写回路径全部拒绝)、`Discovery.ts`(chokidar 尾随 + 字节偏移增量读 + 回填 + 幂等 attach);
> - `SessionStore.createObserved` + `AbsenceSession` observe 模式(不 spawn runtime;prompt 抛错、command 回 notice);主目录/盘根 cwd 的转录降级为仅事实(`watchProject: false`,不建树不 watch);
> - REST `GET /api/observe/sessions`(+ core 契约类型);`config.observeEnabled`(ABSENCE_OBSERVE=0 可关);
> - `check:observe-transcript` 29/29;全量 `check:offline` 34 组全绿;真机冒烟:服务器自动发现本机 17 条真实 Claude Code 转录并逐条建会话解析事件;
> - 起服务器的 9 个检查脚本补了 `ABSENCE_OBSERVE=0` 测试隔离;真实归档中因早期无隔离写入的 2 条观察会话已清理。
> - 遗留小项:schema v5 的 channel/external_id 落库(当前观察会话仍走现有 sessions 表 + meta.runtime=agentKind,History 可见;结构化通道列延后到 Phase 5 与自动归档一起做)。**已知代价**:身份幂等只在内存(`sessionsByExternal`),转录存活期间重启服务器会为同一外部会话建出新归档行(历史重复);attach 前按 external_id 查回既有归档的 re-attach 是 Phase 5 的核心工作,届时单次迁移定型(channel 值域与 external_id 语义需 Phase 3 的第二条通道一起定)。若在 Phase 5 前需要长生命周期跨重启运行,可把"externalId 写入 meta JSON + 重启查回"的过渡方案提前。

### Phase 1 — 旁观采集核心(通道 A 落地)
1. 新建 `apps/server/src/observe/`:`transcriptSources.ts`(profile)、`TranscriptTail.ts`、`parsers/claudeCode.ts` + fixture 测试;
2. `MonitoredSession` 骨架(复用 AbsenceSession 管线,去 adapter),自动发现建会话,**attach 从转录第 0 行回填**;
3. 事件 provenance 扩展,SQLite v5 migration;
4. 新 check:`check:observe-transcript`(fixture 假 HOME,喂真实转录样本)。

### Phase 2 — 归因重做(通道 C 扩展)
1. `reachesAttributed` + ProcessScanner 签名识别;
2. MetricsSampler 目标扩展 + Windows 轮询节流;
3. DockerEggs 归因放宽;
4. 新 check:`check:agentwatch-external`(非 owned 进程的发现/指标/eggs)。

### Phase 3 — Proxy 通道升级(通道 B)
1. proxy 会话持久化(进 SQLite、进 run index)、spawn 注入 `ABSENCE_SESSION_ID`;
2. Web 可 attach proxy 会话;权限问答只读卡;
3. `absence proxy` CLI 与 mock-agent checks 全量回归。

### Phase 4 — 交互面拆除
1. 删 4 个写回端点 + drive-mode adapter/connection 残骸;
2. Picker → Observatory;chat → 只读 Transcript;ApprovalStage 只读化;
3. `check:e2e` 改写为新流程(发现 → attach → 观察 → 归档)。

### Phase 5 — 生命周期与收尾
1. 自动归档(静默阈值)、detach/re-attach 语义收敛(`GET /api/sessions/:id/close` → detach)、重开 Absence 的增量回填;
2. pi / gemini / qwen / dsh 转录源逐一核对落地(pi 目录发现已有:`~/.pi/agent` + `PI_CODING_AGENT_DIR`,实验标记);
3. 可选"辅助启动"入口评估(依 Phase 2 签名识别精度决定去留);
4. README/architecture 双语重写(生态位声明);CHANGELOG;
5. 旧会话归档兼容性验证。

---

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| 转录格式随 agent 版本漂移 | 解析器版本化 + fixture 回归;解析失败降级 `fidelity: partial`,绝不炸会话 |
| Windows 非 owned 进程指标靠轮询,CPU 开销高 | 轮询间隔可配(默认沿用 1.1s/4s 两档);进程离场即停 |
| 转录含完整对话内容(隐私) | 本地存储不变;新增可配的 prompt 脱敏开关(存储层截断) |
| 通道间事件重叠(转录 + proxy 同时看同一会话) | MonitoredSession 键含 channel;同 externalId 的多通道挂到同一观测会话下分事件流去重(provenance 判重) |
| pi/gemini/qwen 转录目录/格式不确定 | 实现期核对;先实验性 profile,失败仅影响该 agent 的内容级能力,OS 通道兜底 |
| run 身份无 prompt 文本(纯 OS 通道) | 时间戳 + 首命令摘要兜底;Chart UI 对此类 run 显示推断标记 |

---

## 8. 明确不做的事

- 不做任何注入/劫持 agent 的机制(不改 PATH、不包 shim、不 attach debugger、不读 agent 的凭据文件——现有原则保留);
- 不做 prompt 代发、审批代答、模型代切——写回路径全部物理删除,而非特性开关;
- 不改变用户对 agent 软件的使用方式——Absence 的接入动作只有"打开看板"与"把 ACP 客户端指向代理地址"(后者可选)。
