# UI 风格与色系接口

[English](ui-style-interface.md) | [简体中文](ui-style-interface.zh-CN.md)

本文定义控制界面观感的两个维度：风格（style）与色系（scheme）。文中列出 token、负责这些 token 的文件、对比度底线，以及新增风格或新增表面的步骤。规则适用于 Monitor、Rounds、Chart、Drip、ProjectPicker 与 Settings。

## 两个维度

| 维度 | HTML 类 | 控制内容 |
|---|---|---|
| 风格 | `theme-nixie` / `theme-ink` / `theme-glass` | 非颜色属性：字体栈、字距、字号缩放、边框粗细、圆角、图案、效果 |
| 色系 | `scheme-dark` / `scheme-light` | 颜色：背景、文字、边框、语义色、表面色 |

风格规则定义非颜色属性。颜色值来自色系的 token，材质定义按「材质与派生效果」一节处理。两个维度相互独立，可以分别切换。

## 运行时

```
<html class="theme-ink scheme-light">
```

- 取值与持久化：`apps/web/src/lib/uistyle.ts`，storage key 为 `absence.uistyle` 与 `absence.uistyle-scheme`。
- 状态：`apps/web/src/stores/uistyleStore.ts`（`uiStyle`、`schemeOverride`）。
- 类的写入：`apps/web/src/app/App.tsx` 的顶层 effect。

该 effect 先按 `UI_STYLES` 映射移除全部 `theme-*` 类，移除 `scheme-light` 与 `scheme-dark`，再写入 `theme-${uiStyle}` 与 `scheme-${schemeOverride ?? defaultScheme(uiStyle)}`。移除列表由 `UI_STYLES` 生成；新增风格不需要修改另一份移除列表。

每个风格声明自己对应的默认色系：`ink` 默认 `light`；`nixie` 与 `glass` 默认 `dark`。已存储的色系覆盖优先于该默认值。在 `APPEARANCE` 面板中选择该风格的默认色系会清除覆盖。

改动通过 CSS 变量继承即时生效。Drip 跟随同一组文档类；浏览器 PiP 宿主会把类镜像到 PiP 文档。

## 文件

| 文件 | 职责 |
|---|---|
| `apps/web/src/ui/shared/shared.css` | 中性基线：token 默认值（暗色）、原子类（chip、dot、button）、控件可见度规则（focus ring、accent-color、hover、active）、`--desk-*` 桥 |
| `apps/web/src/ui/shared/themes.css` | 全部风格与色系差异：每个风格一段基块（其默认色系 + 风格特征），另一色系一段覆盖块，然后是表面组 |
| `apps/web/src/ui/shared/picker.css`、`apps/web/src/ui/monitor/monitor.css`、`apps/web/src/ui/rounds/rounds.css`、`apps/web/src/ui/chart/chart.css`、`apps/web/src/ui/drip/drip.css` | face 布局与 face 专属规则；主题颜色读取 token，半透明 wash、阴影与局部 fallback 使用字面量 |
| `apps/web/src/lib/uistyle.ts`、`apps/web/src/stores/uistyleStore.ts` | 取值、持久化、状态 |
| `apps/web/src/app/App.tsx` | 写入类；为 Monaco 提供纸面色 |
| `apps/web/src/components/common/SettingsDialog.tsx` | `APPEARANCE` 面板控件 |

`themes.css` 在 `shared.css` 之后加载。`FaceBar.tsx` 按该顺序 import 两者。

## 风格接口

风格块可以定义：

- `--mon-sans`：正文与控件字体。默认栈包含 `PingFang SC`、`Microsoft YaHei`、`Noto Sans SC` 以覆盖 CJK。
- `--mon-mono`：等宽位（计数、路径、时间戳）。风格可以把它换成展示字体；Monaco 与 Tailwind 的 `font-mono` 保留各自的字体栈。
- `--mon-hand`：供风格内部使用的可选手写族。
- 字号、字距、`@font-face` 的 `size-adjust`。
- 边框粗细与圆角，包含不对称的有机圆角。
- 控件底色图案：组合 token 的渐变与内阴影。
- 效果：辉光、纸噪点、`backdrop-filter`、伪元素装饰。
- 风格自身特征使用的局部滤镜与动画。

### 三个风格的实现

