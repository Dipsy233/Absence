# UI style and scheme interface

[English](ui-style-interface.md) | [简体中文](ui-style-interface.zh-CN.md)

This document defines the two dimensions that control the appearance of the
interface: the style and the colour scheme. It lists the tokens, the files that
own them, the contrast floor, and the procedure for adding a style or a surface.
The rules apply to Monitor, Rounds, Chart, Drip, ProjectPicker, and Settings.

## Two dimensions

| Dimension | HTML class | Controls |
|---|---|---|
| Style | `theme-nixie` / `theme-ink` / `theme-glass` | Non-colour attributes: font stacks, letter spacing, type scale, border width, corner radius, patterns, effects |
| Scheme | `scheme-dark` / `scheme-light` | Colour: background, text, border, semantic colours, surfaces |

A style block defines non-colour attributes. Colour values come from the
scheme's tokens; material definitions are described under Materials and derived
effects. The two dimensions are independent and can change separately.

## Runtime

```
<html class="theme-ink scheme-light">
```

- Values and persistence: `apps/web/src/lib/uistyle.ts`, storage keys
  `absence.uistyle` and `absence.uistyle-scheme`.
- State: `apps/web/src/stores/uistyleStore.ts` (`uiStyle`, `schemeOverride`).
- Class writing: the top-level effect in `apps/web/src/app/App.tsx`.

The effect removes every `theme-*` class by mapping `UI_STYLES`, removes
`scheme-light` and `scheme-dark`, then adds `theme-${uiStyle}` and
`scheme-${schemeOverride ?? defaultScheme(uiStyle)}`. The removal list is
generated from `UI_STYLES`; a new style does not require editing a separate
removal list.

Each style declares the scheme it is designed around: `ink` defaults to
`light`; `nixie` and `glass` default to `dark`. A stored scheme override wins
over that default. In the `APPEARANCE` pane, selecting the style's default
scheme clears the override.

Changes apply immediately through CSS variable inheritance. Drip follows the
same document classes; the browser PiP host mirrors the classes into the PiP
document.

## Files

| File | Responsibility |
|---|---|
| `apps/web/src/ui/shared/shared.css` | Neutral baseline: default token values (dark), atoms (chip, dot, button), control visibility rules (focus ring, accent-color, hover, active), the `--desk-*` bridge |
| `apps/web/src/ui/shared/themes.css` | All style and scheme differences: one base block per style (its default scheme plus style features), one override block for the other scheme, then the surface groups |
| `apps/web/src/ui/shared/picker.css`, `apps/web/src/ui/monitor/monitor.css`, `apps/web/src/ui/rounds/rounds.css`, `apps/web/src/ui/chart/chart.css`, `apps/web/src/ui/drip/drip.css` | Face layout and face-specific rules; theme colours read tokens, while translucent washes, shadows, and local fallbacks use literal values |
| `apps/web/src/lib/uistyle.ts`, `apps/web/src/stores/uistyleStore.ts` | Values, persistence, state |
| `apps/web/src/app/App.tsx` | Writes the classes; feeds the Monaco paper colours |
| `apps/web/src/components/common/SettingsDialog.tsx` | `APPEARANCE` pane controls |

`themes.css` loads after `shared.css`. `FaceBar.tsx` imports both in that order.

## Style interface

A style block can define:

- `--mon-sans`: body and control font. The default stack includes
  `PingFang SC`, `Microsoft YaHei`, and `Noto Sans SC` for CJK.
- `--mon-mono`: monospace slots (counts, paths, timestamps). A style can
  replace it with a display face; Monaco and Tailwind's `font-mono` keep their
  own stacks.
- `--mon-hand`: optional auxiliary handwriting family for style-internal use.
- Font size, letter spacing, and `@font-face` `size-adjust`.
- Border width and corner radius, including asymmetric organic radii.
- Control background patterns: gradients and inner shadows that combine tokens.
- Effects: glows, paper noise, `backdrop-filter`, pseudo-element decorations.
- Local filters and animations used by the style's own features.

### Style implementations

