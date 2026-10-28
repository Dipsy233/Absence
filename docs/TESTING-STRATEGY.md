# Testing strategy / 测试策略

This is the *why* behind [TESTING.md](TESTING.md), which is the *what*.
[TESTING.md](TESTING.md) 是「测什么」，本文是「为什么这样测」。

## The one-paragraph version / 一段话版本

> Absence has no unit-test framework. Its hard part is not a pure function but
> **observing a real operating system** — which process a command laid, whether a
> container became an egg, whether a metrics curve survives a restart. Mocking
> that away would delete the only thing worth testing. So instead of chasing
> coverage, the repo ships **33 acceptance check scripts** that each pin one rule
> that is easy to get silently wrong, layered by what environment they need: pure
> functions with fabricated data (fast, in CI), isolated I/O in a throwaway temp
> dir, real I/O against a live server / kernel / docker, and one full-pipeline
> check that boots its own server. `npm run verify` runs typecheck + build + every
> offline check; it is the pre-commit gate.

> Absence 没有单元测试框架。它难的不是纯函数，而是**观察一个真实操作系统**——一条命令
> 下了哪个进程、容器有没有变成蛋、指标曲线能不能跨重启活下来。把这些 mock 掉，就等于
> 删掉唯一值得测的东西。所以它不追覆盖率，而是带 **33 个验收检查脚本**，每个钉住一条
> 容易悄悄弄错的规则，并按所需环境分层：伪造数据的纯函数（快、进 CI）、临时目录里的
> 隔离 I/O、对着活 server / 内核 / docker 的真实 I/O，以及一个自起 server 的全链路检查。
> `npm run verify` = 类型检查 + 构建 + 全部离线检查，就是提交前门禁。

## Why not vitest / 为什么不用 vitest

| Typical project / 常规项目 | Absence |
|---|---|
| Coverage is the goal / 目标是覆盖率 | The goal is pinning rules that broke before / 目标是钉住曾经破过的规则 |
| Heavy mocking / 大量 mock | Pure functions are tested with data; system boundaries are tested for real / 纯函数用假数据测，系统边界用真东西测 |
| More assertions is better / 断言越多越好 | Each assertion maps to a real past bug / 每个断言对应一个真实发生过的 bug |

The codebase says this out loud. `check-chimes.ts`:

```ts
 * `attentionChimeFor` is the whole policy for when an attention change is
 * audible. It is pure so it can be pinned here: every branch below was a bug
 * once — a step into low rang when it should have been silent, or a release
 * out of high went quiet with it.
```

## The four tiers / 四层结构

```
tier 4  full pipeline   check-e2e.ts            boots its own server + mock session
tier 3  real I/O        execserver, history,    real WebSocket / SQLite / kernel
                        agentwatch, ebpf,       observer / docker / restart
                        docker*, metrics-restart,
                        session-close/dwell,
                        observed-lifetime
tier 2  isolated I/O    storage, metrics,       mkdtemp + ABSENCE_STATE_DIR,
                        metrics-persist,        never the user's archive
                        metrics-ranges,
                        incremental, outside-attr
tier 1  pure            eggs, classify, report, fabricated process tables and
                        markdown, codex*,        event arrays, nothing spawned
                        shellenv, chimes,
                        settings, observer,
                        capabilities*,
                        mcp-events, fsdiff
```

Only tiers 1–2 are in CI (`npm run check:offline`). Tiers 3–4 need a live server,
kernel access, elevated rights or docker, so they are manual and labelled *live*
in [TESTING.md](TESTING.md).

CI 只跑第 1–2 层。第 3–4 层需要活 server、内核权限、提权或 docker，保持手动，
在 [TESTING.md](TESTING.md) 里标 *live*。

### Tier 1 is where the design work is / 第 1 层才是设计功夫所在

The technique is **pushing the untestable system call to the boundary so the
middle becomes a pure function**. `check-eggs.ts` feeds a fabricated process
table into the real attribution code:

```ts
const table = (rows: [number, number, string, string?][]) => ...  // → Map

check("a process that appeared since the last look is a candidate", candidates.includes(1002));
check("something already running is not",                          !candidates.includes(1001));
check("the shell Absence drove is not an egg",                     !claimed.includes(1001));
check("an orphan is refused rather than guessed at",               ...);
```

`candidatePids` / `attributeProcesses` / `buildEggs` are pure, so "the command
window", "the ancestor chain" and "never guess an orphan" are verified in
milliseconds with no process ever spawned.

`candidatePids` / `attributeProcesses` / `buildEggs` 都是纯函数，所以「命令窗口」
「祖先链」「孤儿不猜」这些规则能在毫秒级验证，一条真进程都不用起。

### Tier 2 is where the ordering matters / 第 2 层的顺序是有讲究的

