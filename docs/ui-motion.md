# Motion

[English](ui-motion.md) | [简体中文](ui-motion.zh-CN.md)

This document describes the motion layer of `apps/web`: what drives an animation, at what cadence it plays, the motion grammar of each style, and the audit that produced the current implementation. It does not change the interface structure described in [ui-faces.md](ui-faces.md) or the style and scheme dimensions defined in [ui-style-interface.md](ui-style-interface.md).

## 1. Principles

| Principle | Rule |
|---|---|
| Frequency gate | Surfaces updated more than about once a second carry no entrance animation; a state change may settle a value once |
| Compositor-only | Movement uses `transform` and `opacity`. Layout properties are not animated |
| Time functions | Motion is expressed as pure functions of elapsed time (`apps/web/src/lib/anim.ts`); no animation library drives the faces |
| Reduced motion | `prefers-reduced-motion: reduce` stops animations and transitions, including the avatar's |
| Style grammar | Each style owns one motion grammar; the same action may look different per style but must mean the same thing |

`apps/web/src/lib/anim.ts` provides closed-form damped springs (`spring`, `springV`, `pop`), easing functions, a frame quantizer (`frameOf`, 15 fps), a deterministic hash and `tween`, a one-shot imperative tween that honours reduced motion.

## 2. Motion grammar

| Style | Grammar | Avoids |
|---|---|---|
| Nixie | Instrument-like: digits roll for 3–5 frames and settle; a page powers on with a 4-frame alpha sequence; displacement stays under 4px; entrance 180ms; settling happens only on state change | Long eases, continuous breathing, re-rolling a reading that changes every second |
| Ink | Hand-drawn: discrete two- or three-frame cadence; strokes and paper revealed with `clip-path`; slight overshoot (`cubic-bezier(0.2, 0.8, 0.3, 1.3)`); entrance 260ms | Gaussian blur, glass highlights, constant-velocity linear movement |
| Glass | Slow and transparent: `opacity` with an 8px rise and `scale(0.98)`; springs only for the pill and the mercury ball; entrance 380–500ms; cross-fades may use `blur(2px)` | Fast movement, bounce, blur over 20px |

Frequency gate:

| Frequency | Treatment |
|---|---|
| 100+ times a day (context menus, keyboard actions, rows inside a tab) | No animation |
| Tens of times a day (buttons, dock, card hover) | 100–160ms feedback only |
| Occasional (face switch, window open, settings, Drip) | Standard entrance 180–380ms |
| Rare (first report, run end) | One short settle animation |

## 3. Inventory

| Motion | Location | Driver | Property | Frequency | Treatment |
|---|---|---|---|---|---|
| Face entrance | `ui/shared/FaceRise.tsx` | JS rAF via `tween` | `opacity`, `transform` | Each face switch | 560ms spring with 12px rise; identity restored at the end |
| Nixie digit settle | `ui/shared/Nixie.tsx` | JS rAF | `textContent` | Each value change | Scramble for 500ms, volatile cells only; the last 30% eases to every other frame |
| Page power-on | `ui/shared/shared.css` (`.mon-flick`) | CSS | `opacity` | Metrics/Chat page switch | 0.33s linear flicker |
| Ink stroke boil | `ui/shared/InkBoil.tsx` | `setInterval` 250ms | SVG filter seed | Continuous (Ink) | Three seeds cycle; disabled under reduced motion |
| Ink drop | `ui/shared/themes.css` | CSS keyframes | `transform`, `border-radius`, `box-shadow` | State change | Ink wash drawn with pseudo-elements |
| Nixie power ripple | `ui/shared/themes.css` | CSS | `transform`, `opacity` | While the agent runs | 3.2s infinite, composited properties only |
| Ambient drift | `ui/shared/shared.css`, `ui/rounds/rounds.css` | CSS | `transform` | Continuous | 38–57s alternate drifts; disabled under reduced motion |
| Character | `components/agent/whalebun.css` | CSS | `transform`, `opacity` | Continuous | Per-state CSS animations |
| Attention card entrance | `components/attention/attention.css` | CSS | `transform`, `opacity` | Occasional | 0.18s `att-in` |
| Drip unfold / fold | `ui/drip/drip.css` | CSS keyframes | `transform`, `opacity` | Toggle | 0.18s unfold, 0.14s fold; Glass uses a 0.32s spring |
| Story card hover | `ui/rounds/rounds.css` | CSS | `transform`, `box-shadow` | High frequency | 0.16s transform, opacity and border; hover lifts and scales |
| Current story card | `ui/rounds/rounds.css` | CSS keyframes | `box-shadow` | Continuous | 2.6s pulse; disabled under reduced motion |
| Timeline cursor | `ui/monitor/monitor.css`, `ui/chart/chart.css` | CSS | `left` | Replay / selection | 0.08s linear transition |
| Diff entrance | `components/stage/DiffStage.tsx` | framer-motion | `opacity`, `y` | Each Stage item mount | 0.5s `y: 8 → 0` entrance plus a 1s sheen |
| Window drag / resize | `ui/rounds/RoundsWindow.tsx` | React state | `left`, `top`, `width`, `height` | While dragging | `setState` per pointer move |
| Drip pill width | `ui/drip/drip.css` | CSS | `width` | Toggle / hover | No visual equivalent |
| Glass button sheen | `ui/shared/themes.css` | CSS | `background-position` | Button hover | Gradient sweep |

## 4. Constraints

- The high-frequency surfaces — the Activity feed, the metrics counters, the run selector and keyboard actions — carry no entrance animation. A value that changes every second is written directly; only a state change may play a settle animation.
- Animations on continuous elements use `transform` and `opacity` only. The Nixie filament and the Ink boil are the two looping effects, both style-scoped.
- Every face respects the reduced-motion query: `shared.css` stops the ambient layers, `rounds.css` stops the room drift and the current-card pulse, `drip.css` stops the card, and `themes.css` stops the character.
- The desktop shell opens Drip as a separate window; Document Picture-in-Picture cannot render an SVG filter, so the Ink boil applies only to the main document.

## 5. Known costs

| Item | Cost | Mitigation |
|---|---|---|
| `RoundsWindow` drag and resize | One React render per pointer move | Windows are few; the drag region is limited to the title bar and the corner handle |
| `DiffStage` entrance | A 0.5s mount animation on a high-frequency surface | Kept as the one deliberate entrance on the Stage; removing it requires a replacement settle cue |
| `FaceRise` | A 560ms rAF tween per face mount | Runs once per switch; the transform is cleared at the end so it does not constrain the face afterwards |
| Timeline cursor | `left` transition re-lays out the cursor element | The element is a single absolutely positioned child |
| Nixie scramble | rAF writes for 500ms per settle | Quantized to 15 fps; volatile cells only |
