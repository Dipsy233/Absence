# 测试策略

本文是 [TESTING.zh-CN.md](TESTING.zh-CN.md)（「测什么」）背后的「为什么这样测」。

## 一段话版本

> Absence 没有单元测试框架。它难的不是纯函数，而是**观察一个真实操作系统**——一条
> 命令下了哪个进程、容器有没有变成蛋、指标曲线能不能跨重启活下来。把这些 mock 掉，
> 就等于删掉唯一值得测的东西。所以它不追覆盖率，而是带 **33 个验收检查脚本**，每个
> 钉住一条容易悄悄弄错的规则，并按所需环境分层：伪造数据的纯函数（快、进 CI）、
> 临时目录里的隔离 I/O、对着活 server / 内核 / docker 的真实 I/O，以及一个自起
> server 的全链路检查。`npm run verify` = 类型检查 + 构建 + 全部离线检查，就是提交前门禁。

## 为什么不用 vitest

| 常规项目 | Absence |
|---|---|
| 目标是覆盖率 | 目标是钉住曾经破过的规则 |
| 大量 mock | 纯函数用假数据测，系统边界用真东西测 |
| 断言越多越好 | 每个断言对应一个真实发生过的 bug |

代码里直接写着这一点，`check-chimes.ts`：

```
 * `attentionChimeFor` is the whole policy for when an attention change is
 * audible. It is pure so it can be pinned here: every branch below was a bug
 * once — a step into low rang when it should have been silent, or a release
 * out of high went quiet with it.
```

## 四层结构

```
第 4 层  手动      agentwatch、ebpf、     需要带内核权限的观察器二进制，
                  docker、docker-eggs、   或一个 docker daemon
                  e2e
第 3 层  自起 server history、lifecycle、  每个都在临时端口 + 隔离 state
                  session-dwell、         目录上起自己的 server 再杀掉
                  session-close、
                  metrics-restart、
                  observed-lifetime
第 2 层  隔离 IO   storage、metrics、      mkdtemp + ABSENCE_STATE_DIR，
                  metrics-persist、        绝不碰用户档案
                  metrics-ranges、
                  incremental、execserver、
                  outside-attr
第 1 层  纯函数    eggs、classify、report、 伪造进程表与事件数组，
                  markdown、codex*、       不 spawn 任何东西
                  shellenv、chimes、
                  settings、observer、
                  capabilities*、
                  mcp-events、fsdiff
```

CI 跑第 1–3 层（`npm run check:offline`）：27 个脚本，约 3 分钟。第 3 层的检查
自己起 server 并不构成排除理由——那是这里最常见的形态，而会话与指标的行为恰恰
最容易悄悄腐烂。只有第 4 层保持手动，因为它需要内核权限或 docker。

### 第 1 层才是设计功夫所在

技巧是**把不可测的系统调用挤到边界外，让中间变成纯函数**。`check-eggs.ts` 把伪造的
进程表喂给真实的归因代码：

```ts
const table = (rows: [number, number, string, string?][]) => ...  // → Map

check("a process that appeared since the last look is a candidate", candidates.includes(1002));
check("something already running is not",                          !candidates.includes(1001));
check("the shell Absence drove is not an egg",                     !claimed.includes(1001));
check("an orphan is refused rather than guessed at",               ...);
```

`candidatePids` / `attributeProcesses` / `buildEggs` 都是纯函数，所以「命令窗口」
「祖先链」「孤儿不猜」这些规则能在毫秒级验证，一条真进程都不用起。

### 第 2 层的顺序是有讲究的

state 目录必须在模块被 import **之前**重定向，这就是这些检查用动态 `import()` 的原因：

```ts
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "absence-metrics-"));
process.env.ABSENCE_STATE_DIR = stateDir;          // 必须先于 import
const { appendMetricsFrame } = await import(".../storage/metrics");
```

静态 import 会让模块对着用户真实档案加载。

## 失败为什么可读

三条规则，由 `scripts/checks/harness.ts`（44 行、一个 `check()` 出口）保证：

1. **标签就是产品规则的大白话**——`"the shell Absence drove is not an egg"`，
   而不是 `assertEquals(claimed.length, 2)`。
2. **`detail` 带上实际值**——`\`got ${primary.length}\``——红了能看见发生了什么。
3. **块注释写明它在钉哪个 bug**——大多数检查当初都是真实回归。

## 面试问答

**为什么不用测试框架？**
> 因为价值在系统边界上。「`docker compose up -d` 应该显示容器而不是 docker 客户端」
> 这条只有真跑 docker 才验证得了；单测要么 mock 掉全部意义，要么跑不了。所以边界内的
> 规则做成纯函数用假数据测（快、进 CI），边界本身用真东西测（手动/夜间）。

**怎么保证测试本身没写错？**
> (a) `harness.ts` 只有一个 `check()` 出口，失败时打印实际值而不只是 FAIL。
> (b) 每个 check 都用大白话描述行为，所以失败时说的是哪条产品规则破了。
> (c) 跑不了的检查明确登记在 `run-offline.ts` 之外——这套测试从不假装覆盖了它没覆盖的。

**改了一行要跑哪些？**
> `npm run verify` 是门禁：类型检查 + Web 生产构建 + 全部离线检查。再按影响面：
> 进程归因 → `check:process`；SQLite/指标 → `check:metrics*`；整条管道 → `check:e2e`；
> Codex 层 → `check:codex*` + `check:execserver`。

**33 个独立脚本而不是一个 suite，不难维护吗？**
> 每个脚本 40–560 行、自包含，共享一个 44 行的 harness，CI 清单只在一个数组里，
> 新增检查既不改 `package.json` 也不改 workflow。好处是任何一个都能单独跑，
> 调一个红的 CI job 很快。

## 数字

| | |
|---|---|
| 检查脚本 | 33 |
| 断言调用 | ~714 |
| harness | 44 行，4 个导出 |
| 进 CI | 27 个脚本（第 1–3 层），约 3 分钟 |
| 手动 | 5 个脚本（第 4 层） |
| 提交门禁 | `npm run verify` |

## 延伸阅读

- [TESTING.zh-CN.md](TESTING.zh-CN.md) — 每个检查及它钉住的规则
- [ARCHITECTURE.zh-CN.md](ARCHITECTURE.zh-CN.md) — 这些检查所练的事件管道
- [decoupling.md](decoupling.md) — `check-observer.ts` 执行的契约
- [CHART.md](CHART.md) — `check-report.ts` 用来判定的规则包
