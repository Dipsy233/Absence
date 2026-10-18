# 解耦：从「agent 客户端」到「agent 观察器」

> 分支 `feat/observer-decoupling`。这份文档是这套改动的设计来源，先读这里，
> 再读代码。

## 问题

现在的 Absence 有两副面孔：

| 面孔 | 依赖 | 稳定性 |
|---|---|---|
| **观察者** — 进程、文件、终端 | 操作系统 | 稳定，不会随 agent 版本变化 |
| **客户端** — tool 语义、skills、MCP 配置 | 某个 pi / codex / dsh 版本的私有实现 | 脆弱，每次升级都可能坏 |

第二副面孔是债务的源头。`apps/server/src/agents/` 下 4700 行（PiAdapter 812、
CodexAdapter 1169、DshAdapter 746、AppServerClient 420、CodexCommands 372 …）
全部是在回答「我能从你的实现里读到什么」。这些实现没有对外承诺任何稳定协议，
所以问题不在于这些代码写得如何，而在于**这个位置本身不该存在**。

## 三层事件模型

```
Layer 0  OS 事实流 —— 必需，零耦合，永远可用
         进程出现/退出、文件创建/修改/删除
         来源：ProcessWatcher（Job Object / eBPF）、FileWatcher
         带「概率精度」标注：exact（内核事件）/ sampled（轮询）

Layer 1  终端流量镜像 —— 低耦合，通用
         agent 进程写出的原始 stdout/stderr 字节流
         来源：pty 旁路或管道转发，不解析内容

Layer 2  语义事件 —— 可选，每 runtime 一个插件
         tool_start / file_read / mcp / thinking / approval …
         来源：runtime adapter；接得到就接，接不到就退化
```

**核心不变量：Layer 2 缺失时，Stage 必须依然可用、依然好看。**
今天是反的——没有 Layer 2 就什么都看不到。本分支先修这一点。

## 本分支做了什么

### 1. `session` 来源标注（这次改动的地基）

`SessionRuntimeState` 新增必填字段 `source: SessionSource`：

```ts
{ kind: "runtime", runtime: "pi" | "codex" | "dsh" | ... }   // 由 adapter 驱动
{ kind: "observe", targetPid, label }                         // 只观察别人的进程
```

UI 用它决定怎么说这件事：

- `runtime` → 能做的都做
- `observe` → 不显示「撤回/审批/model 切换」这些按钮，因为**它不拥有那个进程**；
  状态栏写「观察中」，Stage 只画 Layer 0/1

没有这个字段，UI 就只能靠猜 runtime 名字来判断能力——那又是耦合。

### 2. `observe` 模式：`absence watch`

```
absence watch --pid 1234
absence watch --project . -- cmd /c "pi" ...   # 后置阶段
```

服务端起一个 `AbsenceSession`，其 source 为 `observe`：

- **没有 adapter**：不启动、不发送提示、不改配置
- `ProcessWatcher` 以被观察进程为根（`rootPid`），因此它的整棵子树都算作
  「agent 的工作」，与 runtime 由谁启动无关
- `FileWatcher` 照常观察项目目录
- Stage / Activity / Report 全部由 Layer 0 事件驱动

这意味着：**任何 agent、任何版本，只要它是个进程，就能被观察**，
一行适配代码都不用写。

### 3. 进程事件的归因（observe 模式下唯一的证据源）

observe 模式**不能**用内核观察器。Windows 的 Job Object 观察器是挂在
**Absence 自己**进程上的：它只报告 Absence 创建的进程，一个在我们启动之前就
存在于别的终端里的 agent 根本不在那个 Job 里，永远不会被报告。所以 observe
模式**只轮询进程表**（`OBSERVE_TICK_MS`），这也解释了为什么它的精度标注是
`sampled`。

归因规则（`ProcessWatcher.discoverObserved`）：

1. 启动时从被观察 pid **向下走一遍**进程表，把它当时已经拥有的进程记为
   「已知」（`seedObservedAncestry`）。这些进程是**上下文，不是行为**，不上报。
   —— 绝不能把整张表都记为已知：第一版这么做了，结果 services.exe、QQ.exe、
   所有 shell 全被当成 agent 的工作。
2. 之后每个 tick 只看新出现的进程。父进程属于被观察树 → 是根进程（egg）；
   父进程是我们已经上报的 egg → 折叠进它（子进程计数 +1）。
3. 父进程不在树里（同级应用、某个 service）→ **不是我们的**，无论它起多少进程。

这一条是本次花时间最多的地方，`check-observer.ts` 用假进程表把它钉住了。

### 4. 观察流也要能构成 run

History / Replay / Absence Report 全都建立在「run」上，而 run 原本由用户
发出的 `message` 开启。被观察的 agent 不会收到我们的 message，所以
`buildHistory` 与增量版 `applyEvent` 都增加了一条规则：

> 在一段没有任何 `agent_start` / 用户 `message` 的流里，
> **run 从最后一个 run 之后最老的那个事件开启**，prompt 写作 `observed activity`。

判断依据是流本身（`isObservedStream`），不是会话标志——因为 `buildHistory`
被 memo、Report、Replay 三个地方调用，传标志等于把同一知识写四遍。
一旦流里出现 `agent_start` 或用户 message，它立即回到原来的规则，
驱动式会话的行为**逐字节不变**。

### 4. 后续阶段（不在本分支完成，接口留好）

| 阶段 | 内容 | 依赖 |
|---|---|---|
| 2 | 事件协议对外公开 + `POST /api/ingest` | 本分支的 `source` |
| 3 | adapter 插件化：内置 pi/codex/dsh 改走插件路径 | 本分支 |
| 4 | 删除 skills/MCP 配置管理（`capabilities/manage.ts`） | 阶段 3 |
| 5 | PTY passthrough 的 `absence run`（Layer 1） | 本分支 |

## 已经成立的证据

`npm run check:observer`（27 条）在进程内验证：

- `canDriveSession()`：驱动 / 观察 / 老服务器三种输入
- registry 在**只 import 应用**时是空的 —— 这就是「删掉 agents/ 还能跑」的可测部分
- `parseWatchArgs()` 独立于服务器，不 import 任何 agent 代码（故意拆到 `cliArgs.ts`）
- observe 模式的进程归因（假进程表）：既有子树不上报、新子进程上报、
  其子进程折叠、同级应用忽略
- 观察流构成 run，驱动流行为不变

实测（真实进程树）：`absence watch --pid <agent>` 能观察到 agent 新起的子进程、
它们退出、以及项目内文件变化，全程没有向 agent 进程写过一个字节。

## 判断标准

衡量解耦是否成功的唯一标准：

> **把 `apps/server/src/agents/` 整个目录删掉，`absence watch` 还能不能用？**

本分支之后，答案是能。
