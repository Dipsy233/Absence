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
  MonitorStage.tsx                  the followed / pinned page, world line, input row
  MonitorRight.tsx                  agent, cost, attention, known files, eggs
  MonitorChat.tsx                   the one-line input row (no expand toggle)
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

**Live follows, a pin stays.** While nothing is pinned the Stage *follows the
agent*: the page is the newest activity of the run (`MonitorData.liveItem`, the
tail of the feed), exactly what Classic's Stage shows. Clicking a row pins that
moment — the pin bar names it and ⏎ (or the pin bar, or a view tab) returns to
following. So the screen moves with the agent until the reader chooses to stop,
and then never changes under them. `currentAction` in the store is deliberately
not the source of this: it is cleared the moment the agent speaks or the run
ends, which used to leave the live Stage on "Waiting for the first activity…"
next to a feed with twenty rows in it.

**The tabs are views of the moment, with an honest fallback.** FILE / DIFF /
TERMINAL read the activity the Stage is on; a kind the moment cannot be read as
falls back to the newest item of that kind in the run, and the header says where
it came from (`· from 00:06`) rather than silently showing another moment. A tab
that is *disabled* under the moment you are looking at is a tab you cannot reach
without waiting for the agent to happen to do that kind of thing again.
METRICS and CHAT are not views of one moment at all: they are pages of their own,
they never raise a pin bar, and leaving them for a view tab returns to following.

**The avatar is a status light.** An 88px tile beside the status, not a banner —
and the tile does not rescale the character. Classic renders the WhaleBun into
an `h-[184px]` box, which is the size the fit, the pose, the props and the idle
animations were authored for; the tile keeps that box and scales the whole thing
with a plain CSS transform, so the animation keeps playing. The earlier version
overrode the fit's own `transform` with `!important` and hid the props and fx,
which is exactly why the character froze and lost its props.

**Agent Folder and Agent Eggs are Classic's panels.** Not a second reading of
the same data: `AgentFolder` and `AgentEggsPanel` already answer "which versions
has it seen", "which process is still running", "show that egg's metrics", and
the rail is the same rail — so they are mounted as-is, each with a real floor
(`min-height: 190px`) so neither collapses.

**Repeats fold.** A `process` event is a state update, not an act: one long-lived
command re-reports every time its child count moves. Fourteen identical RUN rows
is what that looks like unfiltered (a real session produced 94 rows from what
reads as 19 acts). Consecutive identical actions collapse to `RUN ×17`, with the
count saying so. Activity's own list and the Report keep every event.

**Classic's components are reused, not forked.** `StageItemView`,
`MetricsDashboard`, `AgentFolder`, `AgentEggsPanel`, the Markdown renderer and
the chat pieces are written against `--desk-*` tokens; `.mon-root` re-points
those tokens at Monitor's palette, so every reused view lands in this face's
colours with no second implementation.

**One chat input, two faces.** `components/chat/useChatInput.ts` owns the `/`
command state machine (name phase, argument phase, skills, the server-backed
choice lists) and `ChatCommandPalette` / `ChatThread` own the markup; Classic's
dock and Monitor's input row both render those. Monitor's bar has no expand
toggle — the conversation is the Stage's CHAT tab instead — but typing `/` opens
the same overlay above the line, because a command must behave the same wherever
it is typed.

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
| `⏎` | back to following the agent (away from a pinned page) |
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
