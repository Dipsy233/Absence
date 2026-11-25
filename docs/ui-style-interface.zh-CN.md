# UI 风格与色系接口

[English](ui-style-interface.md) | [简体中文](ui-style-interface.zh-CN.md)

本文定义控制界面观感的两个维度：风格（style）与色系（scheme）。文中列出 token、负责这些 token 的文件、对比度底线，以及新增风格或新增表面的步骤。规则适用于观测台、Monitor、Rounds、Chart、Drip 与 Settings。

## 1. 两个维度

| 维度 | HTML 类 | 控制内容 |
|---|---|---|
| 风格 | `theme-nixie` / `theme-ink` / `theme-glass` | 非颜色属性：字体栈、字距、字号缩放、边框粗细、圆角、图案、效果 |
| 色系 | `scheme-dark` / `scheme-light` | 颜色：背景、文字、边框、语义色、表面色 |

风格规则定义非颜色属性。颜色值来自色系的 token；材质定义见第 7 节。两个维度相互独立，可以分别切换。

## 2. 运行时

```html
<html class="theme-ink scheme-light">
```

- 取值与持久化：`apps/web/src/lib/uistyle.ts`，storage key 为 `absence.uistyle` 与 `absence.uistyle-scheme`。
- 状态：`apps/web/src/stores/uistyleStore.ts`（`uiStyle`、`schemeOverride`）。
- 类的写入：`apps/web/src/app/App.tsx` 的顶层 effect。

该 effect 先按 `UI_STYLES` 移除全部 `theme-*` 类，移除 `scheme-light` 与 `scheme-dark`，再写入 `theme-${uiStyle}` 与 `scheme-${schemeOverride ?? defaultScheme(uiStyle)}`。移除列表由 `UI_STYLES` 生成，新增风格不需要修改另一份移除列表。

每个风格声明自己对应的默认色系：`ink` 默认 `light`；`nixie` 与 `glass` 默认 `dark`。已存储的色系覆盖优先于该默认值。在 `Appearance` 面板中选择该风格的默认色系会清除覆盖。

改动通过 CSS 变量继承即时生效。Drip 跟随同一组文档类；浏览器 PiP 宿主会把类镜像到 PiP 文档。

## 3. 文件

| 文件 | 职责 |
|---|---|
| `apps/web/src/ui/shared/shared.css` | 中性基线：token 默认值（暗色）、原子类（chip、dot、button）、控件可见度规则（focus ring、`accent-color`、hover、active）、`--desk-*` 桥 |
| `apps/web/src/ui/shared/themes.css` | 全部风格与色系差异：每个风格一段基块（其默认色系加风格特征），另一色系一段覆盖块，然后是表面组 |
| `apps/web/src/ui/shared/picker.css`、`observatory.css` | 观测台规则 |
| `apps/web/src/ui/monitor/monitor.css`、`rounds/rounds.css`、`chart/chart.css`、`drip/drip.css` | face 布局与 face 专属规则；主题颜色读取 token，半透明 wash、阴影与局部 fallback 使用字面量 |
| `apps/web/src/lib/uistyle.ts`、`stores/uistyleStore.ts` | 取值、持久化、状态 |
| `apps/web/src/app/App.tsx` | 写入类；为 Monaco 提供纸面色 |
| `apps/web/src/components/common/SettingsDialog.tsx` | `Appearance` 面板控件 |

`themes.css` 在 `shared.css` 之后加载。`FaceBar.tsx` 按该顺序 import 两者。

## 4. 风格接口

风格块可以定义：

- `--mon-sans`：正文与控件字体。默认栈包含 `PingFang SC`、`Microsoft YaHei`、`Noto Sans SC` 以覆盖 CJK。
- `--mon-mono`：等宽位（计数、路径、时间戳）。风格可以把它换成展示字体；Monaco 与 Tailwind 的 `font-mono` 保留各自的字体栈。
- 字号缩放、字距、边框粗细、圆角、装饰背景与效果规则。

风格不得改变 token 的含义：`--mon-err` 在任何风格下都是错误色。

## 5. 色系接口

### 基础 token

| Token | 用途 |
|---|---|
| `--mon-bg`、`--mon-s1`、`--mon-s2`、`--mon-s3` | 页面与表面底色 |
| `--mon-bd`、`--mon-bd2` | 细线与控件边框 |
| `--mon-t`、`--mon-t2`、`--mon-t3` | 正文、次级文字、说明文字 |
| `--mon-think`、`--mon-read`、`--mon-search`、`--mon-edit`、`--mon-run`、`--mon-egg`、`--mon-err` | 活动类别 |
| `--mon-acc` | 强调色、focus ring、选中态 |

### 对比度底线

| Token | 底线 |
|---|---|
| `--mon-t` | 对 `s1` 与 `s2` ≥ 4.5:1 |
| `--mon-t2` | ≥ 4.5:1 |
| `--mon-t3` | ≥ 4.5:1；默认调色板下在 `--mon-s1` 上为 5.9:1 |
| `--mon-bd`、`--mon-bd2` | 对表面可见 |
| `--mon-acc` | ≥ 3:1 |
| 语义类别色 | 默认调色板下在面板上 ≥ 5.5:1，使 11px 标签仍可读 |

`--mon-t3` 是文字 token，即使它标注的是小图标或说明文字，底线同样是 4.5:1。3:1 底线适用于控件与图形。chip 背景使用 14% wash，chip 文字使用语义 token。

### 表面组

