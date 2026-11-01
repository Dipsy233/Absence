# UI 风格与色系接口

> 整个 UI（Monitor / Rounds / Chart / Drip / ProjectPicker / Settings）的观感由两个
> 独立的维度决定，二者正交、各自持久化、可独立切换：
>
> | 维度 | html 类 | 管什么 | 例子 |
> |---|---|---|---|
> | **风格 style** | `theme-nixie` / `theme-ink` / `theme-glass` | **一切非颜色元素**：字体栈、字距、字号缩放、控件形状（边框粗细/圆角）、效果（辉光/噪点/磨砂/歪斜） | Ink 的手写体与歪斜墨线、Nixie 的铆接板、Glass 的直角磨砂 |
> | **色系 scheme** | `scheme-dark` / `scheme-light` | **一切颜色**：token 调色板（背景、文字、边框、语义色、表面色） | Nixie 的琥珀暗色 / 黄铜亮色 |
>
> 规则一句话：**风格规则不许写颜色，色系规则不许写字体和形状。**

---

## 1. 运行时约定

```
<html class="theme-ink scheme-light">   ← App.tsx 根据 store 写入
```

- 风格与色系的取值、持久化：`lib/uistyle.ts`（storage key
  `absence.uistyle` / `absence.uistyle-scheme`）。
- 状态：`stores/uistyleStore.ts`（`uiStyle` + `schemeOverride`）。
- 类的写入：`app/App.tsx` 顶层 effect——先移除全部 `theme-*` 与
  `scheme-*`，再写入当前值。**新增风格/色系时必须同步这里的移除列表。**
- 每个风格声明自己"为哪个色系设计"（`defaultScheme`：ink → light，
  nixie/glass → dark）。用户没有显式选过色系时跟随该默认。
- 切换即时生效（CSS 变量继承），不需要刷新；Drip 的浮动窗口因为在
  同一个 document 里，自动跟随。

## 2. 文件与职责

| 文件 | 职责 |
|---|---|
| `ui/shared/shared.css` | **中性基线**：全部 token 的默认值（暗色）、原子类（chip/dot/btn）、控件可见度基线（focus ring、accent-color、hover/active） |
| `ui/shared/themes.css` | **风格与色系的全部差异**。结构：每风格一段（基段 = 其默认色系的 token + 风格特征规则），`scheme-*` 覆盖段 = 另一色系的 token。文件按 nixie → ink → glass → 共享特征排序 |
| `ui/shared/picker.css`、`ui/*/​*.css` | **只消费 token**，不允许出现硬编码表面色/文字色 |
| `lib/uistyle.ts`、`stores/uistyleStore.ts` | 取值/持久化/状态 |
| `app/App.tsx` | 把状态写到 `<html>` 上 |

## 3. 风格接口（非颜色）

风格在 `.theme-<id>` 下**允许**定义的内容：

### 3.1 字体
| Token | 语义 |
|---|---|
| `--mon-sans` | 全部正文与控件字体 |
| `--mon-mono` | 等宽位（计数、路径、时间戳）。风格可以把它整个换成特色字体（Ink 换成手写族）；代码纸单里的 Monaco 与 tailwind `font-mono` 自带字体，不受影响 |
| `--mon-hand` | （可选）辅助手写族，供风格内部引用 |
| `font-size` / `letter-spacing` / `zoom` | 字号基线与补偿（如 Ink 的 `zoom: 1.12` 补手写族的小 x-height） |

### 3.2 控件与形状
- 边框粗细与圆角（含"手绘歪斜"的有机圆角）；
- 控件底色**图案**（渐变方向、内阴影——不含颜色本身的色相/明度选择，
  颜色一律走 token；允许引用 token 组合，如 `linear-gradient(180deg, var(--mon-s2), var(--mon-s3))`）；
- 特殊效果：Nixie 的辉光 text-shadow、Ink 的纸噪点（`body::after` +
  feTurbulence data-URI，`mix-blend-mode: multiply`）、Glass 的
  `backdrop-filter`；
- 缩放（zoom）与专属的伪元素装饰。

### 3.3 三个风格的实现清单
| 风格 | 字体 | 特征 |
|---|---|---|
| **Nixie** | 默认 sans/mono | 铆接金属板按钮（渐变+内阴影）、刻蚀宽字距标题、辉光数字、真空管 arrival（`<Nixie>` 只在此风格跳数） |
| **Ink** | sans 与 mono 整栈手写（Caveat + 851手写杂书体，`public/fonts/`） | 1.6px 墨线、有机圆角（歪斜）、纸噪点覆盖层、卡片微倾、`zoom: 1.12` |
| **Glass** | 默认 sans/mono | 全控件 6px 直角、hairline 建筑感、顶栏/气泡磨砂、玻璃渐变环境光 |

## 4. 色系接口（颜色）

色系把下面的 token 表整体重映射。**基段 = 该风格的默认色系**（写在
`.theme-<id> …` 下），另一色系写在 `.theme-<id>.scheme-light …`（或
`.scheme-dark`）下。两套都必须完整声明"表面组"，文字/语义组没有声明
的项继承基段。