| 风格 | 字体 | 特征 |
|---|---|---|
| Nixie | 默认 sans 与 mono | 铆接金属控件板（渐变 + 内阴影）；刻蚀宽字距标题；辉光数字；`data-running` 时顶栏底缘的电源纹波；面板、Stage 内容页与 Rounds 窗口的四角铆钉；纸带式时间线块；`auto` 变体下使用真空管数字格 |
| Ink | `Caveat` 与 `851ShouXie` 替换 sans 与 mono；`Caveat` 使用 `size-adjust: 140%` | 1.6px 墨线；有机圆角；卡片轻微倾斜；`body::after` 的纸噪点覆盖层（feTurbulence data URI，`mix-blend-mode: multiply`）；墨滴状态点；通过 `InkBoil` 滤镜的沸腾描边；Chart hero 的撕纸边；按钮的墨晕 hover；Drip 卡的折角；13px feed 文字 |
| Glass | 默认 sans 与 mono | 控件、chip、菜单、卡片、窗口统一 6px 直角；建筑感 hairline 边框；顶栏与状态气泡的磨砂效果；页面内宿主中 Drip pill/card 的磨砂效果（存在 backdrop 时）；按钮 hover 的液态金属光泽；面板与 Stage 内容页 hover 的棱镜光晕；背景的折射线；水银球 Drip pill |

## 色系接口

色系整体重映射下列 token 组。`.theme-<id>` 下的基块承载该风格的默认色系；另一色系写在 `.theme-<id>.scheme-<name>` 覆盖块中。两段都完整声明表面组。文字组与语义组在未重复声明时继承基块。

### 基面与文字

| Token | 用途 | 底线 |
|---|---|---|
| `--mon-bg` | 页面底 | — |
| `--mon-s1` | 面板与顶栏 | — |
| `--mon-s2`、`--mon-s3` | 次级与三级面板、hover 面 | 与 `s1` 可辨 |
| `--mon-t` | 正文 | 对 `s1` / `s2` ≥ 4.5:1 |
| `--mon-t2` | 次级文字 | ≥ 4.5:1 |
| `--mon-t3` | 说明文字与小标签，按文字渲染 | ≥ 4.5:1；默认调色板中在 `--mon-s1` 上为 5.9:1 |
| `--mon-bd`、`--mon-bd2` | hairline 与控件边界 | 与表面可辨 |
| `--mon-acc` | 强调、focus ring、选中态 | ≥ 3:1 |

`--mon-t3` 即使在标注小图标或说明时也属于文字 token。其底线为 4.5:1，与其他文字 token 相同。3:1 底线适用于控件、图形与下面的语义色。

### 语义色

`--mon-think`、`--mon-read`、`--mon-search`、`--mon-edit`、`--mon-run`、`--mon-egg`、`--mon-err` 标识活动种类。默认调色板中每种在面板上均达到 5.5:1，因此 11px 标签仍可读。chip 背景使用 14% wash；chip 文字使用语义 token。

### 表面组

| Token | 表面 |
|---|---|
| `--mon-room` | Rounds 房间底色 |
| `--mon-win` | 浮动窗口体 |
| `--mon-card`、`--mon-card-now` | story 卡片与当前卡片 |
| `--mon-bubble` | 状态气泡与壁纸聊天气泡 |
| `--mon-bubble-user`、`--mon-bubble-user-border` | 用户气泡 |
| `--mon-bubble-system` | 系统气泡 |
| `--mon-inp` | 底部输入条 |
| `--mon-dock` | Rounds dock 条 |
| `--mon-paper` | 文本视图纸面：代码与文件内容，包含 Monaco 底与行号槽 |
| `--mon-paper-2` | 纸面次级面，包含当前行高亮 |
| `--mon-paper-t` | 纸面文字 |
| `--mon-paper-dim` | 纸面次级文字，包含行号 |
| `--drip-pill`、`--drip-card` | Drip 球与卡 |

表面组在 `themes.css` 中按每个风格与色系声明一次：共六种组合。

### 派生组

| 组 | Token |
|---|---|
| Drip | `--drip-s1`、`--drip-s2`、`--drip-s3`、`--drip-bd`、`--drip-bd2`、`--drip-t`、`--drip-t2`、`--drip-t3`、`--drip-think`、`--drip-read`、`--drip-search`、`--drip-edit`、`--drip-run`、`--drip-err`、`--drip-warn`、`--drip-say`、`--drip-ok`、`--drip-listen`、`--drip-pill`、`--drip-card`、`--drip-sans`、`--drip-mono` |
| Chart | `--ch-*`，结构与 `--mon-*` 相同，前缀为 `ch` |
| 桌面桥 | `--desk-bg`、`--desk-panel`、`--desk-panel2`、`--desk-deep`、`--desk-line`、`--desk-ink`、`--desk-dim`、`--desk-accent`、`--desk-ember`、`--desk-teal`、`--desk-wood`、`--desk-wood-lit`、`--desk-lavender` |
| 滚动条 | `.mon-ridesb__thumb` 与原生滚动条 thumb；见下文例外 |

