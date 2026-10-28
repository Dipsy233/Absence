# 测试与检查

Absence 没有单元测试框架；它带一组**验收检查脚本**（`scripts/checks/`），每个都是独立的
harness，钉住那些容易悄悄弄错的规则。架构背景见 [ARCHITECTURE.zh-CN.md](ARCHITECTURE.zh-CN.md)。

为什么不用 vitest/jest：Absence 里难的不是纯函数，而是**观察一个真实操作系统**——
一条命令下了哪个进程、容器有没有变成蛋、曲线能不能跨重启活下来。这些东西一 mock
就测掉了最值得测的部分。所以检查按**需要什么环境**分层，最上面两层只能手动跑。

```
第 4 层  全链路    check-e2e —— 自己起 server + mock 会话
第 3 层  真实 IO   真 WebSocket / SQLite / 内核观察器 / docker
第 2 层  隔离 IO   在临时目录里跑，绝不碰用户档案
第 1 层  纯函数    假进程表、假事件数组，不 spawn 任何东西
```

CI 跑**第 1–3 层**（`npm run check:offline`）：第 3 层的检查自己起 server，不需要
任何东西预先在跑。只有第 4 层——需要内核权限、docker 或真实运行时——保持手动。

## 门禁

```bash
node scripts/make-demo.mjs [dir] [--force]   # 搭一个 demo 项目（默认 ./absence-demo）
npm run check:offline                        # 一次跑完全部离线检查（CI 跑的就是这个）
npm run verify                               # 类型检查 + Web 构建 + 全部离线检查
```

`npm run verify` 是提交前的完整门禁。单个检查永远是一条命令：

```bash
npx tsx scripts/checks/check-<name>.ts
```

### 第 1 层 —— 纯函数（无 server、不 spawn、不需凭据）

```bash
npm run check:eggs             # 进程检测：命令窗口、祖先链、标记、孤儿
npm run check:classify         # 命令意图 + primary/tool 切分
npm run check:report           # Absence Report 引擎 + 环路/关注度规则
npm run check:markdown         # 对话的 Markdown 解析器
npm run check:fsdiff           # 文件 diff 引擎
npm run check:codex            # Codex 命令解析 + 审批决策
npm run check:codexshell       # 去掉 Codex 的 shell 外壳
npm run check:shellenv         # Codex env_policy → 命令环境
npm run check:chimes           # 关注度变化什么时候该响
npm run check:settings         # settings store 的加载/归一化规则
npm run check:observer         # 解耦契约（observe 与 drive 的区别）
npm run check:capabilities     # skills + MCP 发现，以及 Pi 自己的 loader
npm run check:capability-commands  # /skill 与 /mcp 聊天命令
npm run check:mcp              # 一次 MCP 调用能到达 Activity 和 Stage 上
npx tsx scripts/checks/check-outside-attr.ts  # agent 外部改动归因
```

### 第 2 层 —— 隔离 IO（在临时目录里读写 SQLite / 文件系统）

```bash
npm run check:storage          # SQLite 会话存储：导入、读写回环、过滤
npm run check:metrics          # 指标 chunk、重采样、退出蛋的规则
npm run check:metrics-persist  # 蛋与整机序列能从 SQLite 读回
npm run check:metrics-ranges   # 看板每个时间范围是它自己的窗口
npm run check:incremental      # 增量折叠 == 完整重建
npm run check:execserver       # Codex exec-server，真实 loopback WebSocket
```

### 第 3 层 —— 自起 server（仍然无人值守）

```bash
npm run check:history          # Web 客户端的 History/Replay 对着真会话
npm run check:lifecycle        # `absence serve` 的孤儿/端口生命周期
npm run check:session-dwell    # 会话时长是停留时间
npm run check:session-close    # “切换项目”是离开会话
npm run check:metrics-restart  # 曲线跨服务器重启存活
npm run check:observed-lifetime  # “观察时长”是进程自身生命周期
```

每一个都在临时端口上用隔离的 `ABSENCE_STATE_DIR` 起自己的 server，并在
`finally` 里杀掉，所以事前不需要任何东西在跑，也绝不碰用户档案。
`check-history` 另外认 `ABSENCE_PORT`，可以指向你已经开着的 server。

在**没有内核观察器二进制**的机器上，watcher 会退回 `ps` / PowerShell 快照，
所以这些检查在普通 CI runner 上照样通过——这正是它们的用途：那些会悄悄腐烂的
会话与指标行为。