| Style | Fonts | Features |
|---|---|---|
| Nixie | Default sans and mono | Riveted metal control plates with gradient and inner shadow; etched captions with wide letter spacing; glowing digits; a power ripple along the top bar while `data-running` is set; corner rivets on panels, Stage sheets, and Rounds windows; tape-like timeline blocks; vacuum-tube number cells in the `auto` Nixie variant |
| Ink | `Caveat` and `851ShouXie` replace both sans and mono; `Caveat` uses `size-adjust: 140%` | 1.6px ink borders; organic radii; slight card tilt; paper-noise overlay on `body::after` (feTurbulence data URI, `mix-blend-mode: multiply`); ink-drop status dots; boiling outlines through the `InkBoil` filter; torn-paper Chart hero; ink-blot button hover; folded Drip card corner; 13px feed text |
| Glass | Default sans and mono | 6px right angles on controls, chips, menus, cards, and windows; hairline architectural borders; frosted top bar and status bubble; frosted Drip pill/card in the in-page host, where a backdrop exists; liquid-metal sheen on button hover; prism glow on panel and Stage sheet hover; caustic light bands in the background; mercury-ball Drip pill |

## Scheme interface

A scheme remaps the token sets below. The base block under `.theme-<id>` carries
the style's default scheme; the other scheme is an override block under
`.theme-<id>.scheme-<name>`. Both blocks declare the surface group completely.
Text and semantic groups may inherit from the base block when a value is not
repeated.

### Base surfaces and text

| Token | Use | Floor |
|---|---|---|
| `--mon-bg` | Page background | — |
| `--mon-s1` | Panel and top bar | — |
| `--mon-s2`, `--mon-s3` | Secondary and tertiary panels, hover surface | Distinguishable from `s1` |
| `--mon-t` | Body text | ≥ 4.5:1 against `s1` / `s2` |
| `--mon-t2` | Secondary text | ≥ 4.5:1 |
| `--mon-t3` | Captions and small labels, rendered as text | ≥ 4.5:1; 5.9:1 on `--mon-s1` in the default palette |
| `--mon-bd`, `--mon-bd2` | Hairline and control border | Visible against the surface |
| `--mon-acc` | Accent, focus ring, selected state | ≥ 3:1 |

`--mon-t3` is a text token even when it labels a small icon or a caption. Its
floor is 4.5:1, the same as the other text tokens. The 3:1 floor applies to
controls, graphics, and the semantic colours below.

### Semantic colours

`--mon-think`, `--mon-read`, `--mon-search`, `--mon-edit`, `--mon-run`,
`--mon-egg`, `--mon-err` identify activity kinds. Each clears 5.5:1 on the
panel in the default palette, so an 11px tag remains readable. Chip backgrounds
use a 14% wash; chip text uses the semantic token.

### Surface group

| Token | Surface |
|---|---|
| `--mon-room` | Rounds room background |
| `--mon-win` | Floating window body |
| `--mon-card`, `--mon-card-now` | Story card and current card |
| `--mon-bubble` | Status bubble and wallpaper chat bubble |
| `--mon-bubble-user`, `--mon-bubble-user-border` | User bubble |
| `--mon-bubble-system` | System bubble |
| `--mon-inp` | Bottom input bar |
| `--mon-dock` | Rounds dock strip |
| `--mon-paper` | Text view paper: code and file content, including the Monaco background and gutter |
| `--mon-paper-2` | Secondary paper surface, including the current-line highlight |
| `--mon-paper-t` | Paper text |
| `--mon-paper-dim` | Paper secondary text, including line numbers |
| `--drip-pill`, `--drip-card` | Drip pill and card |

The surface group is declared once per style and scheme in `themes.css`: six
combinations in total.

### Derived sets

| Set | Tokens |
|---|---|
| Drip | `--drip-s1`, `--drip-s2`, `--drip-s3`, `--drip-bd`, `--drip-bd2`, `--drip-t`, `--drip-t2`, `--drip-t3`, `--drip-think`, `--drip-read`, `--drip-search`, `--drip-edit`, `--drip-run`, `--drip-err`, `--drip-warn`, `--drip-say`, `--drip-ok`, `--drip-listen`, `--drip-pill`, `--drip-card`, `--drip-sans`, `--drip-mono` |
| Chart | `--ch-*`, same structure as `--mon-*` with the `ch` prefix |
| Desk bridge | `--desk-bg`, `--desk-panel`, `--desk-panel2`, `--desk-deep`, `--desk-line`, `--desk-ink`, `--desk-dim`, `--desk-accent`, `--desk-ember`, `--desk-teal`, `--desk-wood`, `--desk-wood-lit`, `--desk-lavender` |
| Scrollbars | `.mon-ridesb__thumb` and the native scrollbar thumb; see the exception below |

