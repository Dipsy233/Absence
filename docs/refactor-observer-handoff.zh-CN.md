# Absence 旁观化重构 — 开发交接文档(re 分支)

> 读者:接手开发的 AI/工程师。本文自包含,反映**最终实现态**(含 pi-only 修订)。
> 战略全文见 `docs/refactor-observer.zh-CN.md`;本文是可执行子集 + 已实现记录。

---

## 0. 一句话背景

Absence 已从"驾驶位 + 行车记录仪"重构为**纯旁观监控看板**:用户在终端原生使用 pi(以及其他 agent 软件,习惯零改变),Absence 作为第三方只读监听,保留全部现有监控能力(Stage/Activity/Agent Folder/Eggs/指标/Docker/Report/历史/回放/三 face/Drip)。**分支 `re`,全部改动未提交。**

## 1. 已定决策(不再重议)

| # | 决策 |
|---|---|
| D1 | 纯旁观:不启动、不驱动、不应答任何 agent;写回路径(prompt/abort/approval/命令)物理拒绝 |
| D2 | 三个现役模块:pi 转录监听 + ACP proxy(既有,主战略:让标准协议吸收成本)+ OS 旁观(进程/文件/容器/指标)。全部只读,喂同一条事件管线 |
| D3 | **转录只做 pi**——唯一承诺的私有格式耦合(开源可审计)。claude-code/codex 解析器与源声明**已移除**。**不做任何通道预留**:解耦 = `AbsenceEvent`/`MonitorEvent` 契约 + source 注册(`observe/transcriptSources.ts`);未来换/加监听 = 新模块实现 `feed/drain → AbsenceEvent` 接缝后注册,其余代码不动 |
| D4 | 随开随关 + 回填:attach 从转录第 0 行回填;detach = 关 UI 继续监控;关服务器 = 转录是事实源 |
| D5 | **列表展示一切,挂载克制的三态模型**:unknown(只解析 header 身份)/ attached(增量尾随)/ missing;自动挂载仅限 10 分钟内活跃的转录(`AUTO_ATTACH_WINDOW_MS`);历史会话由用户经 `POST /api/observe/attach {file}` 显式挂载(完整回填) |
| D6 | launcher(从 Absence 启动终端跑 agent)仅作可选入口,Phase 5 后评估,不是主路径 |

## 2. 当前实现(全部完成、已验证、未提交)

**新增 `apps/server/src/observe/`:**

| 文件 | 职责 |
|---|---|
| `types.ts` | `ObserveMeta { channel:"transcript", externalId, transcriptFile?, watchProject? }`;watchProject=false(主目录/盘根 cwd)不建树不 watch |
| `transcriptSources.ts` | **pi 单源** profile;根目录解析:`ABSENCE_OBSERVE_PI_ROOT`(测试)> `PI_CODING_AGENT_SESSION_DIR` > `PI_CODING_AGENT_DIR`+`/sessions` > 默认 `~/.pi/agent/sessions` |
| `parsers/pi.ts` | pi 会话转录 → AbsenceEvent。格式真源:docs.pi.dev/latest/session-format.md + 开源源码 + 真机 42k assistant 记录核实 |
| `ObserveAdapter.ts` | no-op 适配器(事件注入点);`prompt()` 抛错、`abort()` 空操作 |
| `Discovery.ts` | 三态模型(见 D5):header-only 解析 → 挂载 = 全新解析器从字节 0 回填 → 增量尾随(字节偏移 + `lastIndexOf(0x0a)` 完整行定界);`POST /api/observe/attach` 对应 `Discovery.attach(file)` |

**改造:** core `events.ts`(+`"transcript"` source)与 `api.ts`(ObserveSessionRow/ObserveSourceRow/ObserveDiscoveryResponse,已瘦身无预留字段);`SessionStore.createObserved` + `AbsenceSession` observe 模式(`ingestObservation` → 既有管线);`api/observe.ts`(GET sessions + POST attach,只读);`config.observeEnabled`(`ABSENCE_OBSERVE=0` 关);index 装配;9 个起服务器的 check 已加 `ABSENCE_OBSERVE=0` 隔离。

**验证:** typecheck 三包全绿;`check:observe-transcript` **29/29**(pi fixture:发现/回填/工具生命周期/file_write/usage/中途追加/拒绝驱动/幂等);`check:offline` 全量 34 组全绿;真机冒烟:343 条真实 pi 会话列出、0 误自动挂载(pi 未运行)、手动 attach 完整回填(36/14 真实历史事件)。