### 第 4 层 —— 手动（需要内核、docker 或真实运行时）

```bash
npx tsx scripts/checks/check-agentwatch.ts     # 内核进程观察器（Windows）
npx tsx scripts/checks/check-ebpf.ts           # 内核进程观察器（Linux）
npx tsx scripts/checks/check-docker.ts         # docker 命令的进程边界
npx tsx scripts/checks/check-docker-eggs.ts    # 容器蛋：归因 + stats + 恢复
npx tsx scripts/checks/check-e2e.ts            # 全链路，含容器蛋
```

只有这 5 个留在 CI 之外，理由很实在：它们需要带内核权限的 `agentwatch`
二进制、一个 docker daemon，或两者都要。`check-e2e` 放这里，是因为它的容器
断言才是重点——没有 docker 时它只能证明纯进程那一半。

其他：

```bash
npm run check:process          # 全部进程相关 harness 一起跑（observer 检查在非本平台自跳）
npm run bench:incremental      # 计时报告，不是检查：不做任何断言
node scripts/gen-whalebun-css.mjs            # 重新生成头像样式表
```

`bench:incremental` 放在 `scripts/dev/` 而不是 `scripts/checks/`：它打印
ms/event 和提速倍数，但永远不会失败，而一个**不可能变红**的检查不是检查。
它的正确性对照是 `check-incremental.ts`，那个才真的断言增量折叠与完整重建一致。

## 一个检查怎么写

第 1、2 层的检查都共享 `scripts/checks/harness.ts`：

```ts
check(label, condition, detail?)   // 打印 "ok" 或 "FAIL <label> — <detail>" 并计数
section(title)                     // 分组之间的可读标题
waitFor(predicate, timeoutMs?)     // 带 deadline 的轮询，给异步检查用
finish(name?)                      // 打印 "N/M passed"，失败时以非零码退出
```

`finish()` **拒绝**让一个什么都没断言的运行通过——import 写错、或者函数体被
某个 guard 跳过，都会报 `0/0` 并原本绿着通过，这是检查工具唯一不能有的失败模式。
这也是为什么不用 harness 的那几个（`check-history.ts` 和用
`node:assert/strict` 的）必须被拉齐：`check-history.ts` 现在自己数断言、
零断言即失败，而 metrics 系列已改成 `check()`，失败输出与其它检查一致。

三个习惯让失败可读：

- **标签就是产品规则，用大白话写**——`"the shell Absence drove is not an egg"`，
  而不是 `assertEquals(claimed.length, 2)`。红了一行就知道哪条规则破了。
- **`detail` 带上实际值**——`\`got ${primary.length}\``——失败时能看见发生了什么，
  而不只是“挂了”。
- **每块上面注释写明它在钉哪个 bug。** 大多数检查当初都是一次真实回归；
  `check-chimes.ts` 说得最直白：*“every branch below was a bug once — a step into
  low rang when it should have been silent”*。

需要真实数据库的检查必须在 **import 之前**设好自己的 state 目录，所以它用动态
`import()`：

```ts
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "absence-metrics-"));
process.env.ABSENCE_STATE_DIR = stateDir;      // 必须先于 import
const { appendMetricsFrame } = await import(".../storage/metrics");
```

### 新增一个检查

写 `scripts/checks/check-<name>.ts` 并用 harness，把它连同超时加进
`scripts/checks/run-offline.ts` 里的 `CHECKS` 数组，值得手敲的话再加一个
`npm run` 别名。CI 要跑它不需要改 `package.json` 别名、也不需要改 workflow——
清单只存在于一处，而每个条目自带超时，因为自起 server 的检查要真的睡过采样窗口。

CI workflow（`.github/workflows/ci.yml`）在每次 push / PR 上跑 workspace 类型检查
和 `npm run check:offline`，Node 版本为 22，与 `engines.node` 一致。那是 27 个
脚本、约 3 分钟，其中 5 个会起真 server；四个内核/docker 检查保持手动。

一个检查能不能进这个清单，看它是不是**只依赖 Node**：不需要观察器二进制、不需要
docker、不需要提权、不需要别人先起好的 server。自己起一个临时端口上的 server
不算违规——那是这里最常见的形态，会话与指标的价值正在那儿。

## 每个检查钉住什么

`make-demo.mjs` 写一个小项目，形状让普通 prompt 练到每个面板：带行区间的读、
能跑的 `npm test`、给 agent 读的 `TODO.md`、以及留给删除 vs 截断情形的
`notes.txt`。mock 运行时真的跑它的 shell 命令，所以一次 mock 运行也会下一只
蛋——这就是没有 Pi 凭据也能练 Agent Eggs 面板的方法。

