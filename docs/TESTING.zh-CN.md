# 测试与检查

Absence 没有单元测试框架；它带一组**验收检查脚本**（`scripts/checks/`），每个都是独立的 harness，钉住那些容易悄悄弄错的规则。架构背景见 [ARCHITECTURE.zh-CN.md](ARCHITECTURE.zh-CN.md)。

## 测试

```bash
node scripts/make-demo.mjs [dir] [--force]   # 搭一个 demo 项目
npx tsx scripts/checks/check-history.ts      # 需要 server 在跑
npx tsx scripts/checks/check-report.ts       # Absence Report 引擎（不需要 server）
npx tsx scripts/checks/check-eggs.ts         # 进程检测（无 server，不 spawn）
npx tsx scripts/checks/check-classify.ts     # 命令意图 + primary/tool 切分
npx tsx scripts/checks/check-agentwatch.ts   # 内核进程观察器（Windows）
npx tsx scripts/checks/check-ebpf.ts         # 内核进程观察器（Linux）
node scripts/gen-whalebun-css.mjs                # 重新生成头像样式表
```

`npm run check:process` 把三个进程相关的 harness 一起跑。

CI workflow（`.github/workflows/ci.yml`）在每次 push / PR 上跑 typecheck 和离线
harness（eggs、classify、report）。`check:history` 和两个内核观察器检查需要
活 server 或内核权限，保持手动。

`make-demo.mjs` 写一个小项目，形状让普通 prompt 练到每个面板：带行区间的读、
能跑的 `npm test`、给 agent 读的 `TODO.md`、以及留给删除 vs 截断情形的
`notes.txt`。mock 运行时真的跑它的 shell 命令，所以一次 mock 运行也会下一只
蛋——这就是没有 Pi 凭据也能练 Agent Eggs 面板的方法。

`check-history.ts` 对一个 live mock 会话跑 **58 项检查**：运行分组、每运行的
Activity 范围、确定的 stage 项 id、快照 seek、Stage 回到默认页、搜索→终端
映射、thinking 捕获（一条流式念头保持为一个 Stage 项，所以 replay 不会重新
挂载它）、两个独立的 FILE 槽位、读累积与缺口标记、逐版本记录、新建文件计数。

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
命令。