| Token | 表面 |
|---|---|
| `--mon-room` | Rounds 房间底色 |
| `--mon-win` | 浮动窗口体 |
| `--mon-card`、`--mon-card-now` | 故事卡片与当前卡片 |
| `--mon-bubble` | 状态气泡与壁纸对话气泡 |
| `--mon-bubble-user`、`--mon-bubble-user-border` | 用户气泡 |
| `--mon-bubble-system` | 系统气泡 |
| `--mon-inp` | Rounds 对话表面；由 Rounds 样式表声明，本构建不渲染输入条 |
| `--mon-dock` | Rounds dock 条 |
| `--mon-paper` | 文本表面：代码与文件内容，包含 Monaco 底与行号槽 |
| `--mon-paper-2` | 次级文本表面，包含当前行高亮 |
| `--mon-paper-t` | 文本表面文字 |
| `--mon-paper-dim` | 文本表面次级文字，包含行号 |
| `--drip-pill`、`--drip-card` | Drip 球与卡 |

表面组在 `themes.css` 中按每个风格与色系声明一次：共六种组合。

### 派生组

| 组 | Token |
|---|---|
| Drip | `--drip-s1`、`--drip-s2`、`--drip-s3`、`--drip-bd`、`--drip-bd2`、`--drip-t`、`--drip-t2`、`--drip-t3`、`--drip-think`、`--drip-read`、`--drip-search`、`--drip-edit`、`--drip-run`、`--drip-err`、`--drip-warn`、`--drip-say`、`--drip-ok`、`--drip-listen`、`--drip-pill`、`--drip-card`、`--drip-sans`、`--drip-mono` |
| Chart | `--ch-*`，结构与 `--mon-*` 相同，前缀为 `ch` |
| Desk 桥 | `--desk-bg`、`--desk-panel`、`--desk-panel2`、`--desk-deep`、`--desk-line`、`--desk-ink`、`--desk-dim`、`--desk-accent`、`--desk-ember`、`--desk-teal`、`--desk-wood`、`--desk-wood-lit`、`--desk-lavender` |
| 滚动条 | `.mon-ridesb__thumb` 与原生滚动条 thumb；见第 8 节 |

Desk 桥以通道三元组书写，使 Tailwind 的 `/40` 等透明度修饰符继续有效。

### Monaco 纸面

Monaco 不能读取 CSS 变量。`App.tsx` 的 effect 用 `getComputedStyle` 从已挂载的 `.mon-root` 读取 `--mon-paper`、`--mon-paper-2`、`--mon-paper-t`、`--mon-paper-dim` 与 `--mon-acc`，再调用 `apps/web/src/lib/monaco.ts` 的 `applyMonacoTheme`。基础主题跟随色系（暗色为 `vs-dark`，亮色为 `vs`），token 只定义纸面。新增编辑器颜色需要同时加入读取列表，并在每个风格 × 色系块中定义。

## 6. 控件底线

1. 正文在其表面上达到 4.5:1。
2. 控件与图形达到 3:1。
3. 常态、悬停、按下、聚焦、选中五种状态可区分。悬停改变表面，按下下移，聚焦绘制 ring，选中带强调色边框。`shared.css` 提供基线；风格可以追加规则，不能移除基线。
4. 分隔线保持可见。
5. `outline: none` 不单独出现。文本输入以光标作为焦点提示并保留边框颜色；其他可聚焦元素绘制 ring。
6. `prefers-reduced-motion: reduce` 停止动画与过渡，包括头像的动画。
7. Chrome 使用固定尺寸：chip 高 22px，按钮高 28px。

## 7. 材质与派生效果

特征效果用 `color-mix(in srgb, var(--mon-…), …)` 从语义 token 派生颜色：铆钉、胶带边缘、电源纹波、棱镜光晕等装饰。材质定义（nixie 管玻璃、铆接钢板渐变等）使用字面量，并按色系各声明一组，因为它们描述材质本身。

基块承载风格的默认色系：ink 的基块是亮色，nixie 与 glass 的基块是暗色。基块为另一色系的风格在覆盖块中声明剩余色系；风格与色系之间的接口不变。

## 8. 滚动条例外

不透明的主题表面与文字颜色来自 token。半透明 wash、阴影、focus 轮廓与局部 fallback 使用默认调色板的字面量。滚动条 chrome 是唯一由字面量定义可见表面的位置：

- `.mon-ridesb__thumb` 挂载在 `<body>` 上，位于任何 face 的裁剪与层叠上下文之外，face 的 `--mon-*` token 无法到达它。`shared.css` 给它字面量颜色，`themes.css` 按风格与色系重述该颜色。
- `.mon-root` 内的原生 `::-webkit-scrollbar-thumb` 使用字面量灰色（`#3a3a38`，悬停 `#4b4b48`）配 token 边框，因为滚动条 chrome 由浏览器绘制，位于主题表面之外。
- 浮动下拉使用 `.mon-slimscroll`，读取 `--mon-bd2`。

除材质定义外，滚动条 chrome 是唯一由字面量定义的不透明表面。

## 9. 新增或修改风格

**新增风格**

1. 在 `lib/uistyle.ts` 的 `UiStyleId` 与 `UI_STYLES` 中加入 id。
2. 在 `themes.css` 中加入一段：默认色系 token 块、另一色系覆盖块，以及两个色系的表面组。
3. 为新 id 设置 `defaultScheme`。
4. 在 `lib/i18n.ts` 中加入显示名。
5. `App.tsx` 的移除列表自动覆盖新风格。

**修改风格的亮色或暗色外观**

只修改对应 `.scheme-*` 块中的 token 值，风格特征规则不变。

**新增表面**

1. 在 `shared.css` 的 `.mon-root` 下加入 token 默认值。
2. 把使用方样式表中的硬编码值替换为 `var(...)`。
3. 在 `themes.css` 的每个风格 × 色系块中声明该 token。

**新增色系**

在 `lib/uistyle.ts` 的 `SCHEMES` 中加入名称，并更新 `App.tsx` 中的显式移除步骤。
