# UI style and scheme interface

[English](ui-style-interface.md) | [简体中文](ui-style-interface.zh-CN.md)

This document defines the two dimensions that control the interface's appearance: style and colour scheme. It lists the tokens, the files that own them, the contrast floors, and the steps for adding a style or a surface. The rules apply to the observation board, Monitor, Rounds, Chart, Drip and Settings.

## 1. The two dimensions

| Dimension | HTML class | Controls |
|---|---|---|
| Style | `theme-nixie` / `theme-ink` / `theme-glass` | Non-colour attributes: font stack, letter spacing, type scale, border weight, radius, pattern, effects |
| Scheme | `scheme-dark` / `scheme-light` | Colours: background, text, border, semantic colours, surfaces |

Style rules define non-colour attributes. Colour values come from the scheme's tokens; material definitions are covered in section 7. The dimensions are independent and switch separately.

## 2. Runtime

```html
<html class="theme-ink scheme-light">
```

- Values and persistence: `apps/web/src/lib/uistyle.ts`, storage keys `absence.uistyle` and `absence.uistyle-scheme`.
- State: `apps/web/src/stores/uistyleStore.ts` (`uiStyle`, `schemeOverride`).
- Class writing: the top-level effect in `apps/web/src/app/App.tsx`.

The effect removes every `theme-*` class using `UI_STYLES`, removes `scheme-light` and `scheme-dark`, then writes `theme-${uiStyle}` and `scheme-${schemeOverride ?? defaultScheme(uiStyle)}`. The removal list is generated from `UI_STYLES`, so a new style needs no second list.

Each style declares the scheme it is designed around: `ink` defaults to `light`; `nixie` and `glass` default to `dark`. A stored scheme override takes precedence. Selecting the style's own default scheme in the `Appearance` pane clears the override.

Changes take effect immediately through CSS variable inheritance. Drip follows the same document classes; the browser PiP host mirrors the classes into the PiP document.

## 3. Files

| File | Responsibility |
|---|---|
| `apps/web/src/ui/shared/shared.css` | Neutral baseline: token defaults (dark), atoms (chip, dot, button), control visibility rules (focus ring, `accent-color`, hover, active), the `--desk-*` bridge |
| `apps/web/src/ui/shared/themes.css` | Every style and scheme difference: one base block per style (its default scheme plus style features), one override block for the other scheme, then the surface groups |
| `apps/web/src/ui/shared/picker.css`, `observatory.css` | Observation board rules |
| `apps/web/src/ui/monitor/monitor.css`, `rounds/rounds.css`, `chart/chart.css`, `drip/drip.css` | Face layout and face-specific rules; theme colours read tokens, while translucent washes, shadows and local fallbacks use literal values |
| `apps/web/src/lib/uistyle.ts`, `stores/uistyleStore.ts` | Values, persistence, state |
| `apps/web/src/app/App.tsx` | Writes the classes; supplies the Monaco paper colour |
| `apps/web/src/components/common/SettingsDialog.tsx` | The `Appearance` pane controls |

`themes.css` loads after `shared.css`. `FaceBar.tsx` imports both in that order.

## 4. Style interface

A style block may define:

- `--mon-sans`: body and control font. The default stack includes `PingFang SC`, `Microsoft YaHei` and `Noto Sans SC` to cover CJK.
- `--mon-mono`: monospaced slots (counters, paths, timestamps). A style may replace it with a display face; Monaco and Tailwind's `font-mono` keep their own stacks.
- Type scale, letter spacing, border weights, radii, decorative backgrounds and effect rules.

A style must not change a token's meaning: `--mon-err` stays the error colour in every style.

## 5. Scheme interface

### Base tokens

| Token | Use |
|---|---|
| `--mon-bg`, `--mon-s1`, `--mon-s2`, `--mon-s3` | Page and surface backgrounds |
| `--mon-bd`, `--mon-bd2` | Hairline and control borders |
| `--mon-t`, `--mon-t2`, `--mon-t3` | Body, secondary and caption text |
| `--mon-think`, `--mon-read`, `--mon-search`, `--mon-edit`, `--mon-run`, `--mon-egg`, `--mon-err` | Activity kinds |
| `--mon-acc` | Accent, focus ring, selected state |

### Contrast floors

| Token | Floor |
|---|---|
| `--mon-t` | ≥ 4.5:1 against `s1` and `s2` |
| `--mon-t2` | ≥ 4.5:1 |
| `--mon-t3` | ≥ 4.5:1; 5.9:1 on `--mon-s1` in the default palette |
| `--mon-bd`, `--mon-bd2` | Visible against the surface |
| `--mon-acc` | ≥ 3:1 |
| Semantic kind colours | ≥ 5.5:1 on the panel in the default palette, so an 11px tag stays readable |

`--mon-t3` is a text token even when it labels a small icon or a caption, so its floor is 4.5:1. The 3:1 floor applies to controls and graphics. Chip backgrounds use a 14% wash; chip text uses the semantic token.

### Surface group

