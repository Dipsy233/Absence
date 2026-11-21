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

**已知遗留:** 转录存活期间重启服务器会为同一外部会话产生新归档行(身份幂等只在内存;正解 = Phase 5 schema v5 的 channel/external_id 列 + re-attach,迁移只做一次);超大转录(>200MB)从尾部开始观察(诚实降级)。

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

## 5. 后续阶段(摘要)

### 本轮续作：Phase 2 部分落地

- 新增 `process/ProcessScanner.ts`：pi 入口签名 + 绝对 `--session` 转录路径唯一匹配；不凭 cwd 猜 PID，歧义不绑定。
- `ProcessWatcher.reachesAttributed`、外部树四秒轮询 → 既有 Eggs / 指标目标；观察会话声明身份，未绑定时不采样服务器，精度标为 sampled。
- 近期转录命令打开/关闭监控窗口，旧回填不归因当前活动。
- **用户新增决定：Windows 不做 Docker 容器捕获**（强制关闭，不能用环境变量开启；移除 WSL Docker 探测）。非 Windows 保留；转录命令事实照常展示。
- 新增 `check:agentwatch-external`，注册 offline；三包 typecheck、offline 35/35、observe-transcript 29/29 已通过（Windows Docker 门禁追加后另跑专项）。
- Phase 2 未完：默认 `pi` 无显式 session 参数的可靠关联、共享扫描/节流、非 Windows Docker 归因。当前扫描按观察会话运行，尚非共享扫描器。


- **Phase 2** 归因重做:`reachesOwned` → `reachesAttributed`(签名识别 + pid 祖先链),指标/eggs/Docker 扩展到非 owned 进程
- **Phase 3** proxy 升级:持久化、Web 可 attach、注入 `ABSENCE_SESSION_ID`;**此时定 schema v5 的 channel/external_id**
- **Phase 4** 交互面拆除:删 prompt/abort/approval/command 四端点 + drive-mode 残骸;Picker → Observatory(用 `GET /api/observe/sessions` + `POST /api/observe/attach`);chat → 只读 Transcript
- **Phase 5** schema v5 迁移 + 自动归档(静默阈值)+ re-attach(修重启重复)+ 双语文档

## 6. 踩坑记录

1. `drain()` 数组别名(`const events = this.out; this.out.length = 0` 清空的是返回值)→ 拷贝后清
2. harness `waitFor` 只收同步谓词,async 恒真 → 本地 `waitForAsync`
3. **事件丢弃 bug(已修)**:未挂载就 drain = 解析结果静默丢失;attach 必须"全新解析器 + 从字节 0 回填",未挂载时只解析到身份即停
4. Windows `kill` npx 包装不杀 tsx 子进程 → 游离服务器干扰检查;测后 `netstat` 查残留
5. chokidar watch 主目录撞 junction(EPERM)→ `watchProject` 门
6. fixture 字段层级要对齐真实格式(pi 的 usage 在 `message.usage`)
7. **急切挂载 hazard(已修)**:历史转录全量建会话 = 343 个 FileWatcher;三态模型 + 活跃度门解决