The desk bridge is written as channel triples so Tailwind opacity modifiers
such as `/40` continue to work.

### Monaco paper

Monaco cannot read CSS variables. The effect in `App.tsx` reads
`--mon-paper`, `--mon-paper-2`, `--mon-paper-t`, `--mon-paper-dim`, and
`--mon-acc` from the mounted `.mon-root` with `getComputedStyle`, then calls
`applyMonacoTheme` in `apps/web/src/lib/monaco.ts`. The base theme follows the
scheme (`vs-dark` for dark, `vs` for light); tokens define only the paper. A new
editor colour requires adding it to the read list and defining it in each
style × scheme block.

## Contrast and control floor

1. Body text clears 4.5:1 on its surface.
2. `--mon-t3` clears 4.5:1; it is 5.9:1 on `--mon-s1` in the default palette.
3. Controls and graphics clear 3:1. Semantic kind colours clear 5.5:1 on the
   panel in the default palette.
4. Normal, hover, active, focus, and selected states are distinguishable.
   Hover changes the surface, active moves down, focus draws an outline ring,
   and selected states carry the accent border. `shared.css` provides the
   baseline; a style can add rules on top of it and cannot remove the baseline.
5. Dividers remain visible.
6. `outline: none` is not used alone. Text fields use the caret as their focus
   cue and keep their border colour; all other focusable elements draw a ring.
7. `prefers-reduced-motion: reduce` stops animations and transitions, including
   the avatar's.
8. Chrome uses fixed sizes: chips are 22px high, buttons 28px.

## Scrollbar exception

Opaque theme surfaces and text colours come from tokens. Translucent washes,
shadows, focus outlines, and local fallbacks use literal values from the default
palette. Scrollbar chrome is the exception where a literal value defines a
visible surface:

- `.mon-ridesb__thumb` is mounted on `<body>`, outside any face's clip and
  stacking context, so the face's `--mon-*` tokens do not reach it. `shared.css`
  gives it a literal colour, and `themes.css` restates the colour per style and
  scheme.
- The native `::-webkit-scrollbar-thumb` inside `.mon-root` uses literal greys
  (`#3a3a38`, `#4b4b48` on hover) with a token border. Scrollbar chrome is
  browser-drawn and sits outside the themed surfaces.
- Floating dropdowns use `.mon-slimscroll`, which reads `--mon-bd2`.

Apart from material definitions, the exception for opaque surfaces covers
scrollbar chrome only. Backgrounds, text, borders, and controls use the token
sets above.

## Adding or changing a style

**Add a style**

1. Add the id to `UiStyleId` and `UI_STYLES` in `lib/uistyle.ts`.
2. Add a section to `themes.css`: the default-scheme token block, the other
   scheme override, and the surface group for both schemes.
3. Set `defaultScheme` for the new id.
4. Add the display name to `lib/i18n.ts`.
5. The `App.tsx` removal list covers the new style automatically.

**Change a style's light or dark look**

Edit only the token values in the corresponding `.scheme-*` block. Style
feature rules stay unchanged.

**Add a surface**

1. Add the token default under `.mon-root` in `shared.css`.
2. Replace hardcoded values in the consuming stylesheet with `var(...)`.
3. Declare the token in each style × scheme block in `themes.css`.

**Scheme changes**

`App.tsx` removes the two scheme classes explicitly. A new scheme name requires
updating that removal step together with `SCHEMES` in `lib/uistyle.ts`.

## Materials and derived effects

Feature effects derive their colour from semantic tokens with
`color-mix(in srgb, var(--mon-…), …)`: rivets, tape edges, power ripple, prism
glow, and similar decorations. Material definitions, such as the nixie tube
glass and the riveted plate gradient, use literal values and declare one set per
scheme. They describe the material itself.

The base block carries the style's default scheme: ink's base is light, and
nixie's and glass's bases are dark. Reversing that order for a style means
adding a block for the other scheme; the interface between style and scheme does
not change.
