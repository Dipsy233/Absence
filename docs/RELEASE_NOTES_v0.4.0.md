# Release v0.4.0 — Persistence, Metrics and Verification / 持久化、指标与验证

v0.3.0 is the baseline for the runtime integrations: Codex, DSH, shell
takeover, PTY and approval activities. Changes made after that baseline belong
to v0.4.0.

## Highlights

### SQLite session history

- Sessions, events, runs and file versions are stored in SQLite under
  `~/.absence/absence.db` (WAL mode).
- Legacy JSONL archives are imported once and retained as a backup.
- History is indexed incrementally, and historical Activity is loaded by run
  instead of loading an entire session into the browser.
- File versions have their own index, independent of the History view.

### Resource metrics

- CPU and RSS are sampled for the agent's primary eggs and exposed as metrics
  frames over WebSocket.
- The newest 300 frames are kept in the live ring.
- Longer ranges and historical sessions are read from SQLite metric chunks,
  with 30-day retention and session-level averages.
- The right-rail METRICS panel and the full Stage dashboard support selecting an
  egg and viewing `1m`, `5m`, `30m`, `1h` and `all` ranges.
- Exited eggs stop contributing to lifetime averages at their observed exit.

### Stage and state model

- METRICS is now the Stage's default page; FILE, DIFF, TERMINAL and LIVE are
  content views, while replay remains event-and-snapshot based.
- Incremental folding keeps eggs, History and Activity correct as the live event
  window slides, without rebuilding the whole window for every event.
- Agent file views preserve gaps in unread line ranges and can switch between
  distinct recorded versions of the same path.

### Verification

- `npm run verify` is the complete local gate: workspace typechecks, the
  production Web build and every offline acceptance check.
- Offline coverage now includes metrics storage, incremental folding and
  outside-change attribution.
- The live mock History check covers 80 assertions, including pagination,
  replay, the Metrics default page, file gaps and version switching.
- The desktop server bundle and standalone server lifecycle are also validated
  by dedicated checks.

## Upgrade notes

- Restart the server and hard-refresh the browser after updating.
- SQLite is provided by Node's built-in `node:sqlite`; use Node `>=22.19` as
  required by `package.json` and `.nvmrc`.
- Existing JSONL archives are imported automatically on first access.
- Keep `ABSENCE_STATE_DIR` on a filesystem that supports SQLite WAL, and do not
  point two concurrently running instances at the same database.

## 文档

- [README](../README.md) / [中文 README](../README.zh-CN.md)
- [Architecture](ARCHITECTURE.md) / [架构说明](ARCHITECTURE.zh-CN.md)
- [Testing](TESTING.md) / [测试说明](TESTING.zh-CN.md)

---

## 中文摘要

v0.3.0 作为运行时集成基线，包含 Codex、DSH、shell 接管、PTY 和审批
activity。其后的改动统一归入 v0.4.0。

- 会话、事件、运行记录和文件版本迁移到 SQLite，支持增量 History、分页和
  按运行加载 Activity。
- 新增 Agent/egg CPU 与 RSS 资源指标，支持实时看板、历史曲线、session
  平均值和 30 天保留。
- Stage 默认页改为 METRICS；文件视图保留未读行缺口，并支持同一路径的版本
  切换。
- 增量状态折叠保证滑动事件窗口下 Eggs、History、Activity 不丢失。
- 新增 `npm run verify`，统一执行类型检查、生产构建和离线验收。
