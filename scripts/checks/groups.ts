/**
 * The check groups: which acceptance checks belong to which area of code, and
 * which source paths that area owns.
 *
 * This file is the single registration point. A new check script is added
 * here — to one group's `checks` (or `platform`), with its timeout — and every
 * runner (run-group.ts, run-offline.ts) picks it up; nothing else lists
 * scripts. The path globs drive `npm run check:group affected`, so keeping
 * them honest is what makes "run only what changed" work.
 *
 * Groups may overlap (check-views pins logic that lives in report, settings
 * and history files at once); a runner dedupes within one invocation.
 */

export interface CheckEntry {
  /** File name inside scripts/checks/. */
  script: string;
  /** Generous default; raised where a real server is booted. */
  timeout: number;
  /**
   * True when the check needs something CI cannot offer — a kernel observer
   * binary, docker, a pre-started server. Platform checks never run in
   * `check:offline` or in an affected run unless `--all` is passed; they are
   * listed so `run-group list` can remind you they exist.
   */
  platform?: boolean;
}

export interface CheckGroup {
  /** Short id used on the command line: `npm run check:group -- report`. */
  name: string;
  label: string;
  /**
   * Source paths that change what this group tests — repo-relative, forward
   * slashes. `**` spans directories, `*` spans one path segment. A check
   * script's own file also belongs here implicitly: touching the script runs
   * the script.
   */
  paths: string[];
  checks: CheckEntry[];
  /** Checks that exist but need a real machine (kernel, docker, display). */
  platform?: CheckEntry[];
}

