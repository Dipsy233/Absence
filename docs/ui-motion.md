# Motion

[English](ui-motion.md) | [简体中文](ui-motion.zh-CN.md)

This document describes the motion layer of `apps/web`: what drives each animation, the cadence it plays at, the motion grammar of the three UI styles, and the audit and improvements applied to the motion layer. It does not change the interface structure described in [ui-faces.md](ui-faces.md), nor the style and scheme dimensions defined in [ui-style-interface.md](ui-style-interface.md).

## Implementation status

The P0–P2 items are implemented. Section 1 records the pre-change audit and keeps its original findings. Two deviations from the original plan:

- **The status bubble keeps its blur.** P0-5 proposed removing `backdrop-filter` from both windows and bubbles, while [ui-style-interface.md](ui-style-interface.md) lists the frosted top bar and status bubble as a Glass signature. The implemented split: nixie/ink windows (85–92% opaque surfaces) have no blur; Glass windows keep it (their `--mon-win` is 6% white) and drop it while dragging.
- **Ink boil has no per-card visibility gate.** A per-card gate would couple the shared `InkBoil` source to Rounds' card class. The seed step moved from 250ms to 333ms (on-threes); any further visibility gating depends on profiler data.

## Audit conclusion

The motion foundation has these properties:

- `apps/web/src/lib/anim.ts` provides closed-form damped springs (`spring` / `springV` / `pop`) and `tween`, with no animation dependency.
- The codebase contains no `transition: all` and no `scale(0)` entrance.
- The context menu, the Activity feed, keyboard actions and per-event counters do not animate. High-frequency surfaces stay still.
- The global stop policy for `prefers-reduced-motion` is specified in [ui-style-interface.md](ui-style-interface.md) (rule 7) and remains in effect.

The pre-change audit grouped the problems into four areas:

1. **Per-frame main-thread paths**: Rounds window drag/resize called `setState` every frame; DiffStage had a framer-motion entrance; FaceRise wrote styles from rAF while the whole face mounted.
2. **Decorative motion on high-frequency surfaces**: Nixie replayed a 500ms scramble on every value change; DiffStage swept a 1s light on every remount; infinite `box-shadow` pulses.
3. **No shared style grammar**: the page entrance (`mon-flick`), notice entrance (`att-in`) and DiffStage entrance played the same motion under Nixie, Ink and Glass. Ink card hover was also overridden by the theme's tilt rule.
4. **No motion tokens**: durations and curves were hand-typed as `0.12s` / `0.14s` / `0.16s` / `0.18s` / `0.5s`, with no reusable entrance primitive.

## 1. Pre-change inventory