### 4.1 基面与文字
| Token | 语义 | 对比度要求 |
|---|---|---|
| `--mon-bg` | 页面底 | — |
| `--mon-s1` | 面板/顶栏 | — |
| `--mon-s2` / `--mon-s3` | 次级/三级面板、hover 面 | 与 s1 可辨 |
| `--mon-t` | 正文 | ≥ 4.5:1（对 s1/s2） |
| `--mon-t2` | 次级文字 | ≥ 4.5:1 |
| `--mon-t3` | 说明文字、图标 | ≥ 3:1 |
| `--mon-bd` / `--mon-bd2` | hairline / 控件边界 | 与底可辨（divider 明度差） |
| `--mon-acc` | 强调、focus ring、选中 | ≥ 3:1 |

### 4.2 语义色（活动种类）
`--mon-think / read / search / edit / run / egg / err` —— 每种 ≥ 3:1，
且 chip 底（同色 12% wash）上文字可读。

### 4.3 表面组（解耦的核心）
| Token | 表面 |
|---|---|
| `--mon-room` | Rounds 房间底色 |
| `--mon-win` | 浮动窗口体（活动窗口 / dock 窗口） |
| `--mon-card` / `--mon-card-now` | story 卡片 / 当前高亮卡 |
| `--mon-bubble` | 状态气泡与壁纸聊天气泡 |
| `--mon-bubble-user` (+ `-border`) | 用户气泡 |
| `--mon-bubble-system` | 系统气泡 |
| `--mon-inp` | 底部输入条 |
| `--mon-dock` | Rounds 右缘 dock 条 |
| `--mon-paper` | **文本视图纸面**：代码 / 文件内容（Monaco 编辑器底与行号槽） |
| `--mon-paper-2` | 纸面次级面（当前行高亮） |
| `--mon-paper-t` | 纸面默认文字（语法色跟随色系基座，不由 token 决定） |
| `--mon-paper-dim` | 纸面弱文字（行号） |
| `--drip-pill` / `--drip-card` | Drip 球 / 卡 |

**文本视图纸面的特殊性**：Monaco 不能读 CSS 变量，所以这四个 token 由
`app/App.tsx` 的 effect 在每次风格 / 色系 / face 变化时 `getComputedStyle`
从挂载的 `.mon-root` 读出，喂给 `lib/monaco.ts` 的
`applyMonacoTheme(partial, dark)` 重定义编辑器主题。**基座跟随色系**
（dark → `vs-dark`，light → `vs`）——语法配色是基座自带的，token 只决定
纸面。若编辑器需要新颜色，必须同步扩 `applyMonacoTheme` 的读取列表，
并在六个 风格×色系 块里各给一行。

### 4.4 其他派生面
| 组 | Token |
|---|---|
| Drip 全套 | `--drip-bg/s1/s2/s3/bd/bd2/t/t2/t3` + 语义色 + `--drip-ok/listen` |
| Chart 全套 | `--ch-*`（与 --mon-* 同构，前缀 ch） |
| 桌面桥 | `--desk-bg/panel/panel2/deep/line/ink/dim/accent/ember/teal/wood/wood-lit/lavender`（reused 组件与 Settings 的 tailwind `desk-*` 类读这里） |
| 滚动条 | `.mon-ridesb__thumb`（body 层，取不到 token，用字面量并在每风格重申） |

## 5. 对比度底线（验收标准）

1. 正文文字 ≥ 4.5:1；2. 控件与图形 ≥ 3:1；3. normal / hover / active /
   focus / selected 五态可辨（hover 换面、active 下沉、focus 有
   outline ring、selected 有强调边——基线在 shared.css，风格可加码不可
   减码）；4. divider 必须可见；5. `outline: none` 不允许单独出现。

## 6. 怎么加

**加一个新风格**：① `lib/uistyle.ts` 的 `UiStyleId`/`UI_STYLES` 加 id；
② `themes.css` 加一段（默认色系 token + 风格特征，另一色系覆盖段）；
③ `lib/uistyle.ts` 的 `defaultScheme` 定默认色系；④ i18n 加名字；
⑤ App.tsx 的移除列表会自动覆盖（它遍历 `UI_STYLES`）。

**调某个风格的亮/暗**：只动 `themes.css` 里对应 `.scheme-*` 段的 token
值，不碰风格段。

**新增一个表面**：先在 shared.css `.mon-root` 加 token 默认值 → 把相关
css 的硬编码换成 `var(...)` → 六个风格 × 色系块里各给一行。禁止在任何
face css 里新增硬编码表面色。

## 7. 现状备注

- 基段当前承载的是各风格的**暗色** token（ink 是 light）——即"基段 =
  默认色系"，light 是覆盖段。若未来某风格要把亮/暗顺序颠倒，按同样
  结构加段即可，接口不变。
- 噪点/磨砂等效果若要跨风格复用，抽成 shared.css 的混合宏（mixin 注释
  约定），不要复制 data-URI。
- 特征规则（铆钉、刻录纸带、电源纹波、棱镜光晕、水银球、折射线、辉光管
  按钮辉光等）的颜色一律用 `color-mix(in srgb, var(--mon-…), …)` 从语义
  token 派生——新写特征效果时照此办理，不要写字面量；两个色系下自动
  各自成立。管底/按钮板这类"材质本身"的渐变（nixie 暗管、铆接板）仍是
  字面量，属于材质定义而非调色，两色系各自给一套（见
  `.theme-nixie.scheme-light` 的辉光管覆盖）。
