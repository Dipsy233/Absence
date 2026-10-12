# Release v0.3.0

## English

**Absence v0.3.0 — watch Codex and DSH, not just Pi**

Three agent runtimes, one observer. This release makes **OpenAI Codex** and
**DSH (DeepSeek Harness)** first-class alongside Pi — and Absence *takes over
each one's shell*, so the process observer sees exactly what the agent spawns.

Highlights:

- 🤖 **Codex runtime** — driven through `codex app-server` (real item ids, call
  ids, timestamps), with a loopback exec-server takeover so no command escapes
  the observer and no exit is missed.
- 🐳 **DSH runtime** — the ACP server (`dsh --profile acp`) mapped to the same
  event stream; every shell tool call opens a process window for Agent Eggs.
- 🖥️ **Real PTY** via node-pty (ConPTY on Windows), and **Ctrl+C works** — a
  `process/signal interrupt` answers with a process-tree kill.
- 🌱 **Faithful environments** — Codex's `env_policy` is applied exactly like
  its own executor, keeping `PATH`/`PATHEXT` intact.
- 🔔 **Approvals as activities** — an approval prompt is an `APPROVE?` row you
  click, never something forced onto the Stage.
- ⚙️ **Configurable report warnings** — command-failure, failure-streak and
  activity-stall thresholds and levels are all adjustable; plus custom sound
  sets and avatar skins for the character.
- 🐧 **Linux packages** — releases ship an **AppImage** and a **tar.gz**
  (unpack and run, no FUSE — right for servers).

Install: download the installer for your platform from this release, or run
from source with `npm install && npm run build && npm start`.

Full details: [RELEASE_NOTES_v0.3.0.md](docs/RELEASE_NOTES_v0.3.0.md).

---

## 中文

**Absence v0.3.0 — 不只观察 Pi，也观察 Codex 和 DSH**

三个 agent 运行时，一个观察器。本版本让 **OpenAI Codex** 和 **DSH（DeepSeek
Harness）** 与 Pi 一样成为一等运行时——并且 Absence 会**接管每一个的 shell**，
让进程观察器亲眼看到 agent 拉起的一切。

亮点：

- 🤖 **Codex 运行时** — 经 `codex app-server` 驱动（真实 item id、call id、
  时间戳），并用 loopback exec-server 接管 shell，命令逃不出观察，退出不会丢。
- 🐳 **DSH 运行时** — ACP server（`dsh --profile acp`）映射到同一条事件流；
  每个 shell 工具调用都为 Agent Eggs 打开一个进程窗口。
- 🖥️ **真 PTY** — node-pty（Windows 上是 ConPTY），**Ctrl+C 有效** —
  `process/signal interrupt` 以进程树 kill 应答。
- 🌱 **忠实的环境** — Codex 的 `env_policy` 按它自己 executor 的规则生效，
  `PATH`/`PATHEXT` 完整保留。
- 🔔 **审批即 activity** — 审批提示是一条 `APPROVE?` 行，点开应答，绝不强制
  推到 Stage 上。
- ⚙️ **报告警告可配置** — 命令失败、连续失败串、activity 停滞的阈值与等级
  全部可调；另有自定义音效集和形象皮肤。
- 🐧 **Linux 安装包** — 发布同时提供 **AppImage** 和 **tar.gz**（解压即用，
  不需要 FUSE，适合服务器）。

安装：从本 release 下载对应平台的安装包，或从源码运行
`npm install && npm run build && npm start`。

完整说明：[docs/RELEASE_NOTES_v0.3.0.md](docs/RELEASE_NOTES_v0.3.0.md)。
