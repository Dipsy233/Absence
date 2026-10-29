# UI faces

Absence shows one thing — an agent at work — but the right *shape* for that
depends on why you are looking. This branch splits the interface into four
named faces plus the pre-split one.

| Face | 中文 | For | Shape |
|---|---|---|---|
| **Rounds** | 查房陪诊 | following the agent around | light; the avatar leads |
| **Monitor** | 机器监护 | supervising, reading traces | heavy; information leads |
| **Chart** | 病历报告 | the run is over | the report is the whole page |
| **Drip** | 输液 | you are doing something else | a floating card, always on top |
| **Classic** | 旧版 | the pre-split layout | three equal rails + the desk world |

`Monitor` is built. The others are declared and their buttons are disabled, so a
stale `localStorage` value can never leave the app blank (see
`lib/viewMode.ts` — `viewModeSpec(mode).ready`).

## Where things live

```
apps/web/src/lib/viewMode.ts        the four names, their intent, readiness
apps/web/src/stores/viewModeStore.ts  which one is showing (persisted)
apps/web/src/ui/monitor/            the Monitor face
  monitor.css                       its own --mon-* palette, scoped under .mon-root
  useMonitorData.ts                 the one derivation everything draws from
  atoms.tsx                         tone vocabulary, chips, sparkline, words
  MonitorLeft.tsx                   run selector + activity feed (or the project tree)
  MonitorStage.tsx                  the pinned page, world line, input row
  MonitorRight.tsx                  agent, cost, attention, known files, eggs
  MonitorChat.tsx                   the one-line input row
  MonitorUI.tsx                     header, columns, keyboard contract
```

`App.tsx` picks the face and owns the socket and the chimes, so switching faces
never drops the connection or re-rings a run's chimes.

## Monitor's decisions

**One derivation.** `useMonitorData` is the only place that builds run facts. The
phase headers in the feed, the attention chip in the header and the rail all read
the same object, so they cannot disagree about a run. `buildRunFacts` walks the
whole run, so it is clamped to twice a second: a streamed token updates the feed
immediately (rows are incremental — `memoRunRows`) while the phase verdict lags at
most 500 ms.

**A page is a pin.** Live, the Stage shows what the agent last touched. Clicking a
row pins it and the pin bar states which activity everything is looking at, with
⏎ to go back. A screen never silently changes under the reader. The tabs are ways
*to* a page, never toggles away from one.

**The avatar is a status light.** A 74px head-shot, not the whole character. The
WhaleBun fits all of itself into whatever box it gets, which at 74px is a blob —
so the tile overrides the fit with its own transform to frame the head (see the
note in `monitor.css`). Pose still follows the event stream; it is just no longer
the subject.

**Repeats fold.** A `process` event is a state update, not an act: one long-lived
command re-reports every time its child count moves. Fourteen identical RUN rows
is what that looks like unfiltered (a real session produced 94 rows from what
reads as 19 acts). Consecutive identical actions collapse to `RUN ×17`, with the
count saying so. Activity's own list and the Report keep every event.

**Classic's components are reused, not forked.** `StageItemView`,
`MetricsDashboard` and the Markdown renderer are written against `--desk-*`
tokens; `.mon-root` re-points those tokens at Monitor's palette, so every reused
view lands in this face's colours with no second implementation.

**Two Files views, on purpose.** The right rail is the *agent's* files (only what
it has read, per version). The left column's Files tab is the whole project, read
from disk. Losing the second one would have made the project tree unreachable in
this face.

## Health floor

Written into `monitor.css`, not left to each component:

- every text token clears 4.5:1 on its surface (`--mon-t3` is 5.9:1 on `--mon-s1`);
  the kind colours are all ≥5.5:1, so an 11px tag is readable
- `:focus-visible` has a ring — `outline: none` never stands alone
- `prefers-reduced-motion` stops every animation, including the avatar's
- fixed sizes for chrome (chip 22px, button 28px) instead of 9px type
- CJK falls back through `PingFang SC` / `Microsoft YaHei` / `Noto Sans SC`

## Keyboard

| Key | Action |
|---|---|
| `⏎` | back to live (away from a pinned page) |
| `⌘R` / `Ctrl+R` | open / close the Absence Report |
| `Esc` | closes the Report and the context menu |

## Adding a face

1. `lib/viewMode.ts`: flip `ready: true` and write the intent line.
2. `ui/<face>/`: build it against `useMonitorData` (or a sibling hook) — the
   stores, the socket and the sounds are already wired.
3. `App.tsx`: add the branch before the Classic fallback.
4. Give it a `base` in `index.html`-level CSS only if it needs its own palette;
   scoping under one root class is what keeps the faces from leaking into each
   other. Monitor's bridge shows how to reuse Classic's views without that.
