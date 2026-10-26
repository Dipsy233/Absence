# 测试与检查

Absence 没有单元测试框架；它带一组**验收检查脚本**（`scripts/checks/`），每个都是独立的 harness，钉住那些容易悄悄弄错的规则。架构背景见 [ARCHITECTURE.zh-CN.md](ARCHITECTURE.zh-CN.md)。

## 测试

```bash
node scripts/make-demo.mjs [dir] [--force]   # 搭一个 demo 项目
npm run check:offline                        # 一次跑完全部离线检查
npm run verify                               # 类型检查 + Web 构建 + 全部离线检查
npx tsx scripts/checks/check-history.ts      # 需要 server 在跑
npm run check:metrics                        # SQLite 指标存储与退出边界（纯）
npm run check:incremental                    # 增量状态折叠与滑动窗口（纯）
npx tsx scripts/checks/check-outside-attr.ts # agent 外部改动归因（纯）
npx tsx scripts/checks/check-report.ts       # Absence Report 引擎（不需要 server）
npx tsx scripts/checks/check-markdown.ts     # 对话的 Markdown 解析器（纯）
npx tsx scripts/checks/check-eggs.ts         # 进程检测（无 server，不 spawn）
npx tsx scripts/checks/check-classify.ts     # 命令意图 + primary/tool 切分
npx tsx scripts/checks/check-codex.ts        # Codex 命令解析 + 审批（纯）
npx tsx scripts/checks/check-codexshell.ts   # 去掉 Codex 的 shell 外壳（纯）
npx tsx scripts/checks/check-shellenv.ts     # Codex env_policy → 命令环境（纯）
npx tsx scripts/checks/check-execserver.ts   # 真实 WebSocket 上的 Codex exec-server
npx tsx scripts/checks/check-fsdiff.ts       # 文件 diff 引擎（纯）
npx tsx scripts/checks/check-agentwatch.ts   # 内核进程观察器（Windows）
npx tsx scripts/checks/check-ebpf.ts         # 内核进程观察器（Linux）
npx tsx scripts/checks/check-docker.ts       # docker 命令的进程边界（Windows + WSL docker）
npx tsx scripts/checks/check-docker-eggs.ts  # 容器蛋：事件归因 + stats 指标 + 退出码
npx tsx scripts/checks/check-e2e.ts          # 全链路：自起 server + mock 会话，无需模型
node scripts/gen-whalebun-css.mjs            # 重新生成头像样式表
```

所有离线检查共享 `scripts/checks/harness.ts`（`check()` / `finish()` /
`waitFor()`），并由 `npm run check:offline` 逐个 spawn 着跑——离线脚本清单
只登记在 `scripts/checks/run-offline.ts` 一处，新增检查脚本只需写好文件
并把它加进那个数组，CI 无需改动。`npm run verify` 再把类型检查和 Web
生产构建接在离线检查之前，适合作为提交前的完整门禁。

`npm run check:process` 把全部进程相关 harness 一起跑（observer 检查在非本
平台会自行跳过）。

CI workflow（`.github/workflows/ci.yml`）在每次 push / PR 上跑 typecheck 和
`npm run check:offline`（全部离线 harness，见 `run-offline.ts`），Node 版本为
22，与 `engines.node` 一致。`check:history` 和两个内核观察器检查需要活
server 或内核权限，保持手动。

`make-demo.mjs` 写一个小项目，形状让普通 prompt 练到每个面板：带行区间的读、
能跑的 `npm test`、给 agent 读的 `TODO.md`、以及留给删除 vs 截断情形的
`notes.txt`。mock 运行时真的跑它的 shell 命令，所以一次 mock 运行也会下一只
蛋——这就是没有 Pi 凭据也能练 Agent Eggs 面板的方法。

