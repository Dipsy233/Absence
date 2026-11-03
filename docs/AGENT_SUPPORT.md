# Agent 接入（ACP）

Absence 是 ACP **client**：它启动一个已经会说 ACP 的 agent，或一个用户自己装好的
ACP 适配器，然后只做转发与观察。本文是"怎么让一台机器上的 agent 出现在选择器里"
的完整说明。架构背景见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 发现顺序

`AgentCatalog` 回答"这台机器装了什么"，严格按序，先赢先用：

1. **显式 launch line**（用户意图永远第一）：
   - `~/.absence/agents.json` 里的自定义条目或 launch 覆盖；
   - 旧版 `~/.absence/runtimes.json`（v0.5 前位置，只读兼容）；
   - 环境变量覆盖，如 `ABSENCE_PI_ACP_BIN`、`ABSENCE_CODEX_ACP_BIN`
     （每个 profile 的变量名见下表"覆盖变量"列）。
2. **已安装的 ACP 入口**：PATH 上的适配器可执行文件（`pi-acp`、`codex-acp`、
   `claude-code-acp`），或 agent CLI 自带的 ACP 模式（`dsh --profile acp`、
   `qwen --experimental-acp`、`gemini --acp`），或项目本地 `node_modules` 里的
   适配器包（入口默认 `dist/index.js`）。
3. **只有 agent CLI**：行显示为 `needs-adapter`（缺适配器），**不**自动退到 npx。
4. **npx 兜底**：仅在显式开启时——环境变量 `ABSENCE_ALLOW_NPX=1`，或
   `~/.absence/agents.json` 里 `"allowNpx": true`（picker 里也有开关）。该入口
   在 UI 标注为临时下载。除此之外 Absence 从不下载任何包。

选择器只列出**装了**的 agent；未安装的内置 profile 不占格子。`npm run
registry:sync` 把 ACP 官方注册表拉到 `~/.absence/registry.json`，之后注册表里的
新 agent 也会出现在选择器（无需重启）。

## 状态机

每一行的状态由探测得出，不靠产品名分支：

| 状态 | 含义 |
|---|---|
| `ready`（可启动） | 找到了可执行的 ACP 入口 |
| `needs-adapter`（缺适配器） | agent CLI 在，ACP 入口没装；行内给出安装提示（命令可复制，Absence 不替你执行） |
| `needs-auth`（需登录） | 入口在，但 agent 要求先过 `authenticate`；用 `/auth <methodId>` |
| `unavailable` | 什么都没有；不进选择器 |

认证状态（`configured / missing / unknown / not-required`）由 `inspect` 对 agent
自己配置目录的**只读**探测得出：只看凭据文件是否存在，从不读出内容，从不写入。
读不到就是 `unknown`。

## 内置 profile 与适配器包

| Agent | ACP 入口（适配器包） | 启动方式 | 覆盖变量 | 认证 |
|---|---|---|---|---|
| Pi | `pi-acp`（固定 0.0.34，`ABSENCE_PI_ACP_VERSION` 可改） | `pi-acp` | `ABSENCE_PI_ACP_BIN` | 不需要 |
| Codex | `@zed-industries/codex-acp`（0.16.0，`ABSENCE_CODEX_ACP_VERSION`） | `codex-acp` | `ABSENCE_CODEX_ACP_BIN` | **必须**（`session/new` 之前要 `authenticate`） |
| Codex (ACP, alternative) | `codex-acp`（baldaworks，1.11.0，`ABSENCE_CODEX_ACP_ALT_VERSION`） | 显式路径/覆盖/npx | `ABSENCE_CODEX_ACP_ALT_BIN` | 必须 |
| Claude Code | `@zed-industries/claude-code-acp` | `claude-code-acp` | `ABSENCE_CLAUDE_ACP_BIN` | 可选 |
| Qwen Code | CLI 自带 | `qwen --experimental-acp` | `ABSENCE_QWEN_ACP_BIN` | 可选 |
| Gemini | CLI 自带 | `gemini --acp` | `ABSENCE_GEMINI_ACP_BIN` | 可选 |
| DSH | CLI 自带 | `dsh --profile acp` | `ABSENCE_DSH_BIN`（另有 `ABSENCE_DSH_HOME/PROVIDER/MODEL/PROFILE`） | 不需要 |

Pi 本身不是 ACP server——`pi-acp` 是适配器；Absence 启动的是用户装好的那个，
绝不自己下载。

## 自定义 ACP 入口（选择器里的 "+"）

方格布局的最后一个格子永远是 **"+"**：填入 label、command、args（一行一个）、
env（`KEY=VALUE` 一行一个）、cwd，即写入 `~/.absence/agents.json` 的 `agents` 数组。
任何会说 ACP 的可执行文件都能这样接入，不需要改代码。选择器里也可以直接改任意
profile 的 launch line（存为覆盖，清空即还原）。

## 认证由 agent 处理

- 登录方法来自 `initialize` 返回的 `authMethods`，展示在命令面板；
- `/auth <methodId>` 调 ACP 的 `authenticate`，结果由 agent 自己持久化；
- Absence 不读 token、不代填凭据、不代理 OAuth 流程。

## 开发辅助

- `npm run probe:acp -- <scenario>`：用脚本化 fixture agent 驱动采集管道，打印
  每个 AbsenceEvent；指向真实 agent 用 `ABSENCE_ACP_BIN`。
- `npm run check:agent-catalog`：发现顺序、状态机、"+"格子、注册表行为的验收检查。
- `scripts/acp-fixture/fake-agent.mjs`：讲真协议的假 agent（不需要模型与凭据），
  是上述检查与 `check:acp*` 的驱动对象。