| Motion | Location | Driver | Properties | Frequency | Handling |
|---|---|---|---|---|---|
| Face entrance | [FaceRise.tsx](../apps/web/src/ui/shared/FaceRise.tsx#L15-L30) | JS rAF | `opacity` / `transform` | per face switch | Keep the intent; move to CSS |
| Nixie settle | [Nixie.tsx](../apps/web/src/ui/shared/Nixie.tsx#L105-L126) | JS rAF | `textContent` | every value change | Throttle and quantize to 15fps |
| Page power-on `mon-flick` | [shared.css](../apps/web/src/ui/shared/shared.css#L605-L631) | CSS | `opacity` | page switch | Keep; scope to Nixie |
| Ink line boil | [InkBoil.tsx](../apps/web/src/ui/shared/InkBoil.tsx#L24-L34) | `setInterval` 250ms | SVG filter seed | continuous (Ink) | Lower the rate; limit to visible cards |
| Ink drops | [themes.css](../apps/web/src/ui/shared/themes.css#L558-L605) | CSS | `transform` / `border-radius` / `box-shadow` | state change + continuous | Move the bleed to a pseudo-element |
| Nixie power ripple | [themes.css](../apps/web/src/ui/shared/themes.css#L209-L251) | CSS | `transform` / `opacity` | while the agent runs | Keep (composited) |
| Ambient drift | [shared.css](../apps/web/src/ui/shared/shared.css#L531-L562), [rounds.css](../apps/web/src/ui/rounds/rounds.css#L32-L51) | CSS | `transform` | continuous | Keep; frosted layers resample it every frame |
| WhaleBun character | [whalebun.css](../apps/web/src/components/agent/whalebun.css#L78-L267) | CSS | `transform` / `opacity` | continuous | Keep; re-check `will-change` |
| Notice entrance | [attention.css](../apps/web/src/components/attention/attention.css#L66-L76) | CSS | `transform` / `opacity` | occasional | Keep; add stagger and theme grammar |
| Drip unfold/fold | [drip.css](../apps/web/src/ui/drip/drip.css#L620-L651) | CSS keyframes | `transform` / `opacity` | toggle | The fold easing direction was inverted |
| Card hover | [rounds.css](../apps/web/src/ui/rounds/rounds.css#L537-L567) | CSS | `transform` + `box-shadow` | frequent | Remove the `box-shadow` transition |
| Current-card pulse | [rounds.css](../apps/web/src/ui/rounds/rounds.css#L608-L625) | CSS | `box-shadow` | continuous | Move to pseudo-element `opacity` |
| Timeline cursor | [chart.css](../apps/web/src/ui/chart/chart.css#L603-L611), [monitor.css](../apps/web/src/ui/monitor/monitor.css#L623-L631) | CSS | `left` | replay/selection | Move to `transform` |
| Diff entrance and sweep | [DiffStage.tsx](../apps/web/src/components/stage/DiffStage.tsx#L87-L114) | framer-motion | `opacity` / `y` / gradient | every StageItem remount | Remove |
| Window drag/resize | [RoundsWindow.tsx](../apps/web/src/ui/rounds/RoundsWindow.tsx#L46-L68) | React state | `left` / `top` / `width` / `height` | while dragging | Write through refs |
| Drip pill width | [drip.css](../apps/web/src/ui/drip/drip.css#L570-L575) | CSS | `width` | toggle/hover | Keep (no equivalent visual) |
| Glass button sheen | [themes.css](../apps/web/src/ui/shared/themes.css#L882-L900) | CSS | `background-position` | button hover | Move to a pseudo-element `translateX` |

## 2. Motion grammar of the three styles

| Style | Grammar | Avoid |
|---|---|---|
| Nixie | Instrument: numbers roll 3–5 frames then settle; a panel powers on through a 4-frame alpha sequence; movement under 4px; 180ms entrances; settle only on state changes | Long eases, continuous breathing, re-rolling a per-second readout |
| Ink | Hand-drawn: on-twos/on-threes; `clip-path` reveals for drawn edges and paper; slight overshoot (`cubic-bezier(0.2, 0.8, 0.3, 1.3)`); 260ms entrances | Gaussian blur, glassy sheen, linear travel |
| Glass | Slow, translucent: `opacity` + 8px rise + `scale(0.98)`; springs only for the pill and mercury ball; 380–500ms entrances; a crossfade can use `blur(2px)` | Fast moves, bounce, animated blur above 20px |

Shared baseline tokens (overridden per style):

```css
/* shared.css · .mon-root */
--motion-dur-press: 140ms;
--motion-dur-quick: 160ms;
--motion-dur-enter: 220ms;
--motion-dur-exit: 160ms;
--motion-dur-page: 300ms;
--motion-rise: 6px;
--motion-scale: 0.98;
--motion-ease-out: cubic-bezier(0.23, 1, 0.32, 1);
--motion-ease-inout: cubic-bezier(0.77, 0, 0.175, 1);
--motion-ease-snap: cubic-bezier(0.32, 0.72, 0, 1);
```

Style overrides (`themes.css`, following the existing token pattern):

```css
.theme-nixie {
  --motion-dur-enter: 180ms;
  --motion-rise: 4px;
  --motion-scale: 1;
}
.theme-ink {
  --motion-dur-enter: 260ms;
  --motion-rise: 3px;
  --motion-scale: 0.99;
  --motion-ease-out: cubic-bezier(0.2, 0.8, 0.3, 1.3);
}
.theme-glass {
  --motion-dur-enter: 380ms;
  --motion-rise: 8px;
  --motion-scale: 0.98;
  --motion-ease-out: cubic-bezier(0.22, 1, 0.36, 1);
}
```

Frequency gate:

| Frequency | Treatment |
|---|---|
| 100+ times/day (context menu, keyboard, rows inside a tab) | No animation |
| Tens of times/day (buttons, dock, card hover) | 100–160ms feedback only |
| Occasional (face switch, window open, Settings, Drip) | Standard entrance, 180–380ms |
| Rare (first report, run end) | A short settle animation |

## 3. Improvements

### P0-1 Rounds window drag/resize

Location: [RoundsWindow.tsx](../apps/web/src/ui/rounds/RoundsWindow.tsx#L40-L69)

**Before**: dragging a window re-rendered its whole subtree every frame (including Monaco and the file list), and under Glass the `backdrop-filter: blur(14px)` resampled the moving ambient every frame.

**Cause**: `pointermove` called `setPos` / `setDim`, so React scheduled a render per frame; position used `left` / `top`, which are layout properties.

**Change**:

```tsx
const winRef = useRef<HTMLElement | null>(null);
const posRef = useRef(initial);

const move = (event: ReactPointerEvent<HTMLElement>) => {
  if (!drag.current) return;
  const x = Math.min(Math.max(4, drag.current.x + event.clientX - drag.current.px), window.innerWidth - 140);
  const y = Math.min(Math.max(4, drag.current.y + event.clientY - drag.current.py), window.innerHeight - 90);
  posRef.current = { x, y };
  // Write this element's transform only, without a React render
  winRef.current!.style.transform = `translate3d(${x}px, ${y}px, 0)`;
};

const up = () => {
  if (!drag.current) return;
  drag.current = null;
  grow.current = null;
  setPos(posRef.current); // one commit for the next drag or reflow
};
```

The window's base style becomes `left: 0; top: 0`; position lives in `transform` (React writes the same `translate3d(x, y, 0)` inline, and the drag handler overwrites that property through the ref). Dragging sets `data-drag`:

```css
.rounds-win {
  top: 0;
  left: 0;
}
.rounds-win[data-drag="true"] {
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  will-change: transform;
}
```

Resizing has no `transform` equivalent because the content has to reflow, but `winRef.current.style.width/height` is written per frame and committed on release, which avoids re-rendering the subtree.

**Verification**: three Rounds windows, one containing Monaco; five-second drag recordings compare dropped frames and long tasks before and after the change.

### P0-2 Nixie: settle on state changes

Location: [Nixie.tsx](../apps/web/src/ui/shared/Nixie.tsx#L51-L126); call sites [FaceBar.tsx](../apps/web/src/components/layout/FaceBar.tsx#L128-L139), [MonitorLeft.tsx](../apps/web/src/ui/monitor/MonitorLeft.tsx#L290-L301), [DripUI.tsx](../apps/web/src/ui/drip/DripUI.tsx#L238-L255)

**Before**: under Nixie, context usage and the R/S/E/$ counters changed continuously while the agent streamed. Every change restarted a 500ms rAF scramble, and the first 70% rewrote every digit cell each frame. The result was near-permanent per-frame DOM writes and a readout that never stopped flickering.

**Cause**: the settle effect had no frequency gate; `text` was an effect dependency.

**Change**: a minimum interval inside the component; the first mount still plays:

```tsx
const lastSettled = useRef(-Infinity);

// A value that changes right after a settle lands instantly
const canArrive = performance.now() - lastSettled.current > 900;
if (resolved !== "tube" || prefersReducedMotion() || !canArrive) {
  /* write the final value */
  lastSettled.current = performance.now();
  return;
}
```

The scramble is quantized to 15fps with the existing `frameOf`:

```tsx
const frame = frameOf(t / 1000);
if (frame !== lastFrame) {
  lastFrame = frame;
  /* rewrite volatile cells */
}
```

**Verification**: Nixie with a mock agent at full speed; the Performance panel shows no continuous rAF stream, and the readout updates in jumps and does not shimmer.

### P0-3 DiffStage: no framer-motion entrance

Location: [DiffStage.tsx](../apps/web/src/components/stage/DiffStage.tsx#L86-L115)

**Before**: Monitor remounted the Stage with `key={shownItem.id}` ([MonitorStage.tsx](../apps/web/src/ui/monitor/MonitorStage.tsx#L315)), so every new diff replayed a 0.5s `y: 8 → 0` entrance and a 1s sweep on the content being read. It was the only framer-motion usage in the implementation.

**Cause**: an entrance intended for occasional popovers was applied to a high-frequency reading surface; framer-motion v11's `y` shorthand is not guaranteed to be hardware-accelerated (acceleration is guaranteed from motion 14.2), and it competed with data arrival and React mounting.

**Change**: the `motion.div` and the sweep were removed; a 120ms opacity fade avoids a hard cut and adds no translation:

```tsx
<div className="flex h-full min-h-0 flex-col mon-arrive-fade">
```

```css
.mon-arrive-fade {
  animation: mon-fade-in 120ms var(--motion-ease-out) both;
}
@keyframes mon-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
```

`framer-motion` was then removed from `apps/web/package.json`, which also removed a main-thread animation runtime.

**Verification**: several consecutive file edits; the Stage stays readable and does not move; `npm run build` output shrinks.

### P0-4 Infinite `box-shadow` pulses

Location: [rounds.css](../apps/web/src/ui/rounds/rounds.css#L608-L625), [themes.css](../apps/web/src/ui/shared/themes.css#L595-L605)

**Before**: the Rounds current card animated `box-shadow` every 2.6s; every Ink status dot bled with `box-shadow` every 2.2s. `box-shadow` is not composited, so these repainted continuously.

**Change**: a static-shadow pseudo-element carries the glow, and only its `opacity` / `scale` animates:

```css
.rounds-card[data-now="true"] {
  box-shadow: 0 10px 22px rgb(0 0 0 / 0.3);
}
.rounds-card[data-now="true"]::after {
  content: "";
  position: absolute;
  inset: -1px;
  border-radius: inherit;
  box-shadow: 0 0 0 3px rgb(94 159 232 / 0.18);
  opacity: 0.35;
  animation: rounds-nowpulse 2.6s ease-in-out infinite;
  pointer-events: none;
}
@keyframes rounds-nowpulse {
  0%, 100% { opacity: 0.35; }
  50% { opacity: 1; }
}
```

Ink's bleed follows the same pattern (`.mon-dot` gets `position: relative`, a pseudo-element at `inset: -2px`, and `opacity` + `scale(1 → 2.2)`); the existing two-frame `mon-ink-blob` radius remains.

**Verification**: Ink with 20+ Activity rows; the Performance panel shows no per-frame Paint.

### P1-1 Motion tokens and an entrance primitive

The `.mon-root` motion tokens from section 2 and one reusable class were added:

```css
.mon-arrive {
  transition:
    opacity var(--motion-dur-enter) var(--motion-ease-out),
    transform var(--motion-dur-enter) var(--motion-ease-out);
  transition-delay: var(--mon-delay, 0ms);
}
@starting-style {
  .mon-arrive {
    opacity: 0;
    transform: translateY(var(--motion-rise)) scale(var(--motion-scale));
  }
}
```

`@starting-style` is available in Electron 37 (Chromium 138) and the current browser build; it lets mount entrances work without a JS mount flag. `--mon-delay` is used only for group stagger, capped at 240ms, and never blocks interaction.

`apps/web/src/lib/anim.ts` gained a pure helper:

```ts
/** Group entrance stagger: 40ms per item, capped at 240ms. */
export const stagger = (index: number, step = 40, cap = 240): number =>
  Math.min(index * step, cap);
```

### P1-2 Page entrances owned by each style

Location: [FaceRise.tsx](../apps/web/src/ui/shared/FaceRise.tsx#L15-L30), [MonitorStage.tsx](../apps/web/src/ui/monitor/MonitorStage.tsx#L300-L315)

**Before**: FaceRise ran a 560ms JS spring; the Stage page power-on always used `mon-flick`. Both played under all three styles, and `mon-flick` is Nixie's device power-on.

**Change**: FaceRise became a pure CSS class, which removed the rAF competition while the face mounts, and page arrival is decided by the theme:

```css
.mon-pagein {
  animation: mon-rise var(--motion-dur-enter) var(--motion-ease-out) both;
}
@keyframes mon-rise {
  from { opacity: 0; transform: translateY(var(--motion-rise)) scale(var(--motion-scale)); }
  to   { opacity: 1; transform: none; }
}

/* The page swap (the old .mon-flick call site) */
.theme-nixie .mon-arrive-page { animation: mon-flick 0.33s linear both; }
.theme-ink .mon-arrive-page {
  animation: mon-draw 260ms var(--motion-ease-out) both;
}
@keyframes mon-draw {
  from { opacity: 0; clip-path: inset(0 0 8% 0); }
  to   { opacity: 1; clip-path: inset(0 0 0 0); }
}
.theme-glass .mon-arrive-page {
  animation: mon-float 380ms var(--motion-ease-out) both;
}
@keyframes mon-float {
  from { opacity: 0; transform: translateY(8px); filter: blur(2px); }
  to   { opacity: 1; transform: none; filter: blur(0); }
}
```

`mon-flick` belongs to Nixie; Ink draws with `clip-path`; Glass rises 8px with a 2px blur. Components carry a class name and do not branch on the theme.

### P1-3 Ink card hover and the tilt rule

Location: [themes.css](../apps/web/src/ui/shared/themes.css#L543-L549), [rounds.css](../apps/web/src/ui/rounds/rounds.css#L562-L567)

**Before**: `.theme-ink .rounds-card:nth-child(odd)`'s `transform: rotate(0.45deg)` had higher specificity than `.rounds-card:hover`, so Ink cards did not scale on hover, and the `transform` in the transition never ran.

**Change**: the tilt is stored in a custom property and composed on hover:

```css
.theme-ink .rounds-card:nth-child(odd) { --mon-tilt: 0.45deg; }
.theme-ink .rounds-card:nth-child(even) { --mon-tilt: -0.35deg; }

.rounds-card {
  transform: rotate(var(--mon-tilt, 0deg));
  transition:
    transform 160ms var(--motion-ease-out),
    opacity 160ms var(--motion-ease-out),
    border-color 160ms ease;
}
.rounds-card:hover {
  transform: rotate(var(--mon-tilt, 0deg)) translateY(-2px) scale(1.18);
}
```

`box-shadow` was removed from the transition list; it repaints every frame, and the transform already communicates the lift.

### P1-4 Timeline cursor: `left` to `transform`

Location: [chart.css](../apps/web/src/ui/chart/chart.css#L603-L611), [monitor.css](../apps/web/src/ui/monitor/monitor.css#L623-L631), [ChartTimeline.tsx](../apps/web/src/ui/chart/ChartTimeline.tsx#L136-L142), [MonitorStage.tsx](../apps/web/src/ui/monitor/MonitorStage.tsx#L811-L813)

During replay the cursor moves continuously, and a `left` transition triggered layout and paint every frame. The cursor became a full-width wrapper translated by a percentage of the track:

```tsx
<span className="chart-head" style={{ transform: `translateX(${head}%)` }} aria-hidden>
```

```css
.chart-head {
  left: 0;
  width: 100%;
  transition: transform 80ms linear;
}
.chart-head::before {
  content: "";
  position: absolute;
  top: -4px;
  bottom: -6px;
  width: 2px;
  background: var(--ch-t);
}
```

`.mon-tl__head` uses the same treatment; the label travels with the wrapper and stays anchored to the line.

### P1-5 Rounds window entrance

Location: [RoundsWindow.tsx](../apps/web/src/ui/rounds/RoundsWindow.tsx#L71-L105)

Windows previously appeared instantly. Their source is the right-hand dock, so they grow from that direction:

```css
.rounds-win {
  transform-origin: right center;
  transition:
    opacity var(--motion-dur-quick) var(--motion-ease-out),
    scale var(--motion-dur-quick) var(--motion-ease-out);
}
@starting-style {
  .rounds-win { opacity: 0; scale: 0.96; }
}
```

The independent `scale` property is used so it never conflicts with the drag `translate3d`. Closing stays instant; closing a window is a frequent, deliberate action.

### P2-1 Notices: theme grammar and stagger

Location: [attention.css](../apps/web/src/components/attention/attention.css#L66-L76), [AttentionNotice.tsx](../apps/web/src/components/attention/AttentionNotice.tsx)

Notices are occasional and arrive in groups. The existing 180ms entrance remains, with three changes:

- the theme curve (`var(--motion-ease-out)`);
- `--mon-delay` on the second and third cards (40/80ms);
- no animation on the Attention rows inside Activity, which are a high-frequency list.

### P2-2 Press feedback and hover gating

Location: [shared.css](../apps/web/src/ui/shared/shared.css#L231-L281), [rounds.css](../apps/web/src/ui/rounds/rounds.css#L902-L911)

- Press: `.mon-btn:active:not(:disabled)` and `.rounds-di:active` use `transform: scale(0.97)` over 140ms as feedback.
- Hover movement (card `translateY(-2px)`, dock `translateY(-1px)`) sits inside `@media (hover: hover) and (pointer: fine)`, so touch taps do not fire false hovers.

### P2-3 Nixie filament and Ink boil rates

- `.theme-nixie .mon-nix__cell--settled`'s `filter: brightness()` uses `steps(1, end)`: three discrete steps per 3.7s, with no continuous interpolation.
- `InkBoil`'s seed step moved from 250ms to 333ms (on-threes). Rounds is intended to boil only visible cards (`IntersectionObserver`, or only `data-now` / hovered cards referencing `#mon-ink-boil`); thirty cards boiling at once has the highest rendering cost in the implementation.

### P2-4 Settings dialog entrance

Location: [SettingsDialog.tsx](../apps/web/src/components/common/SettingsDialog.tsx#L50-L60)

The modal is centered, so centering the scale is correct: 200ms `opacity` on the backdrop and 250ms `opacity` + `scale(0.96)` on the panel (`.mon-arrive` is sufficient). It is a low-frequency action and keeps this motion.

## 4. Order of work

| Phase | Work | Reason |
|---|---|---|
| A Foundation | Motion tokens, `.mon-arrive`, `.mon-pagein`; FaceRise to CSS; DiffStage drops framer-motion | Establish one way to write motion that every later item reuses |
| B Performance | Rounds window drag; Nixie throttle + 15fps; infinite `box-shadow` to pseudo-elements; timeline cursor; remove window/bubble `backdrop-filter` | These were the dropped frames and main-thread work |
| C Grammar | Ink hover fix; page entrances per style; notice stagger; window entrance; Drip fold easing to `ease-out` | Unify the three styles' motion language |
| D Polish | Press feedback, hover gating, filament/boil throttling, Settings dialog | Final feel, with no structural change |

**Acceptance**:

1. `npm run typecheck` and `npm run build` pass.
2. The result is reviewed across 3 styles × 2 schemes × 4 surfaces (Monitor / Rounds / Chart / Drip); entrances do not cover content or block clicks.
3. DevTools Performance: five-second recordings of Rounds drag (with Monaco), Nixie at full speed, and Ink with 30 cards show no new long tasks.
4. With `prefers-reduced-motion: reduce` emulated, all motion stops immediately, per the existing policy.
5. High-frequency surfaces are re-checked: Activity rows, context menu, keyboard actions and per-event counters still do not animate.
6. Bundle size drops after `framer-motion` is removed.

## 5. Out of scope

- **No entrances on Activity rows, the clock, context usage, or the R/S/E/$ counters.** They are high-frequency, functional data; Nixie's settle marks state changes.
- **The all-stop `prefers-reduced-motion` policy stays unchanged.** It is documented in [ui-style-interface.md](ui-style-interface.md) as a settled decision.
- **The Drip pill width keeps `width`.** `scaleX` stretches the text, and `clip-path` cannot change the space the pill occupies; this is a layout animation without an equivalent visual.
- **No entrances on the context menu, tabs, or the `⏎` shortcut.** These run 100+ times/day.
- **No animation library.** `lib/anim.ts`'s closed-form springs are sufficient, and the framer-motion dependency is removed.

## 6. Design constraints

- Animation uses `transform` and `opacity`; `transition: all` is not used.
- Motion frequency follows the gate in section 2; high-frequency actions receive no entrance.
- `box-shadow` is not composited and is not animated directly; pulses use a pseudo-element's `opacity`.
- Durations, distances and curves come from the motion tokens in section 2; style-specific values override them.
- Enter and exit use `ease-out`; press feedback stays in the 100–160ms range.
