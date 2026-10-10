# Absence / 发呆症

[English](README.md) | 中文

> AI moves fast. Humans watch.

Absence 是一个面向 AI agent 的实时可视化观察器。它不试图让 agent 更聪明——
它让人*看见* agent 正在做什么。

```
Pi 运行 agent。
Absence 观察事件。
Stage 把事件变成人可以看的东西。
```

- **实时观察** — 一张桌子、一台显示器、一张纸：agent 的每一次读、改、跑
  命令都变成人真正能看的东西，以真实速度实时播放。
- **Replay** — 每次运行都从事件 + 状态快照重建（绝不是录屏），可拖动进度条
  以 0.25×–10× 回放。
- **Absence Report** — 几秒钟内把一次运行归约成事实：改了什么、跑了什么、什么
  失败了、什么需要你——包括环路（agent 撤销自己的修改、反复重试失败的
  命令）和它留下的还在跑的进程。没有 LLM，不靠猜：只报告观察器亲眼看到的。
- **Agent Eggs** — agent 启动的每一个进程，由内核事件捕获（Windows 用
  Job Object，Linux 用 eBPF），按行为分类，所以 `cat` 之类的帮手永远不会
  淹没命令真正启动的那个守护进程。
- **Agent Folder** — agent 自己视角里的项目：只有它上下文里真正有的文件和
  行区间，每个文件带版本历史。

## 截图

**观察一次运行** — Stage、Activity 事件流，以及 agent 逐步读遍项目：

![Absence 观察 agent 运行](docs/screenshots/absence-1.png)

**运行结束之后** — Absence Report、Agent Folder、Agent Eggs，头像回到 *listening*：

![Absence 报告视图](docs/screenshots/absence-2.png)

## 快速开始

环境要求：Node.js **22.19+**（测过 24）和 npm。一个配置好的 Pi（跑一次
`pi` 并登录）是可选的——没有凭据时 Absence 退回一段脚本化的 mock 运行时并
明说。

```bash
npm install

npm run dev       # dev：web 在 :5173（代理 /api 和 /ws），server 在 :8848
npm run build     # 构建 web 应用
npm start         # 单源——server 在 :8848 上伺服构建好的应用
```

然后打开 `http://127.0.0.1:8848`，输入或选择项目路径，选运行时，点
**Open**，在 Stage 底部的聊天框里给 agent 发任务。路径框下面的 **History**
列表展开保存的会话——Absence 自己的归档合并 Pi 的，最新在前；点一行重新打开
那段对话。

### 一键启动器

```bat
start-absence.bat            :: Windows——构建、启动 server、打开 UI
start-absence.bat check      :: 干跑——报告会发生什么，什么都不启动
```

```sh
./start-absence.sh           # Linux / WSL——eBPF 观察器缺失时还会构建它
./start-absence.sh check     # 干跑
```

两者都是幂等的（已在监听的 server 不动），转发到 `scripts/browser/` 下的
真正启动器。用 `ABSENCE_PORT` 和 `ABSENCE_AGENT` 覆盖端口/运行时。

### 桌面应用（Electron）

```bash
npm run build             # 外壳伺服 dist/web
npm run desktop:install   # 一次——安装 Electron（自己的 node_modules）
npm run desktop           # 打开原生窗口
npm run desktop:dist      # 打包可分发版本（NSIS / AppImage / DMG）
npm run desktop:pack      # 同样，但输出未打包目录（更快）
```

桌面外壳在进程内运行 server——没有控制台窗口、`port: 0`、托盘图标、关到
托盘让观察继续跑，运行结束而窗口没聚焦时有原生通知。窗口和浏览器是同一个
web 应用；没有任何分叉。Windows 上 **`start-absence-app.bat`** 一键完成
构建 → 安装 → 打开。

### 在服务器上运行（Linux）

同样的 `npm run build && npm start` 从一个源伺服整个 UI。要用内核级进程
观察器，先编译 eBPF helper，并以能加载它的权限运行 server：

```bash
bash native/agentwatch-linux/build.sh        # 需要 clang + 内核头文件
sudo ./start-absence.sh                          # root，或授予 capability：
sudo setcap cap_bpf,cap_perfmon+ep native/agentwatch-linux/agentwatch-linux
```

没有观察器时，watcher 退回 `ps` 快照，短命进程可能漏掉。

#### WSL 里的 pi

Absence 把 pi 嵌在自己的进程里，所以 WSL 需要 **Linux 的 pi**（不是
`/mnt/c/…` 下的 Windows 安装）：