### 管道与会话

`check-e2e.ts` 是“我这次改动有没有搞坏整条管道”的快速答案：一条命令，约 30 秒，
不需要模型。它是手动的、不在 CI 里：容器断言需要 docker daemon 和内核观察器，
没有它们时它只能证明纯进程那一半。它在临时端口上用隔离 state 目录起一个真 server，开一个 **mock** 会话，
用脚本化 prompt 驱动它（`$ ` 开头的行——`MockAdapter` 把每行都过一遍真 agent
用的同一个 `AbsenceShell`）。然后断言整条链：command 事件 → 进程蛋（Job Object）
→ 容器蛋（docker events，docker 可达时）→ metrics 帧 → SQLite 持久化。没有
docker 时它退回一只普通 `node` 进程蛋，并在输出里说明。

`check-history.ts` 自己起 server，对一个真 mock 会话跑 **75 项断言**：分页事件 API 及其游标、
运行索引、运行分组、每运行的 Activity 范围、确定的 stage 项 id（曾经用随机 id
导致 replay 的 Stage 冻住）、快照 seek、Stage 回到默认页、搜索→终端映射、
thinking 捕获（一条流式念头保持为一个 Stage 项，所以 replay 不会重新挂载它）、
两个独立的 FILE 槽位、读累积与缺口标记、逐版本记录、新建文件计数。

`check-lifecycle.ts` 钉住一次真实事故：父进程 npm 死掉后被孤立的 dev server
继续卡着跑——在监听、0% CPU、不回应任何请求——并且占着 8848 端口直到被人手动
杀掉。server 必须发现上方没人了并自行离开：stdin EOF 让它退出（这是“父进程没了”
最便宜的信号），死掉的父 pid 被存活看门狗发现（这里通过 `ABSENCE_ORPHAN_TICK_MS`
加速），以及端口被占时第二个 server 给出带说明的失败，而不是裸的 `EADDRINUSE` 栈。

`check-execserver.ts` 在 loopback WebSocket 上驱动真实的 Codex exec-server：
`initialize`，随后 `process/start`/`output`/`exited`/`closed`，一条 `tty: true`
命令在 `pty` 流上输出并在写入 Ctrl+C 时停止，以及 `process/signal interrupt`
第一手停掉一条运行中的命令。

### 指标与会话

`check-metrics.ts` 验证指标 chunk 的读写、不同步长重采样、session 平均值，
以及 egg 退出后不再延长生命周期或继续累计资源。

`check-metrics-persist.ts` 验证看板的历史路径：蛋与整机自身的 counter（图表里的
整机虚线）都能从 SQLite 读回，没有采样点的窗口返回空点（图上留空），且走的是 UI
实际调用的同一个接口。它**不启动 server**——在同一个进程里 append、flush、读回，
所以它是离线检查，而下面那个「重启」的情形不是。

`check-metrics-restart.ts`（约 20 秒）起一个真 server、跑一段负载、
**重启服务器**、再读同一个 session——曲线与整机虚线必须还在。这是
`check-metrics-persist.ts` 到不了的那个情形。

`check-metrics-ranges.ts` 直接导入看板的 `RANGES` / `rangeStart`（而不是复制
一份），钉住：在**很年轻的会话**上 30m、1h、`all` 各自是自己的窗口——这正是它们
曾全部塌成 1m 那几秒的场景；窗口在一个 step 内稳定，跨 step 才移动。

`check-session-close.ts`（约 25 秒）把“切换项目”钉成**离开**会话：
`POST /api/sessions/:id/close` 之后采样点数量不再增长（飞行中的那一次采样直接
丢弃、不落盘），已记录的采样点保留，重开 session 能恢复它们。

`check-session-dwell.ts`（约 19 秒）把会话时长钉成**停留**时间：
打开 → 停留 → 离开 → 再回来，计时接着走；关闭期间的空档不计入；原始创建时间不变。

`check-observed-lifetime.ts`（约 19 秒）把“当前观察时长”钉成进程自身的
生命周期：蛋的计时从 `startedAt` 开始、到 `exitedAt` 停止，且进程结束后记录的
时长不再增长。