export const GROUPS: CheckGroup[] = [
  {
    name: "report",
    label: "事实引擎与报告（buildRunFacts / renderRun / 注意力规则）",
    paths: [
      "apps/web/src/lib/report.ts",
      "apps/web/src/lib/attention.ts",
      "apps/web/src/lib/markdown.ts",
      "apps/web/src/lib/format.ts",
      "apps/web/src/types/report.ts",
      "packages/core/src/events.ts",
    ],
    checks: [
      { script: "check-report.ts", timeout: 60_000 },
      { script: "check-markdown.ts", timeout: 60_000 },
      { script: "check-format.ts", timeout: 60_000 },
    ],
  },
  {
    name: "views",
    label: "face 视图模型（replay 当前行 / 播放态 / feed 折叠 / 成本面板 / 词汇完整性 / viewMode 回退）",
    paths: [
      "apps/web/src/lib/history.ts",
      "apps/web/src/lib/metrics.ts",
      "apps/web/src/lib/viewMode.ts",
      "apps/web/src/ui/shared/**",
      "apps/web/src/types/stage.ts",
    ],
    checks: [{ script: "check-views.ts", timeout: 60_000 }],
  },
  {
    name: "history",
    label: "历史重建与增量（run 分组 / 滑动窗口 / 事件缓存）",
    paths: [
      "apps/web/src/lib/history.ts",
      "apps/web/src/lib/events.ts",
      "apps/web/src/lib/replay.ts",
      "apps/web/src/types/history.ts",
      "packages/core/src/runs.ts",
    ],
    checks: [
      { script: "check-history.ts", timeout: 300_000 },
      { script: "check-incremental.ts", timeout: 180_000 },
    ],
  },
  {
    name: "settings",
    label: "设置与 i18n（阈值归一化 / 语言表完整性）",
    paths: [
      "apps/web/src/stores/settingsStore.ts",
      "apps/web/src/lib/i18n.ts",
      "apps/web/src/lib/attention.ts",
    ],
    checks: [{ script: "check-settings.ts", timeout: 60_000 }],
  },
  {
    name: "chimes",
    label: "声音策略（attentionChimeFor 的分支）",
    paths: ["apps/web/src/lib/sounds.ts"],
    checks: [{ script: "check-chimes.ts", timeout: 60_000 }],
  },
  {
    name: "eggs",
    label: "进程与 eggs（识别 / 分类 / 过滤器 / 外部改动归属）",
    paths: [
      "apps/server/src/process/classify.ts",
      "apps/server/src/process/eggFilter.ts",
      "apps/server/src/process/egg-filters/**",
      "apps/server/src/process/ProcessWatcher.ts",
      "apps/server/src/process/observer.ts",
      "packages/core/src/runs.ts",
    ],
    checks: [
      { script: "check-eggs.ts", timeout: 60_000 },
      { script: "check-classify.ts", timeout: 60_000 },
      { script: "check-outside-attr.ts", timeout: 60_000 },
    ],
    platform: [
      { script: "check-agentwatch.ts", timeout: 120_000, platform: true },
      { script: "check-ebpf.ts", timeout: 120_000, platform: true },
    ],
  },
  {
    name: "metrics",
    label: "指标采样与持久化（环 / 重启 / 区间 / 观察会话寿命）",
    paths: [
      "apps/server/src/process/metricSample.ts",
      "apps/server/src/process/ProcessMetrics.ts",
      "apps/server/src/process/DockerMonitor.ts",
      "apps/server/src/api/metrics.ts",
      "packages/core/src/metrics.ts",
    ],
    checks: [
      { script: "check-metrics.ts", timeout: 120_000 },
      { script: "check-metrics-persist.ts", timeout: 120_000 },
      { script: "check-metrics-ranges.ts", timeout: 60_000 },
      { script: "check-metrics-restart.ts", timeout: 180_000 },
      { script: "check-observed-lifetime.ts", timeout: 180_000 },
    ],
  },
  {
    name: "agent",
    label: "agent 适配层（ACP 契约 / 命令转发 / 观察器契约）",
    paths: ["apps/server/src/agents/**"],
    checks: [
      { script: "check-capability-commands.ts", timeout: 60_000 },
      { script: "check-mcp-events.ts", timeout: 60_000 },
      { script: "check-observer.ts", timeout: 120_000 },
      { script: "check-acp.ts", timeout: 120_000 },
      { script: "check-acp-lifecycle.ts", timeout: 180_000 },
    ],
  },
  {
    name: "session",
    label: "会话与存储（归档 / dwell 时钟 / 关闭 / 生命周期）",
    paths: [
      "apps/server/src/sessions/**",
      "apps/server/src/config.ts",
      "apps/server/src/index.ts",
      "apps/server/src/cli.ts",
      "apps/server/src/desktop-entry.ts",
    ],
    checks: [
      { script: "check-storage.ts", timeout: 120_000 },
      { script: "check-session-dwell.ts", timeout: 180_000 },
      { script: "check-session-close.ts", timeout: 180_000 },
      { script: "check-lifecycle.ts", timeout: 120_000 },
    ],
  },
  {
    name: "io",
    label: "文件与协议（fsdiff 引擎）",
    paths: [
      "apps/server/src/util/diff.ts",
      "apps/server/src/filesystem/**",
      "apps/web/src/lib/events.ts",
    ],
    checks: [
      { script: "check-fsdiff.ts", timeout: 60_000 },
    ],
  },
  {
    name: "pipeline",
    label: "全链路（自启服务器 + mock 会话端到端）",
    paths: ["apps/server/src/**", "apps/web/src/lib/**", "packages/core/src/**"],
    checks: [],
    platform: [{ script: "check-e2e.ts", timeout: 300_000, platform: true }],
  },
  {
    name: "docker",
    label: "docker eggs（需要 docker）",
    paths: ["apps/server/src/process/Docker*.ts"],
    checks: [],
    platform: [
      { script: "check-docker.ts", timeout: 300_000, platform: true },
      { script: "check-docker-eggs.ts", timeout: 300_000, platform: true },
    ],
  },
];

/** Every check script registered anywhere, once, with its timeout. */
export interface RegisteredCheck {
  script: string;
  timeout: number;
  platform: boolean;
  groups: string[];
}

export function allChecks(): RegisteredCheck[] {
  const byScript = new Map<string, RegisteredCheck>();
  for (const group of GROUPS) {
    for (const entry of [...group.checks, ...(group.platform ?? [])]) {
      const existing = byScript.get(entry.script);
      if (existing) {
        if (!existing.groups.includes(group.name)) existing.groups.push(group.name);
        continue;
      }
      byScript.set(entry.script, {
        script: entry.script,
        timeout: entry.timeout,
        platform: entry.platform === true,
        groups: [group.name],
      });
    }
  }
  return [...byScript.values()];
}