The state dir must be redirected **before** the module is imported, which is why
these checks use a dynamic `import()`:

```ts
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "absence-metrics-"));
process.env.ABSENCE_STATE_DIR = stateDir;          // must precede the import
const { appendMetricsFrame } = await import(".../storage/metrics");
```

A static import would load the module against the user's real archive.

静态 import 会让模块对着用户真实档案加载，所以这里只能动态 import。

## What makes a failure readable / 失败为什么可读

Three rules, enforced by `scripts/checks/harness.ts` (44 lines, one `check()`
exit):

1. **The label is the product rule in plain words** — `"the shell Absence drove
   is not an egg"`, not `assertEquals(claimed.length, 2)`.
2. **`detail` carries the actual value** — `\`got ${primary.length}\`` — so a red
   line shows what happened.
3. **The block comment says which bug it pins** — most checks were a regression
   once.

1. **标签就是产品规则的大白话**，不是 `assertEquals`。
2. **`detail` 带上实际值**，红了能看见发生了什么。
3. **块注释写明它在钉哪个 bug**，大多数检查当初都是真实回归。

## Answering the interview questions / 面试问答

**"Why no test framework?" / 为什么不用测试框架？**
> Because the value is at the system boundary. "`docker compose up -d` should
> show the containers, not the docker client" can only be verified by running
> docker; a unit test either mocks away the meaning or cannot run. So: rules
> *inside* the boundary are pure functions tested with data (fast, in CI);
> the boundary itself is tested with real things (manual / nightly).

> 因为价值在系统边界上。「`docker compose up -d` 应该显示容器而不是 docker 客户端」
> 这条只有真跑 docker 才验证得了；单测要么 mock 掉全部意义，要么跑不了。所以边界内的
> 规则做成纯函数用假数据测（快、进 CI），边界本身用真东西测（手动/夜间）。

**"How do you know the tests themselves are right?" / 怎么保证测试本身没写错？**
> (a) One `check()` exit in `harness.ts`, and it prints the actual value on
> failure rather than just FAIL. (b) Every check is labelled as a behaviour in
> plain words, so a failure names the product rule that broke. (c) The
> un-runnable checks are explicitly registered *outside* `run-offline.ts` — the
> suite never pretends to cover what it does not.

> (a) `harness.ts` 只有一个 `check()` 出口，失败时打印实际值而不只是 FAIL。
> (b) 每个 check 都用大白话描述行为，所以失败时说的是哪条产品规则破了。
> (c) 跑不了的检查明确登记在 `run-offline.ts` 之外——这套测试从不假装覆盖了它没覆盖的。

**"You changed one line — which checks do you run?" / 改了一行要跑哪些？**
> `npm run verify` is the gate: typecheck + production web build + every offline
> check. Then by blast radius: process/attribution → `check:process`; SQLite or
> metrics → `check:metrics*`; whole pipeline → `check:e2e`; Codex layer →
> `check:codex*` + `check:execserver`.

> `npm run verify` 是门禁：类型检查 + Web 生产构建 + 全部离线检查。再按影响面：
> 进程归因 → `check:process`；SQLite/指标 → `check:metrics*`；整条管道 → `check:e2e`；
> Codex 层 → `check:codex*` + `check:execserver`。

**"33 standalone scripts instead of one suite — isn't that unmaintainable?" /
「33 个独立脚本而不是一个 suite，不难维护吗？」**
> Each script is 40–560 lines and self-contained, they share one 44-line harness,
> and the CI list lives in exactly one array (`run-offline.ts`) so adding a check
> touches neither `package.json` nor the workflow. The upside is that any single
> one runs in isolation — `npx tsx scripts/checks/check-report.ts` — which is what
> makes debugging a red CI job fast.

> 每个脚本 40–560 行、自包含，共享一个 44 行的 harness，CI 清单只在一个数组里，
> 新增检查既不改 `package.json` 也不改 workflow。好处是任何一个都能单独跑，
> 调一个红的 CI job 很快。

## Numbers / 数字

| | |
|---|---|
| check scripts / 检查脚本 | 33 |
| assertion calls / 断言调用 | ~714 |
| harness / harness | 44 lines, 4 exports |
| in CI / 进 CI | 21 scripts (tiers 1–2) |
| manual (live) / 手动 | 12 scripts (tiers 3–4) |
| pre-commit gate / 提交门禁 | `npm run verify` |

## Pointers / 延伸阅读

- [TESTING.md](TESTING.md) — every check and the rule it pins / 每个检查及它钉住的规则
- [ARCHITECTURE.md](ARCHITECTURE.md) — the event pipeline these checks exercise
- [decoupling.md](decoupling.md) — the contract `check-observer.ts` enforces
- [CHART.md](CHART.md) — the rule pack `check-report.ts` judges with
