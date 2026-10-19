import { useMemo } from "react";
import { useSettingsStore } from "../stores/settingsStore";

/* ══════════════════════════════════════════════════════════════════════════
   UI language (read02 §4). English is the source: every key *is* the English
   string, so a missing translation falls through to readable English instead
   of a bare key. Chinese lives in ZH below.

   `t` also substitutes `{name}` placeholders, so parametrised sentences keep
   one key per sentence:
       t("run #{index}", { index: 3 })  →  "运行 #3"
   ══════════════════════════════════════════════════════════════════════════ */

export type Lang = "en" | "zh";

/** The languages the Settings dialog offers, with their own native labels. */
export const LANGUAGES: Array<{ id: Lang; label: string }> = [
  { id: "en", label: "English" },
  { id: "zh", label: "中文" },
];

const ZH: Record<string, string> = {
  // ── Session bar ────────────────────────────────────────────────────────
  "Float the desk over the Stage's content page as a translucent ghost":
    "把桌面世界以半透明幽灵浮在 Stage 内容页上",
  "degraded · mock": "降级 · 模拟",
  live: "在线",
  offline: "离线",
  model: "模型",
  "context usage": "上下文用量",
  settings: "设置",
  Settings: "设置",
  change: "更换项目",
  "Close this session and pick another project": "关闭当前会话并选择其他项目",

  // ── Stage toolbar ──────────────────────────────────────────────────────
  FILE: "文件",
  DIFF: "差异",
  REPLAY: "回放",
  TERMINAL: "终端",
  LIVE: "实时",
  TABLE: "桌面",
  AGENT: "智能体",
  "The whole file you opened from the project tree": "你在项目树里打开的完整文件",
  "Back to the agent — the default page": "回到智能体——默认页",
  "Back to the desk — the default page": "回到桌面——默认页",
  "The content the agent has in context": "智能体上下文里的内容",

  // ── Stage chips / empty ────────────────────────────────────────────────
  "● LIVE": "● 实时",
  "◇ OBSERVING": "◇ 观察中",
  "Absence is observing this process; it never drives or stops it":
    "发呆症正在观察此进程;它从不驱动或终止它",
  "Press ▶ to replay this run.": "按 ▶ 回放这次运行。",

  // ── Desk captions ──────────────────────────────────────────────────────
  "Watching {label} work. Its terminal is the one to type in.": "正在观察 {label} 干活。要输入请到它的终端。",
  "Watching {label} — nothing it started is running.": "正在观察 {label} ——它启动的东西都没有在运行。",
  "The agent is working…": "智能体正在干活…",
  "The agent is listening.": "智能体在听。",

  // ── Replay bar ─────────────────────────────────────────────────────────
  replay: "回放",
  "Step backward": "后退一步",
  Pause: "暂停",
  Play: "播放",
  "Jump to the end": "跳到结尾",
  "Step forward": "前进一步",
  "Leave replay": "退出回放",
  "back to live": "回到实时",
  "Replay position": "回放进度",

  // ── Chat ───────────────────────────────────────────────────────────────
  Chat: "对话",
  "▼ collapse": "▼ 收起",
  "▲ expand": "▲ 展开",
  "Collapse the history": "收起历史",
  "Expand the full history": "展开完整历史",
  "Ask the agent to do something, or type <slash> for commands. Attach context from Files, Activity or a selection.":
    "让智能体做点什么,或输入 <slash> 使用命令。可从文件、动态或选区附加上下文。",
  You: "你",
  Agent: "智能体",
  observing: "观察中",
  "Absence is watching this agent's terminal. Prompt it there — here it only shows what it does.":
    "发呆症正在观察这个智能体的终端。请在那边对它说话——这里只展示它做的事。",
  context: "上下文",
  "loading…": "加载中…",
  "no options": "无选项",
  "— press Enter to run": "——按回车执行",
  "Commands — type / and pick one": "命令——输入 / 并选择一个",
  "▾ hide": "▾ 隐藏",
  "▴ chat": "▴ 对话",
  "Hide the conversation — keep just the input row": "收起对话,只留输入行",
  "Show the conversation": "展开对话",
  "type a command…": "输入命令…",
  "Ask the agent…": "问智能体…",
  "connecting…": "连接中…",
  Run: "运行",
  Stop: "停止",
  Send: "发送",

  // ── Activity ───────────────────────────────────────────────────────────
  Activity: "动态",
  "▶ replay": "▶ 回放",
  "Replay run #{index}": "回放运行 #{index}",
  "Nothing to replay": "没有可回放的内容",
  "run #{index}": "运行 #{index}",
  "Nothing yet. An observed agent's processes and file changes appear here as they happen.":
    "暂无内容。被观察智能体的进程和文件变更会在这里实时出现。",
  "Nothing yet. Send the agent a task.": "暂无内容。给智能体安排个任务。",
  "Scrub to this event": "拖动到此事件",
  "Open in Stage": "在 Stage 打开",
  "Add event to Chat": "把事件加入对话",

  // ── Activity action words (lib/events.ts) ─────────────────────────────
  THINK: "思考",
  READ: "读取",
  WRITE: "写入",
  EDIT: "编辑",
  RUN: "运行",
  SEARCH: "搜索",
  EMPTIED: "清空",
  "APPROVE?": "审批?",
  START: "开始",
  END: "结束",
  ERROR: "错误",
  LAID: "产蛋",
  DIED: "退出",

  // ── History ────────────────────────────────────────────────────────────
  History: "历史",
  "{n} runs": "{n} 次运行",
  running: "运行中",
  done: "完成",
  stopped: "已停止",
  error: "出错",
  partial: "不完整",
  "The beginning of this run is no longer in the live event window — its counts and the Stage cover only what is still loaded.":
    "这次运行的开头已不在实时事件窗口内——计数和 Stage 只覆盖仍加载的部分。",
  "No runs yet. A run starts when the observed agent does.": "还没有运行。被观察的智能体开始工作时,一次运行就开始了。",
  "No runs yet. Send the agent a task.": "还没有运行。给智能体安排个任务。",
  "files read": "读取文件",
  searches: "搜索",
  "files edited": "编辑文件",
  "files created": "创建文件",
  "commands run": "运行命令",

  // ── Files ──────────────────────────────────────────────────────────────
  Files: "文件",
  inspect: "查看",
  "{n} seen": "已见 {n} 个",
  "Loading project…": "正在加载项目…",
  Inspect: "查看",
  "View History": "查看历史",
  "View Diff": "查看差异",
  "Add file to Chat": "把文件加入对话",
  "Explain this": "解释这个文件",
  "{rel} · open in Stage": "{rel} · 在 Stage 打开",
  "not seen yet": "还没见过",
  "v{v} · edited {ago}": "v{v} · 编辑于 {ago}",
  "// (the agent has not read this file yet)": "//(智能体还没有读过这个文件)",
  "Add to Chat": "加入对话",
  "last edits": "最近修改",
  "{path} · history": "{path} · 历史",
  "{n} versions": "{n} 个版本",
  "No versions yet — the agent has not written to this file.": "还没有版本——智能体没写过这个文件。",
  "← current": "← 当前",
  "no previous version": "没有上一个版本",
  "Open Diff in Stage": "在 Stage 打开差异",

  // ── Agent panel / folder / eggs ────────────────────────────────────────
  "Agent (WhaleBun)": "智能体(WhaleBun)",
  "Agent Folder": "智能体文件夹",
  "Agent Eggs": "进程蛋",
  "{n} known": "已知 {n} 个",
  "The agent has not touched anything yet. Files appear here as it reads and edits them.":
    "智能体还没碰过任何文件。它读取和编辑的文件会出现在这里。",
  "Hide versions": "收起版本",
  "Show versions": "展开版本",
  "{path} · show the newest agent-known content": "{path} · 显示智能体所知的最新内容",
  "Show v{v} on the Stage": "在 Stage 显示 v{v}",
  "whole file": "完整文件",
  "lines {a}–{b}": "第 {a}–{b} 行",
  "{r}/{a} running": "{r}/{a} 运行中",
  none: "无",
  dead: "已退出",
  all: "全部",
  "search name, command, pid…": "搜索名称、命令、pid…",
  "No eggs yet. An egg is a process the agent left running — a dev server, a watcher.":
    "还没有蛋。蛋是智能体留下的、还在运行的进程——比如 dev server、watcher。",
  "No eggs match \"{q}\".": "没有匹配 “{q}” 的蛋。",
  "Nothing here. Try another filter.": "这里什么都没有。换个筛选试试。",
  "Open pid {n} on the Stage": "在 Stage 打开 pid {n}",
  "running for": "已运行",
  lived: "存活了",
  "+{n} children": "+{n} 个子进程",
  "folded {n} helpers: {names} ({r} still running)": "折叠了 {n} 个辅助进程:{names}(仍有 {r} 个在运行)",
  "folded {n} helpers: {names}": "折叠了 {n} 个辅助进程:{names}",
  "folded {n} helpers ({r} still running)": "折叠了 {n} 个辅助进程(仍有 {r} 个在运行)",
  "folded {n} helpers": "折叠了 {n} 个辅助进程",
  "{n} older finished processes folded": "{n} 个更早结束的进程已折叠",
  "Older finished processes were retired from this list to keep it bounded. Running ones are always shown. They remain in the session archive and the Report.":
    "更早结束的进程已从列表淘汰以控制长度。运行中的始终显示。它们仍在会话存档和报告里。",

  // ── Agent status words ─────────────────────────────────────────────────
  idle: "空闲",
  thinking: "思考中",
  reading: "读取中",
  searching: "搜索中",
  editing: "编辑中",
  waiting: "等待中",
  speaking: "发言中",
  confused: "困惑",

  // ── Project picker ─────────────────────────────────────────────────────
  "AI moves fast. Humans watch. Choose a project and let the agent work.":
    "AI 快速运转,人类静静旁观。选一个项目,让智能体开工。",
  "project path": "项目路径",
  "opening…": "打开中…",
  Open: "打开",
  "{n} sessions": "{n} 个会话",
  "No saved sessions for this path.": "此路径没有已保存的会话。",
  "No saved sessions yet — open a project to start one.": "还没有保存的会话——打开一个项目就开始。",
  "Resume {id}": "恢复 {id}",
  "· {n} msgs": "· {n} 条消息",
  runtime: "运行时",
  "A green dot means the runtime was found. A red dot means it is not installed (or the path is wrong) — fix it below before opening.":
    "绿点表示找到了该运行时;红点表示未安装(或路径不对)——请先在下方修正再打开。",
  "runtime paths": "运行时路径",
  "{label} path": "{label} 路径",
  found: "已找到",
  "not found": "未找到",
  "saving…": "保存中…",
  "save paths": "保存路径",
  recent: "最近",

  // ── Report ─────────────────────────────────────────────────────────────
  "ABSENCE REPORT": "发呆报告",
  "Collapse the Absence Report": "收起发呆报告",
  "Expand the Absence Report": "展开发呆报告",
  "Absence Report": "发呆报告",
  Timeline: "时间线",
  "duration {time}": "耗时 {time}",
  "click for the specifics": "点击看细节",
  "✕ close": "✕ 关闭",
  "Nothing to report yet — send the agent a task.": "还没有可报告的——给智能体安排个任务。",
  Evidence: "证据",
  "Close the evidence view": "关闭证据视图",
  "No preview for a {type} event.": "{type} 事件没有预览。",
  Progress: "进展",
  Request: "请求",
  Knows: "已知",
  read: "读取",
  searched: "搜索",
  "Show in Activity — {path}": "在动态里显示——{path}",
  "Show in Activity": "在动态里显示",
  "{n} hits": "{n} 个命中",
  Changes: "变更",
  "No files changed.": "没有文件变更。",
  "+{n} changed": "+{n} 处变更",
  "{n} observed": "{n} 处观察",
  "{n} deleted": "{n} 处删除",
  "+{a} / −{d} lines": "+{a} / −{d} 行",
  modified: "修改",
  created: "创建",
  deleted: "删除",
  observed: "观察",
  Executions: "执行",
  "No commands run.": "没有运行过命令。",
  "{n} commands · {s} succeeded · {f} failed · {u} unknown": "运行 {n} 条命令 · {s} 成功 · {f} 失败 · {u} 未知",
  "{n} recoveries detected — a command failed, then the agent continued successfully.":
    "检测到 {n} 次恢复——某条命令失败后,智能体成功继续。",
  "{n} calls to {m} servers · {f} failed": "对 {m} 个服务器发起 {n} 次调用 · {f} 次失败",
  "{n} calls to {m} servers": "对 {m} 个服务器发起 {n} 次调用",
  "{n} calls · {f} failed": "{n} 次调用 · {f} 次失败",
  "{n} calls": "{n} 次调用",
  "Outside the project": "项目之外",
  Response: "回复",
  "(no reply)": "(没有回复)",
  "{n} activities · scroll → · click a node for the specifics": "{n} 个活动 · 滚动查看 → · 点击节点看细节",
  "Human attention": "需要人留意的",
  "Agent is working normally.": "智能体运行正常。",
  "exit {code}": "退出码 {code}",
  failed: "失败",
  // attention levels
  low: "低",
  high: "高",
  // attention reasons
  "A command failed": "有命令失败",
  "Commands failed back-to-back — the agent may be flailing": "命令接连失败——智能体可能在乱撞",
  "No activity for a long time — something may be stuck": "长时间没有活动——可能卡住了",
  "Unresolved error — no successful recovery detected": "未解决的错误——没有检测到成功恢复",
  "Agent is waiting": "智能体在等待",
  "Agent stopped": "智能体停了",
  "No progress detected": "没有检测到进展",
  "External file change observed": "观察到外部文件变更",
  "A process the agent started is still running": "智能体启动的进程还在运行",
  "A file outside the project was changed": "项目外的文件被改动了",
  "File versions oscillated — the agent may have undone its own edit": "文件版本来回摆动——智能体可能撤销了自己的编辑",
  "The same command failed repeatedly": "同一条命令反复失败",
  // live phases (lib/report buildPhases)
  investigating: "调查中",
  implementing: "实现中",
  recovering: "恢复中",
  verifying: "验证中",
  executing: "执行中",
  // run outcomes (lib/report outcomeFor, `_` → space before t())
  completed: "完成",
  "completed with warnings": "完成(有警告)",
  "no change": "无变更",
  // command effects
  "process still running": "进程仍在运行",

  // ── Stage item views ───────────────────────────────────────────────────
  ok: "成功",
  text: "文本",
  json: "json",
  "Toggle the server's structured (JSON) result": "切换服务器的结构化(JSON)结果",
  "copy cmd": "复制命令",
  "copy out": "复制输出",
  copied: "已复制",
  "Copy the command": "复制命令",
  "Copy the output": "复制输出",
  "+ Chat": "+ 对话",
  "Add this command to Chat": "把这条命令加入对话",
  "Add this file to Chat": "把这个文件加入对话",
  "Add this diff to Chat": "把这个差异加入对话",
  "Add this to Chat": "把这个加入对话",
  "Add this process to Chat": "把这个进程加入对话",
  "Add this approval to Chat": "把这个审批加入对话",
  "Add selection to Chat": "把选区加入对话",
  "loading editor…": "编辑器加载中…",
  "(no output)": "(无输出)",
  "Agent removed all content — the file still exists on disk.": "智能体清空了全部内容——文件仍在磁盘上。",
  "Agent edited {path}": "智能体编辑了 {path}",
  "{n} chars": "{n} 字符",
  "(thinking…)": "(思考中…)",
  exited: "已退出",
  "(no command line)": "(无命令行)",
  "laid by {cmd}": "由 {cmd} 产出",
  "the agent is waiting": "智能体正在等待",
  "answered: {value}": "已回答:{value}",

  // ── Window controls / context chip ─────────────────────────────────────
  Minimize: "最小化",
  Restore: "还原",
  Maximize: "最大化",
  "Close (hides to tray)": "关闭(隐藏到托盘)",
  "Remove context": "移除上下文",
  Back: "返回",

  // ── Settings dialog ────────────────────────────────────────────────────
  APPEARANCE: "外观",
  "Language · 语言": "Language · 语言",
  "Color theme": "颜色主题",
  "collapse on content": "内容页自动折叠",
  "fold the chat history away whenever the Stage shows a file, diff, terminal or the report. Off (the default) keeps the chat exactly as you left it.":
    "当 Stage 显示文件、差异、终端或报告时,自动收起对话历史。关闭(默认)时对话保持原样。",
  "Left rail panel order": "左侧栏面板顺序",
  "Right rail panel order": "右侧栏面板顺序",
  "Move up": "上移",
  "Move down": "下移",
  "REPORT WARN": "报告提醒",
  "command failed per run": "单次运行失败命令数",
  "attention level": "提醒级别",
  silent: "关闭",
  "failure streak": "连续失败",
  "consecutive failed": "连续失败次数",
  "activity time": "活动时间",
  "no activity for (seconds)": "无活动时长(秒)",
  "The Absence Report raises <code> once this many commands have failed in one run, <streak> once this many failed back-to-back, and <stall> once no event has arrived for this many seconds; unresolved failures always stay high.":
    "发呆报告在单次运行中失败命令达到该数量时提出 <code>,在连续失败达到该数量时提出 <streak>,在超过该秒数没有任何事件时提出 <stall>;未解决的失败始终是高等级。",
  "EGGS FILTER": "进程蛋筛选",
  "Command names the classifier treats as helpers, one per line. Profiles live in <dir> Create a profile with the sidebar's <+> (an empty file lands in the editor), fill it in, then Apply saves and activates it. Same name overwrites.":
    "分类器视为辅助工具的命令名,每行一个。配置文件保存在 <dir> 用侧栏的 <+> 新建(空文件直接进入编辑器),填好后点 Apply 保存并启用。同名覆盖。",
  saved: "已保存",
  "none yet": "暂无",
  "new name": "新名称",
  "Create an empty profile and load it into the editor": "新建一个空配置并载入编辑器",
  "editing:": "编辑:",
  "content (one command name per line)": "内容(每行一个命令名)",
  force: "强制",
  "also filter a listed name when it is the command's declared subject": "当列出的名字是命令声明的主体时(如 node ticker.mjs)也过滤",
  "Also filter a listed name when it is the command's declared subject (e.g. node ticker.mjs). A process that outlived its command stays visible either way.":
    "当列出的名字是命令声明的主体时(如 node ticker.mjs)也过滤。活得比命令久的进程无论如何都会显示。",
  "display in activity": "在动态中显示",
  "show LAID / DIED process events in Activity": "在动态中显示产蛋/退出进程事件",
  "Show LAID / DIED process events in the Activity panel. Off hides them so the panel reads as actions only; the eggs stay visible in the Agent Eggs panel either way.":
    "在动态面板显示产蛋/退出进程事件。关闭时隐藏,面板只显示动作;蛋无论如何都在进程蛋面板里可见。",
  "failed to load profiles": "配置加载失败",
  "select or create a profile first": "请先选择或新建一个配置",
  "saved & applied ✓ ({n} names)": "已保存并启用 ✓({n} 个名字)",
  "save failed": "保存失败",
  "created \"{name}\" — edit names, then Apply": "已创建 “{name}”——编辑名字后点 Apply",
  "create failed": "创建失败",
  "activated \"{name}\"": "已启用 “{name}”",
  "activate failed": "启用失败",
  "Delete profile \"{name}\"?": "删除配置 “{name}”?",
  "deleted \"{name}\"": "已删除 “{name}”",
  "delete failed": "删除失败",
  Apply: "应用",
  "Save the profile (overwrite if the name exists, create otherwise) and activate it":
    "保存配置(同名覆盖,否则新建)并启用",
  // sound pane
  SOUNDS: "音效",
  "attention · med": "提醒 · 中",
  "attention · high": "提醒 · 高",
  complete: "完成",
  approval: "审批",
  "failed to load sound sets": "音效集加载失败",
  "created \"{name}\" — upload files below": "已创建 “{name}”——在下面上传文件",
  "applied \"{name}\" ✓": "已应用 “{name}” ✓",
  "restored the default chimes ✓": "已恢复默认铃声 ✓",
  "apply failed": "应用失败",
  "unsupported file type (use mp3/wav/ogg/m4a/flac/webm)": "不支持的文件类型(请用 mp3/wav/ogg/m4a/flac/webm)",
  "upload failed": "上传失败",
  "preview failed (unsupported audio?)": "预览失败(音频格式不支持?)",
  "no custom file — the default chime rings": "没有自定义文件——响起默认铃声",
  "Delete sound set \"{name}\" and its files?": "删除音效集 “{name}” 及其文件?",
  "clear failed": "清除失败",
  "The built-in synthesised chimes": "内置合成铃声",
  "Create a sound-set folder": "新建音效集文件夹",
  "SOUND SETS": "音效集",
  sets: "音效集",
  "Pick an event, upload an audio file (mp3 / wav / ogg / m4a) and it replaces that chime. Events without a file keep the built-in tone. Files are stored in": "选一个事件,上传音频文件(mp3 / wav / ogg / m4a)即可替换对应铃声。没有上传文件的事件沿用内置音色。文件保存在",
  "cleared {event}": "已清除 {event}",
  "Preview {event}": "预览 {event}",
  "Clear {event}": "清除 {event}",
  "Upload a file for {event}": "为 {event} 上传文件",
  upload: "上传",
  "uploading…": "上传中…",
  "applying…": "应用中…",
  "Use \"{name}\" as the app’s chimes": "把 “{name}” 设为应用的铃声",
  // avatar skin pane
  "AVATAR SKIN": "头像皮肤",
  "failed to load skins": "皮肤加载失败",
  skins: "皮肤",
  "The built-in HTML character": "内置网页角色",
  "Create a skin folder": "新建皮肤文件夹",
  "Pick a status, upload a file (mp4 / gif / png / webp / svg) and it becomes that status's animation. Files are stored in": "选一个状态,上传文件(mp4 / gif / png / webp / svg)即可作为该状态的动画。文件保存在",
  "Use \"{name}\" as the agent’s avatar": "把 “{name}” 设为智能体的头像",
  default: "默认",
  listening: "聆听中",
  "restored {name} ✓": "已恢复 {name} ✓",
  "unsupported file type (use png/gif/jpg/webp/svg/mp4/webm/mov)": "不支持的文件类型(请用 png/gif/jpg/webp/svg/mp4/webm/mov)",
  "A name for the new skin (files go into <avatar-skins>/<name>/):": "新皮肤的名字(文件放在 <avatar-skins>/<名字>/ 下):",
  "A name for the new sound set (files go into <sound-sets>/<name>/):": "新音效集的名字(文件放在 <sound-sets>/<名字>/ 下):",
  "Delete skin \"{name}\" and its files?": "删除皮肤 “{name}” 及其文件?",
};

/** Substitute `{name}` placeholders in a (possibly already translated) string. */
function substitute(text: string, params?: Record<string, string | number>): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match,
  );
}

export type Translate = (key: string, params?: Record<string, string | number>) => string;

/**
 * A reactive `t` for the component's language: re-renders when the user
 * switches language in Settings. English is the identity (with placeholder
 * substitution), Chinese looks the string up in ZH and falls back to English.
 */
export function useT(): Translate {
  const lang = useSettingsStore((s) => s.language);
  return useMemo<Translate>(() => {
    if (lang !== "zh") return (key, params) => substitute(key, params);
    return (key, params) => substitute(ZH[key] ?? key, params);
  }, [lang]);
}

/** Non-reactive lookup for non-component code (rare; prefer useT). */
export function translate(key: string, params?: Record<string, string | number>): string {
  const lang = useSettingsStore.getState().language;
  return substitute(lang === "zh" ? (ZH[key] ?? key) : key, params);
}