```sh
npm install -g @earendil-works/pi-coding-agent
```

并且要把 provider 指向 Windows 宿主（绑定在 Windows 回环上的模型 server
从 WSL 里以 `127.0.0.1` 是够不到的）。`scripts/wsl-pi-config.sh` 拷贝
Windows 的 `models.json` 并把主机改写成默认路由网关；`start-absence.sh` 每次
启动都跑它，因为 WSL 重启后网关地址会变。

> **与 Windows 共用 checkout：** `node_modules` 是平台相关的（esbuild 每个
> 平台带一个原生二进制）。每个平台留一个 checkout，或者切换时重装。

## 界面

```
┌──────────────────────────────────────────────────────────────┐
│                         SESSION BAR                          │
├──────────────┬───────────────────────────────┬───────────────┤
│    FILES     │  [FILE DIFF REPLAY]  TABLE    │     AGENT     │
│  (用户视角)  │      [TERMINAL FILE LIVE]     │   (头像)      │
│              │                               │               │
├──────────────┤───────────────────────────────┼───────────────┤
│   HISTORY    │                               │  AGENT FOLDER │
│   (运行)     │            STAGE              │  (agent 视角) │
├──────────────┤                               ├───────────────┤
│   ACTIVITY   │  replay 控件，仅在回放时出现  │  AGENT EGGS   │
│  (选中运行)  │  chat dock：只有一行输入      │ 它启动的进程   │
└──────────────┴───────────────────────────────┴───────────────┘
```

整个 UI 按"你在看谁的视角"切分——**左栏是你的**（整个项目、整个文件、从
磁盘读），**右栏是 agent 的**（只有它真正读过的部分，从不假装比它知道得
更多）。如果 agent 读过某文件的 10–20 行，它的 FILE 按钮只显示这些行——
读过 1–2 和 3–5 之后显示 1–5，中间从不会被悄悄接上；没读过的行变成显式的
`⋯` 标记。

- **Stage**（中）— 默认页是一张桌子；FILE / DIFF / TERMINAL / LIVE 视图以
  半透明叠层骑在上面，REPLAY 带完整的拖动控件（0.25×–10×）。Absence 按钮翻转
  图层：桌子以可点击穿透的 ghost 浮在内容*前面*。聊天停靠在底部——一行
  输入，历史向上展开，可收起。
- **Files → History → Activity**（左）— 项目树（`●` 标记 agent 碰过的文件，
  右键可检查/diff/历史）、每次运行一行的 History（带动作计数 `R` 读 ·
  `S` 搜索 · `E` 改 · `C` 建 · `$` 命令）、选中运行的动作——点一行放上
  Stage，或 **▶ replay** 从头回放。推理也被捕获：一条 `thinking` 事件是一行
  THINK，和它导致的动作并排。
- **Agent**（右）— Heti 头像，姿势纯由事件流驱动：listening 放松、thinking
  思考、speaking 说话、reading 阅读、editing 书写、running 打字、waiting
  打盹、error 慌张。
- **Agent Folder**（右）— agent 的文件，最新在前，每个可展开成它持有过的
  版本（v0 读 → v1 写 → v2 改…）。文本在 agent 看到它的那一刻被捕获，所以
  磁盘上再发生什么都改写不了更早的版本。
- **Agent Eggs**（右）— agent 启动的进程，带 `running` / `dead` / `all`
  标签。按行为分类，不按名字：活得比命令久、自己生进程、被命令点名
  （`python train.py`）、被后台化/重定向、或从工作区运行的进程是 *primary*；
  短命帮手（`cat`、`grep`、`docker ps`）折成计数。所以 `docker compose up -d`
  显示的是容器而不是客户端；`nohup node ticker.mjs` 显示的是
  `node ticker.mjs` 而不是 `nohup`。
- **Session bar** — 会话 id、项目、模型、上下文用量、live/offline，以及一个
  配色循环按钮（`amber → blue → green`），整套 UI 换肤且选择被记住。

## Absence Report

Stage 顶部中央的标签展开一份半透明报告，完全从事件流推导——没有 LLM，不
解析命令行：

- **运行进行中** — agent 现在在干什么：一个阶段（`investigating` /
  `implementing` / `executing` / `verifying` / `recovering`）、进度、和一个人工
  关注等级。
- **运行结束时** — 这次运行相当于什么：**Timeline**（每个活动一个节点，带
  它的效果——进了上下文的行、`+A / −D`、退出状态）、**Knows**（读了哪些
  文件、跑了哪些搜索）、**Changes**（新建/修改/删除，带 `+A / −D`）、
  **Executions**（命令与退出状态）、恢复、结局、和 agent 的回复。每一项都是
  证据链接——点它在报告旁边打开内容，并高亮 Activity 里的对应行。