**已知遗留:** 转录存活期间重启服务器会为同一外部会话产生新归档行(身份幂等只在内存;正解 = Phase 5 schema v5 的 channel/external_id 列 + re-attach,迁移只做一次;续采位置见 Phase 6);超大转录(>200MB)从尾部开始观察(诚实降级)。

## 3. pi 格式速查(解析器依据,全部真机核实)

- 条目基座:`type` / `id`(8 位 hex) / `parentId`(树)/ `timestamp`(ISO);**message 内层 timestamp 是 Unix 毫秒**
- `session` 头:`version/id/timestamp/cwd` ← externalId 与 cwd 来源
- `message.message` 角色:`user`(content 为 text 块列表)/ `assistant`(content 块数组 + `api/provider/model/usage/stopReason/durationMs?/errorMessage?`)/ `toolResult`(**独立消息记录**:`toolCallId/toolName/content/isError/durationMs?`)/ `system`(prompt/工具补丁,跳过)
- assistant 块:`{type:"text",text}` / `{type:"thinking",thinking}` / `{type:"toolCall",id,name,arguments}` / `{type:"image"}`
- **stopReason 枚举(真机 42174 条核实)**:`stop`(回合正常结束)/ `toolUse`(继续)/ `error`(errorMessage 常随)/ `aborted` / `length`
- 工具参数(真机核实):`bash/pwsh {command,timeout?}`;`read {path,offset?,limit?}`;`write {path,content}`;`edit {path,edits:[{oldText,newText}]}`;`mcp__<server>__<tool>`(ToolRules 自动识别);`bg_start/bg_send/bg_logs/interactive_shell/codemode` → execute 类
- toolResult `details`(选择性):edit 带 `{diff,firstChangedLine,patch}`;read 带 `{bytes,...}`;mcp 带 `{server,tool}`
- `model_change{provider,modelId}` = 显式模型切换;`compaction{summary}` / `branch_summary{summary}` → 系统消息;`usage` 条目(会话外记账)与 `context_edit`(改写模型视角,不改历史)跳过
- **映射**:user→message user(开 run);thinking→thinking;text→message assistant;toolCall→tool_start;toolResult→tool_end + `AcpToolMapper.mapCompletedDetailed`(write/edit 由解析器直映射 file_write/file_edit 防双报);stopReason≠toolUse→agent_end + usage(outputEst=Σoutput,contextUsed=max(input+cacheRead+cacheWrite));全部 `source:"transcript"`
- 树语义 v1:按文件顺序(用户实际经历序)扁平处理,不回放分支;注释已声明取舍

## 4. 工程铁律

1. 写回路径一律拒绝(新增交互面先过 `observe` 守卫)
2. provenance 不编造:未知 = `"unknown"`;缺字段 = 缺事实
3. 降级契约:未知条目跳过、malformed/orphanResults 计数;单家降级不炸会话
4. 主目录/盘根不 watch(`watchProject` 门)
5. 事件顺序 = 记录顺序(assistant 文本先于同记录 toolCall)
6. 测试隔离:spawn 真实服务器的测试一律 `ABSENCE_OBSERVE=0` + 独立 `ABSENCE_STATE_DIR`
7. Absence 不碰 agent:不注入/shim/改 PATH/读凭据

### Phase 3:proxy 会话持久化(已完成)

- `ProxySessions.useSessionStore(store)`(index.ts 在 `ABSENCE_OBSERVE=1` 时注入):每个 proxy 会话经 `createObserved` 落地为 `channel: "acp-proxy"` 的观察会话——tap 投影事实 → `ingestObservation` → 既有管线(SQLite / run index / WS)。
- spawn 注入 `ABSENCE_SESSION_ID`(值 = absence 会话 id)→ Windows Job 观察者精确归因;agent pid 经 `AbsenceSession.declareRuntimePid` 声明;`processPrecision` 对 acp-proxy 会话标 exact。attach 失败降级为透明代理(诊断记录),不挡客户端。
- tap 增补:`session/prompt` 请求投影为 user message(run 边界);turn 缓冲移入 `AcpMonitorProjector`(`beginTurn`/`finalizeTurn`,活动边界断句与 driven adapter 同语义),agent 的 prompt **应答**关闭回合(final message + agent_end,不编造 usage)。
- **修了两个真 bug**:① `createStreamTransport` 在 listener 挂上前丢弃到达的行(本地回环/stdio 竞速会吃掉 initialize)——先缓冲,首个订阅者后微任务重放;② `FileWatcher` 主/外圈 watcher 无 error 处理,junction EPERM 直接炸进程——按既有降级契约吞掉。
- `ObserveMeta.channel` 扩为 `"transcript" | "acp-proxy"`;`isNarrowScope` 移入 observe/types 共享;`ProxySessionInfo.sessionId` 供 Web 关联。
- `check:observe-proxy`(15 断言:身份幂等/env 标记/事件落库/来源标记/run 边界/拒绝驱动/归档脱离 proxy 生命周期);新增 `observe` check 组(并补注册了此前漏组的 check-observe-transcript)。offline 37/37、acp 88/88、acp-proxy 30/30 全绿。