桌面桥以 channel triple 书写，Tailwind 的 `/40` 等透明度修饰符继续有效。

### Monaco 纸面

Monaco 不能读取 CSS 变量。`App.tsx` 的 effect 用 `getComputedStyle` 从挂载的 `.mon-root` 读取 `--mon-paper`、`--mon-paper-2`、`--mon-paper-t`、`--mon-paper-dim`、`--mon-acc`，再调用 `apps/web/src/lib/monaco.ts` 的 `applyMonacoTheme`。基座主题跟随色系（暗色为 `vs-dark`，亮色为 `vs`）；token 只决定纸面。新增编辑器颜色时，需要把它加入读取列表，并在每个风格 × 色系块中定义。

## 对比度与控件底线

1. 正文文字对其表面达到 4.5:1。
2. `--mon-t3` 达到 4.5:1；默认调色板中在 `--mon-s1` 上为 5.9:1。
3. 控件与图形达到 3:1。默认调色板中语义种类色在面板上达到 5.5:1。
4. normal、hover、active、focus、selected 五态可辨。hover 换面，active 下沉，focus 绘制 outline ring，selected 带强调边。`shared.css` 提供基线；风格可以在此基础上增加规则，不能删除基线规则。
5. divider 保持可见。
6. `outline: none` 不单独出现。文本输入以光标作为焦点提示并保留边框颜色；其他可聚焦元素绘制 ring。
7. `prefers-reduced-motion: reduce` 停止动画与过渡，包括头像动画。
8. chrome 使用固定尺寸：chip 高 22px，button 高 28px。

## 滚动条例外

不透明主题表面与文字色来自 token。半透明 wash、阴影、focus outline 与局部 fallback 使用默认调色板的字面量。滚动条 chrome 是字面量定义可见表面的例外：

- `.mon-ridesb__thumb` 挂在 `<body>` 上，位于任何 face 的裁剪与层叠上下文之外，face 的 `--mon-*` token 无法到达它。`shared.css` 给它字面量颜色，`themes.css` 再按风格与色系重申。
- `.mon-root` 内的原生 `::-webkit-scrollbar-thumb` 使用字面量灰色（`#3a3a38`，hover 为 `#4b4b48`）并配 token 边框。滚动条 chrome 由浏览器绘制，位于主题表面之外。
- 浮动下拉菜单使用 `.mon-slimscroll`，读取 `--mon-bd2`。

除材质定义外，不透明表面的例外只覆盖滚动条 chrome。背景、文字、边框与控制仍使用上述 token 组。

## 新增或调整风格

**新增风格**

1. 在 `lib/uistyle.ts` 的 `UiStyleId` 与 `UI_STYLES` 中加入 id。
2. 在 `themes.css` 加一段：默认色系 token 块、另一色系覆盖块，以及两种色系的表面组。
3. 为新 id 设置 `defaultScheme`。
4. 在 `lib/i18n.ts` 加入显示名称。
5. `App.tsx` 的移除列表自动覆盖新风格。

**调整某风格的亮色或暗色**

只改对应 `.scheme-*` 块中的 token 值，风格特征规则不变。

**新增表面**

1. 在 `shared.css` 的 `.mon-root` 下加入 token 默认值。
2. 把消费方样式表中的硬编码值改为 `var(...)`。
3. 在 `themes.css` 的每个风格 × 色系块中声明该 token。

**色系变更**

`App.tsx` 显式移除两个色系类。新增色系名称时，需要同步修改该移除步骤与 `lib/uistyle.ts` 的 `SCHEMES`。

## 材质与派生效果

特征效果通过 `color-mix(in srgb, var(--mon-…), …)` 从语义 token 派生颜色：铆钉、纸带边缘、电源纹波、棱镜光晕等装饰都属于此类。材质定义使用字面量，并按色系各声明一套，例如 nixie 的真空管管底与铆接板渐变。材质定义描述材质本身，不描述调色板。

基块承载风格对应的默认色系：ink 的基块是亮色，nixie 与 glass 的基块是暗色。若要为某风格颠倒该顺序，需要为另一色系增加一段；风格与色系之间的接口不变。