人工关注盯着 agent 自我挫败：**文件版本环路**（新版本与更早版本逐字节相同
——一次被撤销的修改）和**命令重试环路**（同一条命令失败两次以上）把关注
抬到 *medium*；**项目外改动**到 *low*；运行结束后**还在跑的蛋**到 *high*。
实时关注等级跨入/跨出 medium/high 时有一声关注铃，运行结束有完成铃。

## 配置

| 环境变量 | 默认 | 含义 |
|---|---|---|
| `PORT` | `8848` | Server 端口 |
| `HOST` | `127.0.0.1` | Server 主机 |
| `ABSENCE_AGENT` | `pi` | 默认运行时：`pi` 或 `mock` |
| `ABSENCE_PROJECTS_ROOT` | `~/projects` | 项目选择器列出的目录 |
| `ABSENCE_PI_TOOLS` | `read,bash,edit,write,grep,find,ls` | 启用的 Pi 内建工具。`bash` / `powershell` 由 Absence 自己的 shell 提供，这正是进程可被观察的原因 |
| `ABSENCE_LOG_LEVEL` | `info` | Fastify 日志级别 |
| `ABSENCE_STATE_DIR` | `~/.absence` | Absence 归档会话历史的位置 |
| `ABSENCE_AGENTWATCH` / `ABSENCE_AGENTWATCH_LINUX` | 仓库 `native/` | 覆盖原生观察器二进制路径 |

### 聊天命令

chat dock 兼作小终端：以 `/` 开头的行是命令，其他都是 prompt。`/model`、
`/thinking`、`/compact`、`/name`、`/session`、`/export [html|jsonl]`。切换
模型是会话级的；结果随会话归档，恢复时会回来。

### 本地模型

Absence 只和 Pi 说话，Pi 和任何 OpenAI 兼容端点说话——在
`~/.pi/agent/models.json` 里注册一个本地 server 就能用，不需要改代码（完整
例子见 [docs/ARCHITECTURE.zh-CN.md](docs/ARCHITECTURE.zh-CN.md)）。4B 的模型
选工具并不可靠；`ABSENCE_PI_TOOLS` 可以收窄集合，练 UI 用 mock 运行时更合适。

## 安全提示

Absence server **没有鉴权**，其 API 可以列出目录并读取配置的项目根下的文件。
它默认绑定 `127.0.0.1`，对桌面应用和个人机器是安全的。如果你在 Linux
服务器上运行并从网络访问，请保持在可信网络内，或放在有鉴权的反向代理后面
——不要把端口暴露到公网。

## 注记与限制

- 会话**持久化到磁盘**，重启后还在。Pi 把模型的对话放在
  `~/.pi/agent/sessions/`；Absence 把 `AbsenceEvent` 流放在 `~/.absence/sessions/`
  （用 `ABSENCE_STATE_DIR` 覆盖）。选择器的 **History** 两种都能重开。因为
  `~` 是平台的家目录，**Windows 和 WSL 保存各自的历史**；把
  `ABSENCE_STATE_DIR` 指到同一个共享路径可以合并——但绝不要两边同时对同一个
  文件跑。
- Pi **没有删除工具**——删除必须走 `bash rm`。当 agent 改为写入空内容时，
  文件是*被截断，不是被删除*，Absence 会标 **EMPTIED** 加字节数，让假删除一眼
  可见。
- 有内核观察器（Job Object / eBPF）时没有采样下限——20 ms 的进程和任何
  进程一样被看见。快照回退有 ~0.5 秒的下限，从命令孤立的进程
  （命令返回后的 `npm run dev &`）不会被归属，agent *绕过* shell 启动的
  进程（WMI、计划任务、别的 pid namespace）暂时看不见。
- 桌子世界的 `DeskState` / `DeskItem` 存在但尚未被事件驱动；头像的 Live2D
  是 v0.3 的事项。

## 文档

- [docs/ARCHITECTURE.zh-CN.md](docs/ARCHITECTURE.zh-CN.md) — 事件管道、进程
  观察与分类、仓库目录树、`AbsenceEvent` schema、HTTP/WS API、聊天命令、桌面
  打包内部机制、本地模型配置。
- [docs/TESTING.zh-CN.md](docs/TESTING.zh-CN.md) — 验收检查脚本及各自钉住的
  规则。

## 许可

[MIT](LICENSE)