## 5. 后续阶段(摘要)

### 本轮续作:Phase 2 完成

- 新增 `process/ProcessScanner.ts`:pi 入口签名 + 绝对 `--session` 转录路径唯一匹配;不凭 cwd 猜 PID,歧义不绑定。
- 新增 `process/ExternalScanner.ts`:**共享扫描器**——全机快照每 4s 一次,分发给所有观察会话(此前每会话各扫一遍);绑定证据分两级:`--session` 显式命令行 > 默认 pi 的 1:1 新配对(新进程 × 新转录,时间窗 5 分钟,歧义不绑定,`pairDefaultSessions` 纯函数钉在检查里)。
- `ProcessWatcher` 外部模式拆出 `applyExternalScan(root, rows)`:私有 4s 轮询(checks/单机用)与共享扫描共用同一条归因路径;`SessionStore` 给观察会话注入共享扫描器。
- `ProcessWatcher.reachesAttributed`、外部树四秒轮询 → 既有 Eggs / 指标目标;观察会话声明身份,未绑定时不采样服务器,精度标为 sampled。
- 近期转录命令打开/关闭监控窗口,旧回填不归因当前活动。
- Docker 归因(非 Windows):转录命令窗口经 `ingestObservation` → `commandContexts` → `DockerEggs.attribute` 全链已通,`check:agentwatch-external` 用 ContainerEvent 直接钉住(预测匹配才下蛋,窗口内不匹配拒绝;无需 docker daemon)。
- **用户新增决定:Windows 不做 Docker 容器捕获**(强制关闭,不能用环境变量开启;移除 WSL Docker 探测)。非 Windows 保留;转录命令事实照常展示。
- `check:agentwatch-external` 四节:显式归因、默认 pi 配对、共享扫描器、观察会话 Docker 归因;三包 typecheck、offline 35/35、observe-transcript 29/29 通过。

### Phase 3:proxy 会话持久化(已完成,c8b4c48)

- `ProxySessions.useSessionStore(store)`(index.ts 在 `ABSENCE_OBSERVE=1` 时注入):每个 proxy 会话经 `createObserved` 落地为 `channel: "acp-proxy"` 的观察会话——tap 投影事实 → `ingestObservation` → 既有管线(SQLite / run index / WS);`ProxySessionInfo.sessionId` 供 Web 关联。
- spawn 注入 `ABSENCE_SESSION_ID`(值 = absence 会话 id)→ Windows Job 观察者精确归因;`AbsenceSession.declareRuntimePid` 补全归因对;`processPrecision` 对 acp-proxy 会话标 exact。attach 失败降级为透明代理(诊断记录),不挡客户端。
- tap 增补:`session/prompt` 请求投影为 user message(run 边界);turn 缓冲移入 `AcpMonitorProjector`(`beginTurn`/`finalizeTurn`,活动边界断句与 driven adapter 同语义),agent 的 prompt **应答**关闭回合(final message + agent_end,不编造 usage)。
- **修了两个真 bug**:① `createStreamTransport` 在 listener 挂上前丢弃到达的行(本地回环/stdio 竞速吃掉 initialize)——先缓冲,首个订阅者后微任务重放;② `FileWatcher` 主/外圈 watcher 无 error 处理,junction EPERM 直接炸进程——按降级契约吞掉。
- `ObserveMeta.channel` 扩为 `"transcript" | "acp-proxy"`;`isNarrowScope` 移入 observe/types;新增 `observe` check 组(补注册此前漏组的 observe-transcript)。`check:observe-proxy` 15 断言。

### Phase 4:交互面拆除(已完成,75cb625 + 00ec65c)