| Token | Surface |
|---|---|
| `--mon-room` | Rounds room background |
| `--mon-win` | Floating window body |
| `--mon-card`, `--mon-card-now` | Story card and current card |
| `--mon-bubble` | Status bubble and wallpaper conversation bubble |
| `--mon-bubble-user`, `--mon-bubble-user-border` | User bubble |
| `--mon-bubble-system` | System bubble |
| `--mon-inp` | Rounds conversation surface; declared for the Rounds stylesheet, which this build renders without an input |
| `--mon-dock` | Rounds dock strip |
| `--mon-paper` | Text surface: code and file content, including the Monaco background and gutter |
| `--mon-paper-2` | Secondary text surface, including the current-line highlight |
| `--mon-paper-t` | Text-surface text |
| `--mon-paper-dim` | Text-surface secondary text, including line numbers |
| `--drip-pill`, `--drip-card` | Drip pill and card |

The surface group is declared once per style and scheme in `themes.css`: six combinations.

### Derived sets

| Set | Tokens |
|---|---|
| Drip | `--drip-s1`, `--drip-s2`, `--drip-s3`, `--drip-bd`, `--drip-bd2`, `--drip-t`, `--drip-t2`, `--drip-t3`, `--drip-think`, `--drip-read`, `--drip-search`, `--drip-edit`, `--drip-run`, `--drip-err`, `--drip-warn`, `--drip-say`, `--drip-ok`, `--drip-listen`, `--drip-pill`, `--drip-card`, `--drip-sans`, `--drip-mono` |
| Chart | `--ch-*`, the same structure as `--mon-*` with the `ch` prefix |
| Desk bridge | `--desk-bg`, `--desk-panel`, `--desk-panel2`, `--desk-deep`, `--desk-line`, `--desk-ink`, `--desk-dim`, `--desk-accent`, `--desk-ember`, `--desk-teal`, `--desk-wood`, `--desk-wood-lit`, `--desk-lavender` |
| Scrollbars | `.mon-ridesb__thumb` and the native scrollbar thumb; see section 8 |

The desk bridge is written as channel triples so Tailwind opacity modifiers such as `/40` keep working.

### Monaco paper

Monaco cannot read CSS variables. The effect in `App.tsx` reads `--mon-paper`, `--mon-paper-2`, `--mon-paper-t`, `--mon-paper-dim` and `--mon-acc` from the mounted `.mon-root` with `getComputedStyle`, then calls `applyMonacoTheme` in `apps/web/src/lib/monaco.ts`. The base theme follows the scheme (`vs-dark` for dark, `vs` for light); the tokens define only the paper. A new editor colour requires adding it to the read list and defining it in each style × scheme block.

## 6. Control floor

1. Body text clears 4.5:1 on its surface.
2. Controls and graphics clear 3:1.
3. Normal, hover, active, focus and selected states are distinguishable. Hover changes the surface, active moves down, focus draws a ring, and selected states carry the accent border. `shared.css` provides the baseline; a style may add rules and may not remove the baseline.
4. Dividers remain visible.
5. `outline: none` is never used alone. Text fields use the caret as their focus cue and keep their border colour; every other focusable element draws a ring.
6. `prefers-reduced-motion: reduce` stops animations and transitions, including the avatar's.
7. Chrome uses fixed sizes: chips are 22px high, buttons 28px.

## 7. Materials and derived effects

Feature effects derive their colour from semantic tokens with `color-mix(in srgb, var(--mon-…), …)`: rivets, tape edges, power ripple, prism glow and similar decorations. Material definitions, such as the nixie tube glass and the riveted plate gradient, use literal values and declare one set per scheme, because they describe the material itself.

The base block carries the style's default scheme: ink's base is light; nixie's and glass's bases are dark. A style whose base is the other scheme declares its remaining scheme in an override block; the interface between style and scheme does not change.

## 8. Scrollbar exception

Opaque theme surfaces and text colours come from tokens. Translucent washes, shadows, focus outlines and local fallbacks use literal values from the default palette. Scrollbar chrome is the one place where a literal value defines a visible surface:

- `.mon-ridesb__thumb` is mounted on `<body>`, outside any face's clip and stacking context, so the face's `--mon-*` tokens do not reach it. `shared.css` gives it a literal colour and `themes.css` restates that colour per style and scheme.
- The native `::-webkit-scrollbar-thumb` inside `.mon-root` uses literal greys (`#3a3a38`, `#4b4b48` on hover) with a token border, because scrollbar chrome is browser-drawn and sits outside the themed surfaces.
- Floating dropdowns use `.mon-slimscroll`, which reads `--mon-bd2`.

Apart from material definitions, scrollbar chrome is the only opaque surface defined by a literal value.

## 9. Adding or changing a style

**Add a style**

1. Add the id to `UiStyleId` and `UI_STYLES` in `lib/uistyle.ts`.
2. Add a section to `themes.css`: the default-scheme token block, the other scheme's override block, and the surface group for both schemes.
3. Set `defaultScheme` for the new id.
4. Add the display name to `lib/i18n.ts`.
5. The `App.tsx` removal list covers the new style automatically.

**Change a style's light or dark look**

Edit only the token values in the corresponding `.scheme-*` block. Style feature rules stay unchanged.

**Add a surface**

1. Add the token default under `.mon-root` in `shared.css`.
2. Replace hardcoded values in the consuming stylesheet with `var(...)`.
3. Declare the token in each style × scheme block in `themes.css`.

**Add a scheme**

Add the name to `SCHEMES` in `lib/uistyle.ts` and update the explicit removal step in `App.tsx`.