`check-history.ts` 对一个 live mock 会话跑 **80 项断言**：运行分组、每运行的
Activity 范围、确定的 stage 项 id、快照 seek、Stage 回到默认页、搜索→终端
映射、thinking 捕获（一条流式念头保持为一个 Stage 项，所以 replay 不会重新
挂载它）、两个独立的 FILE 槽位、读累积与缺口标记、逐版本记录、新建文件计数。

`check-metrics.ts` 验证指标 chunk 的读写、不同步长重采样、session 平均值，
以及 egg 退出后不再延长生命周期或继续累计资源。

`check-incremental.ts` 验证事件滑动窗口下 eggs、History 和 Activity 的增量
折叠与完整重建一致，并钉住每事件成本不会退化成窗口大小的乘积。

`check-outside-attr.ts` 验证只有写语义工具能归因外部改动，路径字段不会把
文件内容里的路径误报为改动，且 Windows 路径大小写/分隔符保持一致。

`check-report.ts` 是 Absence Report 引擎的纯 harness（无 server）：没有
`command` 事件的失败工具仍计为一次失败命令，recovery 只在中间还有活动时消费
一次失败，agent 的写入从不同时被计成观察到的改动，`created` 相对更早的运行，
phase 在 recovery 之后落到 `verifying`，Timeline 按事件顺序每个活动一个节点
带它的效果（一条流式念头保持一个节点，没结束的 shell 工具读成在跑的进程，
运行期间下的蛋成为 `LAID` 节点——还活着的蛋把关注抬到 high）。它还钉住了环路
规则：把读状态写回去是一次 `file_version_loop`、关注 medium，带缺口的读状态
永远不是环路基准，失败两次的同一条命令是一次带命令文本的 `command_retry_loop`，
失败一次不算环路，项目外的改动是一次 `outside_change`、低级关注、Timeline 上
标 `OUTSIDE`，而还在跑的蛋（high）压过项目外改动（low）。

`check-markdown.ts` 是 Chat 面板 Markdown 解析器的纯 harness：智能体真正常写的
块级与行内结构（标题、嵌套列表、任务列表、表格、围栏代码）都能解析，而写了一半
的结构——未闭合的围栏、`**`、`[`——会退化成文本，而不是吞掉流式回复的剩余部分。
它也钉住那些**不该**变成标记的东西：算式（`2 * 3 * 4`）、`snake_case`、原始 HTML、
`javascript:` 链接都保持字面量——这正是渲染这棵树无需 HTML 消毒器的原因。

`check-eggs.ts` 是进程检测的纯 harness（无 server，不 spawn 任何东西）：
命令窗口决定谁是候选，祖先链决定谁是我们的，Absence 放在自己 shell 上的标记
决定什么是管道，孤儿被拒绝而不是猜测，子树折叠到根并数出后代，eggs 面板把
重复的 pid 折成一个 egg，带 `running` / `dead` / `all` 过滤。

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

`check-codex.ts` 是 Codex 命令层的纯 harness：从 Codex 自己的 `commandActions`
读出 read/search/list（带文本回退），以及从 `availableDecisions` 推导的审批决策
与选项。

`check-codexshell.ts` 钉住去掉 Codex shell 外壳的规则：`pwsh -Command "…"`
（带 UTF-8 前导）、`bash -lc "…"`、`cmd /c …`、多 flag 形式和带引号的 exe 路径
都归约为模型写的命令；非 shell 调用原样保留。

`check-shellenv.ts` 钉住环境构建：Codex 的 `env_policy`
（inherit / 默认排除 / 自定义排除 / set / include-only）作用于 executor 自身
环境，再让请求的稀疏 `env` 覆盖——正是这条规则保住了 `PATH` 和 `PATHEXT`。

`check-execserver.ts` 在 loopback WebSocket 上驱动真实的 exec-server：
`initialize`，随后 `process/start`/`output`/`exited`/`closed`，一条 `tty: true`
命令在 `pty` 流上输出并在写入 Ctrl+C 时停止，以及 `process/signal interrupt`
第一手停掉一条运行中的命令。

`check-fsdiff.ts` 是文件 diff 引擎的纯 harness。