- **Web(75cb625)**:Observatory 观测台替换 ProjectPicker(转录挂载 / 代理列表 / 历史;`AcpProxySessionRow` core 契约);删除全部驱动 UI——chat 输入与 `/` 面板、四个 face 的 chat bar、Drip 表单与 Stop、ApprovalStage 应答(只读权限卡)、Stage/文件面板全部 "+ Chat"、sessionStore 的 sendPrompt/runCommand/respondApproval/abort 与 stop 机制;新增 `openSession(id)`。
- **服务端(00ec65c)**:驱动栈整体删除(AcpAdapter / AcpConnection / AcpSession / AcpPermissionBridge / AcpAuth / AcpConfigOptions / AgentCatalog / profiles / api/runtimes / api/agents + 四个驱动检查);`createAdapter` 只剩 mock fixture;其他 kind 一律 `ObserveAdapter`,带 resume 的 POST 重开归档(回放 + 目录树 + watcher),不 respawn;无 resume 的 POST 只许 mock。prompt/abort/approval/command 对非 fixture 会话 403(路由仅为 mock 检查保留,最终删除与 mock 检查改写绑定)。
- 遗留:`scripts/mock-agent`(14 场景经 profile 驱动,已从 check:acp-all 摘除)需改写为 proxy 流(其 agent.mjs 是协议级 fixture,可复用);check:e2e 用 mock fixture 仍绿。

### Phase 5:schema v5 + re-attach + 自动归档(已完成,fcee2ad)

- v5:`sessions.channel/external_id`(索引;runtime 即 agent kind)+ `runs.boundary_source`(预埋列);`ArchiveMeta` 携带身份;legacy 导入与 flush upsert 同步写新列。
- **re-attach**:`createObserved` 先按 (channel, external_id) 查归档——重启后同一外部会话复用原 absence id、回放历史作为开场事实,不再每次重启新增归档行(Phase 1 已知代价已修);check-observe-transcript 31/31 钉住。
- **自动归档**:`config.archiveSilenceMs`(`ABSENCE_ARCHIVE_SILENCE_MS`,默认 30 分钟,0 关)——分钟级清扫归档"无 viewer + 无新事实"的观察会话(dispose 不删除;归档留在 History,按需 re-attach);mock fixture 与有 viewer 的会话永不触碰;ws 连接 attach/detach viewer。
- 剩余小项:双语文档已更新(本文件 + architecture 双语);CHANGELOG;gemini/qwen/dsh 转录源未做(接口缝已在,注册即用);"辅助启动"入口未做(可选,Phase 5 后评估)。

### Phase 6:监控目标选择 + 断点续采(已完成)

- 默认不再按近期转录自动挂载:发现只列目标,`POST /api/observe/watch`(或 CLI `absence observe`)才建会话并记租约。`ABSENCE_AUTO_ATTACH=1` 恢复旧行为。检查用 `check-observe-board` 钉住"仅发现不监控"。
- 回填分块流式交付,不再把整文件读成一个 Buffer;分块边界可跨单条 JSON 记录;并发 attach 复用同一会话;回填期间追加的记录在收尾时补读一次,不丢不重。
- 中途挂载的 run 边界:`runs.ts` 仅对 transcript 源、且首个 run 才允许无用户消息开 run(`boundarySource: "attach"` + `truncatedBefore`),后续仍以真实用户消息分界;`markAttachSession` 由 `SessionStore` 按 channel 注册(此前漏注册,检查恒失败)。
- **停服续采**:schema v7 `transcript_checkpoints(session_id, byte_offset, digest)` 与事件同事务写入;重启 re-attach 时校验前缀 SHA-256,一致则只从断点交付(历史不重复、停服期间追加补上);前缀改写/截断时停止合并在观测台标 `transcriptResumeBlocked`,由用户重新监控。`check-observe-watch` 21 断言覆盖。
- 空闲归档跳过回填中的会话;`isBackfilling` 同时反映在会话与发现行上。

## 6. 踩坑记录

1. `drain()` 数组别名(`const events = this.out; this.out.length = 0` 清空的是返回值)→ 拷贝后清
2. harness `waitFor` 只收同步谓词,async 恒真 → 本地 `waitForAsync`
3. **事件丢弃 bug(已修)**:未挂载就 drain = 解析结果静默丢失;attach 必须"全新解析器 + 从字节 0 回填",未挂载时只解析到身份即停
4. Windows `kill` npx 包装不杀 tsx 子进程 → 游离服务器干扰检查;测后 `netstat` 查残留
5. chokidar watch 主目录撞 junction(EPERM)→ `watchProject` 门
6. fixture 字段层级要对齐真实格式(pi 的 usage 在 `message.usage`)
7. **急切挂载 hazard(已修)**:历史转录全量建会话 = 343 个 FileWatcher;三态模型 + 活跃度门解决