`check-incremental.ts` 验证事件滑动窗口下 eggs、History 和 Activity 的增量
折叠与完整重建一致，并钉住每事件成本不会退化成窗口大小的乘积。
`scripts/dev/bench-incremental.ts`（`npm run bench:incremental`）是它的计时对照：
打印新旧 ms/event 与提速倍数，不做任何断言，因此不在 `scripts/checks/` 里
——一个不可能变红的检查不是检查。

`check-storage.ts` 钉住 server 其余部分依赖的 SQLite 缝隙：旧的 JSONL 档案只导入
一次且流式前缀被丢掉，`readEvents` 重建完整的 `AbsenceEvent` 信封而不只是 payload，
新写入能读写回环且批次在 drain 时刷盘，`listArchives` 按项目路径过滤，重复运行
导入器不会产生重复事件。

### 进程与容器

`check-eggs.ts` 是进程检测的纯 harness（无 server，不 spawn 任何东西）：
命令窗口决定谁是候选，祖先链决定谁是我们的，Absence 放在自己 shell 上的标记
决定什么是管道，孤儿被拒绝而不是猜测，子树折叠到根并数出后代，eggs 面板把
重复的 pid 折成一个 egg，带 `running` / `dead` / `all` 过滤。技巧在于它把
**伪造的进程表**喂给真实的 `candidatePids` / `attributeProcesses` / `buildEggs`
——所以有风险的归因逻辑能在毫秒级被验证。

`check-classify.ts` 是 primary/tool 切分的纯 harness：命令的主体从文本读出
（`./daemon.sh`、`python train.py`、`powershell -File run.ps1`），内联解释器
仍是 tool，带重定向的查询工具不是主体，分类是结构性的——活得比命令久的
`cat` 是 primary，短命的 git-bash 帮手是 tool，工作区内的进程是 primary，
来自未知目录的 ephemeral 进程（Pi 自己 bin 里的 `fd.exe`）是 tool。

`check-agentwatch.ts` 真刀真枪地练 Windows 观察器：对着测试进程启动 helper，
驱动真实的 `ProcessWatcher`，断言短命的孩子全被抓到、带命令行、归属到培育它
的命令，而且 Absence 自己带标记的 shell 永远不是 egg。

`check-ebpf.ts` 对 Linux 观察器做同样的事：启动 `agentwatch-linux`，驱动真实
的 `ProcessWatcher`，断言短命的孩子全被抓到、带命令行、归属到培育它们的
命令——并且设了 session id 时无标记的进程仍被捕获（Linux 归因规则）。

`check-docker.ts` 钉住 docker 命令的进程边界（Windows + WSL docker）：Job Object /
eBPF 观察器在 `docker run` 周围看到什么，从而客户端与容器不会被搞混。

`check-docker-eggs.ts` 端到端钉住容器蛋：容器 start 事件只被归因到**自己的话
预测出它**的那条命令（`--name`、镜像、compose 项目标签），同一时间窗内落地的
外来容器不被归因，stats 成为该容器的指标，恢复的会话会重新挂上它下过且仍在跑的
容器，而已经退出/被删的按守护进程自己的状态纠正。

### 报告、规则与聊天面

`check-report.ts` 是 Absence Report 引擎的纯 harness（无 server）：没有
`command` 事件的失败工具仍计为一次失败命令，recovery 只在中间还有活动时消费
一次失败，agent 的写入从不同时被计成观察到的改动，`created` 相对更早的运行，
phase 在 recovery 之后落到 `verifying`，Timeline 按事件顺序每个活动一个节点
带它的效果（一条流式念头保持一个节点，没结束的 shell 工具读成在跑的进程，
运行期间下的蛋成为 `LAID` 节点——还活着的蛋把关注抬到 high）。它还钉住了环路
规则：把读状态写回去是一次 `file_version_loop`、关注 medium，带缺口的读状态
永远不是环路基准，失败两次的同一条命令是一次带命令文本的 `command_retry_loop`，
失败一次不算环路，项目外的改动是一次 `outside_change`、低级关注、Timeline 上
标 `OUTSIDE`，而还在跑的蛋（high）压过项目外改动（low）。有 `FindingRecord`
的已结束运行会重放记录而不是重新判定，记录的哈希链能通过验证，而被篡改的记录
会断链。

`check-outside-attr.ts` 验证只有写语义工具能归因外部改动，路径字段不会把
文件内容里的路径误报为改动，且 Windows 路径大小写/分隔符保持一致。

`check-chimes.ts` 在没有 `AudioContext` 的情况下钉住 `attentionChimeFor`
——关注度变化该不该响的全部策略。下面每个分支当初都是一个 bug：该静音的
进入 `low` 却响了，或者离开 `high` 时连带静了音。

`check-settings.ts` 钉住过期或残缺的 `localStorage` 条目会加载成一个完整、合理的
Settings：默认值补齐、未知值被归一化、两侧栏顺序与聊天开关保持合法形状。它 stub
了一个最小 `localStorage`，好让 store 模块在浏览器外也能在 import 期读到它。

`check-markdown.ts` 是 Chat 面板 Markdown 解析器的纯 harness：智能体真正常写的
块级与行内结构（标题、嵌套列表、任务列表、表格、围栏代码）都能解析，而写了一半
的结构——未闭合的围栏、`**`、`[`——会退化成文本，而不是吞掉流式回复的剩余部分。
它也钉住那些**不该**变成标记的东西：算式（`2 * 3 * 4`）、`snake_case`、原始 HTML、
`javascript:` 链接都保持字面量——这正是渲染这棵树无需 HTML 消毒器的原因。

### 运行时：Codex、能力发现、解耦

`check-codex.ts` 是 Codex 命令层的纯 harness：从 Codex 自己的 `commandActions`
读出 read/search/list（带文本回退），以及从 `availableDecisions` 推导的审批决策
与选项。

`check-codexshell.ts` 钉住去掉 Codex shell 外壳的规则：`pwsh -Command "…"`
（带 UTF-8 前导）、`bash -lc "…"`、`cmd /c …`、多 flag 形式和带引号的 exe 路径
都归约为模型写的命令；非 shell 调用原样保留。

`check-shellenv.ts` 钉住环境构建：Codex 的 `env_policy`
（inherit / 默认排除 / 自定义排除 / set / include-only）作用于 executor 自身
环境，再让请求的稀疏 `env` 覆盖——正是这条规则保住了 `PATH` 和 `PATHEXT`，
让 `node ticker.mjs` 能像原生一样解析到 `node`。

`check-capabilities.ts` 造一个临时 HOME，里面放 `skills/` 目录和 `mcpServers`
配置，然后用真实的发现代码和 Pi 自己的 loader 读回来：每个 skills 位置都被搜到、
祖先链在仓库根停下，没有 description 的 skill 被**报告**而不是悄悄丢弃，
`mcp.json` 的项目条目按名字覆盖用户条目，Codex 的 `[mcp_servers.*]` TOML 被读成
同一个形状，Pi 的 `DefaultResourceLoader` 收到发现的 skills 且 MCP 扩展在工厂
列表里，Pi 的工具白名单不会悄悄禁掉 direct MCP 工具，MCP 能被关掉，而运时自身
配置工具用的那半个可写接口能读写回环。

`check-capability-commands.ts` 钉住 `/skill` 与 `/mcp` 聊天命令：命令注册表、
skill 调用路由、对着伪造能力表的 `/mcp` 列表与 reconnect 措辞，以及空状态里的
`pi mcp add` 指引。它不拨任何 server——这个面刻意是会话级的，与 Pi 自己的
`/mcp` 一致，因为增删 server 改的是共享的 `mcp.json`，属会话之外。

`check-mcp-events.ts` 钉住 MCP 调用的可见性：一次 MCP 调用必须作为一等活动到达
Activity 和 Stage，而不是作为一个匿名 tool 事件消失。它把适配器真实发出的形状
（Pi 的 `mcp__<server>__<tool>`、Codex 的 `mcpToolCall`）喂给
`eventToActivityRow` / `eventToStageItem` / `statusForTool`，检查 Activity 行、
Stage 终端卡片、状态以及 replay 路径——不需要活的 MCP server。

`check-observer.ts` 是 [decoupling.md](decoupling.md) 里解耦契约的离线一半，
那条标准是：*把 `apps/server/src/agents/` 整个删掉——`absence watch` 还能跑吗？*
它钉住：声明自己是 `observe` 的会话不能被驱动（而省略 `source` 的旧 server 被当作
可驱动，绝不造成线上回归），在 shipped adapters 被 import 之前注册表里什么都没有，
CLI 的 watch 解析器是独立的（`--pid`、`--project`、`--label`、透传 `-- command`），
被观察会话的行来自操作系统而不是运行时，只报告被观察的那棵树，被观察的流仍能形成
运行，终端镜像有界/可合并/可重放，命令从命令行读出，退出码能穿过观察器，以及
Pi 与 Codex 的 transcript tool 调用以同样方式配对与分类。

### 文件 diff

`check-fsdiff.ts` 是文件 diff 引擎的纯 harness。
