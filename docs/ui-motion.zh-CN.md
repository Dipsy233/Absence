# 运动与动效

[English](ui-motion.md) | [简体中文](ui-motion.zh-CN.md)

本文描述 `apps/web` 的运动层：动效由谁驱动、按什么节奏播放、三种 UI 风格各自的运动语法，以及运动层的盘点与已实施的优化。它不改变 [ui-faces.md](ui-faces.md) 描述的界面结构，也不改变 [ui-style-interface.md](ui-style-interface.md) 定义的风格与色系维度。

## 实施状态

P0–P2 项已实施。第 1 节保留改动前的盘点与原始结论。实施中有两处偏离原方案：

- **Rounds 状态气泡的模糊保留。** P0-5 曾建议同时移除窗口与状态气泡的 `backdrop-filter`；[ui-style-interface.md](ui-style-interface.md) 把磨砂顶栏与状态气泡列为 Glass 的签名特征。最终做法：nixie / ink 的窗口（底色 85–92% 不透明）移除模糊；Glass 的窗口保留模糊（其 `--mon-win` 仅 6% 白），拖拽期间临时关闭。
- **Ink 沸腾未按卡片做可见性门控。** 按卡片门控会把共享的 `InkBoil` 与 Rounds 的卡片类耦合。seed 步进从 250ms 放宽到 333ms（一拍三）；是否进一步做可见性门控取决于性能采样结果。

## 盘点结论

动效层具备以下基础：

- `apps/web/src/lib/anim.ts` 提供闭合形式的阻尼弹簧（`spring` / `springV` / `pop`）与 `tween`，不依赖任何动画库。
- 代码中没有 `transition: all`，没有 `scale(0)` 入场。
- 右键菜单、Activity 信息流、键盘动作与逐事件计数不做入场动画，高频表面保持静止。
- `prefers-reduced-motion` 的全局停止策略在 [ui-style-interface.md](ui-style-interface.md) 第 7 条中规定，并保持生效。

改动前的盘点把问题分为四类：

1. **主线程逐帧路径**：Rounds 窗口拖拽/缩放每帧调用 `setState`；DiffStage 有 framer-motion 入场；FaceRise 在整棵 face 挂载时用 rAF 写样式。
2. **高频表面上的装饰动效**：Nixie 在每次数值变化时重掷 500ms 乱码；DiffStage 每次重挂载扫一道 1s 光；`box-shadow` 无限脉冲。
3. **风格语法不统一**：页面入场（`mon-flick`）、提示卡入场（`att-in`）、DiffStage 入场，同一套动作同时服务 Nixie / Ink / Glass；Ink 卡片悬停的 transform 还被主题的倾斜规则覆盖。
4. **缺少动效 token**：时长与曲线由各文件手写为 `0.12s` / `0.14s` / `0.16s` / `0.18s` / `0.5s`，没有可复用的入场原语。

## 1. 改动前盘点

| 动效 | 位置 | 驱动 | 属性 | 频率 | 处理 |
|---|---|---|---|---|---|
| Face 入场 | [FaceRise.tsx](../apps/web/src/ui/shared/FaceRise.tsx#L15-L30) | JS rAF | `opacity` / `transform` | 每次切 face | 保留意图，改由 CSS 编排 |
| Nixie 数字落定 | [Nixie.tsx](../apps/web/src/ui/shared/Nixie.tsx#L105-L126) | JS rAF | `textContent` | 每次数值变化 | 限频并量化到 15fps |
| 页面上电 `mon-flick` | [shared.css](../apps/web/src/ui/shared/shared.css#L605-L631) | CSS | `opacity` | 页面切换 | 保留，限定为 Nixie 语法 |
| Ink 描边沸腾 | [InkBoil.tsx](../apps/web/src/ui/shared/InkBoil.tsx#L24-L34) | `setInterval` 250ms | SVG filter seed | 持续（Ink） | 降频，限制为可见元素 |
| Ink 墨滴 | [themes.css](../apps/web/src/ui/shared/themes.css#L558-L605) | CSS | `transform` / `border-radius` / `box-shadow` | 状态变化 + 持续 | 墨晕改伪元素 |
| Nixie 电源纹波 | [themes.css](../apps/web/src/ui/shared/themes.css#L209-L251) | CSS | `transform` / `opacity` | agent 运行中 | 保留（合成属性） |
| 环境光漂移 | [shared.css](../apps/web/src/ui/shared/shared.css#L531-L562)、[rounds.css](../apps/web/src/ui/rounds/rounds.css#L32-L51) | CSS | `transform` | 持续 | 保留；玻璃模糊层每帧重采样 |
| 鲸团团角色 | [whalebun.css](../apps/web/src/components/agent/whalebun.css#L78-L267) | CSS | `transform` / `opacity` | 持续 | 保留；复核 `will-change` |
| 提示卡入场 | [attention.css](../apps/web/src/components/attention/attention.css#L66-L76) | CSS | `transform` / `opacity` | 偶发 | 保留，补错峰与主题语法 |
| Drip 展开/折回 | [drip.css](../apps/web/src/ui/drip/drip.css#L620-L651) | CSS keyframes | `transform` / `opacity` | 开关 | 折回缓动方向需调整 |
| 卡片悬停 | [rounds.css](../apps/web/src/ui/rounds/rounds.css#L537-L567) | CSS | `transform` + `box-shadow` | 高频 | 去掉 `box-shadow` 过渡 |
| 当前卡脉冲 | [rounds.css](../apps/web/src/ui/rounds/rounds.css#L608-L625) | CSS | `box-shadow` | 持续 | 改伪元素 `opacity` |
| 时间轴游标 | [chart.css](../apps/web/src/ui/chart/chart.css#L603-L611)、[monitor.css](../apps/web/src/ui/monitor/monitor.css#L623-L631) | CSS | `left` | 重放/选择 | 改 `transform` |
| Diff 入场与扫光 | [DiffStage.tsx](../apps/web/src/components/stage/DiffStage.tsx#L87-L114) | framer-motion | `opacity` / `y` / 渐变 | 每次 StageItem 重挂载 | 删除 |
| 窗口拖拽/缩放 | [RoundsWindow.tsx](../apps/web/src/ui/rounds/RoundsWindow.tsx#L46-L68) | React state | `left` / `top` / `width` / `height` | 拖拽时 | 改 ref 直写 |
| Drip 胶囊宽度 | [drip.css](../apps/web/src/ui/drip/drip.css#L570-L575) | CSS | `width` | 开关/悬停 | 保留（无同视觉替代） |
| Glass 按钮光泽 | [themes.css](../apps/web/src/ui/shared/themes.css#L882-L900) | CSS | `background-position` | 按钮悬停 | 改伪元素 `translateX` |

## 2. 三种风格的运动语法

| 风格 | 运动语法 | 避免 |
|---|---|---|
| Nixie | 仪表感：数字 3–5 帧滚动后落定；面板上电是 4 帧 alpha 序列；位移 4px 以内；进入 180ms；只在状态变化时落定 | 长缓动、连续呼吸、在每秒变化的读数上重掷 |
| Ink | 手绘感：一拍二/一拍三的离散节奏；描边与纸面以 `clip-path` 揭示；轻微过冲（`cubic-bezier(0.2, 0.8, 0.3, 1.3)`）；进入 260ms | 高斯模糊、玻璃质感的高光扫过、匀速线性位移 |
| Glass | 慢、透：`opacity` + 8px 上浮 + `scale(0.98)`；只有胶囊与水银球允许弹簧；进入 380–500ms；交叉淡入允许 `blur(2px)` | 快动作、弹跳、超过 20px 的动态模糊 |

通用值（中性基线，三种风格再覆盖）：

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

风格覆盖（`themes.css`，与现有 token 同一套写法）：

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

频率门槛：

| 频率 | 处理 |
|---|---|
| 每天 100+ 次（右键菜单、键盘、切换页签内的行） | 不做动画 |
| 每天数十次（按钮、dock、卡片悬停） | 只做 100–160ms 的反馈 |
| 偶发（切 face、开窗、设置、Drip） | 标准入场 180–380ms |
| 稀有（首次报告、运行结束） | 可以做一次短促的落定动画 |

## 3. 优化项

### P0-1 Rounds 窗口拖拽与缩放

位置：[RoundsWindow.tsx](../apps/web/src/ui/rounds/RoundsWindow.tsx#L40-L69)

**改动前**：拖动窗口时整窗内容（含 Monaco 与文件列表）每帧重新渲染；Glass 主题下窗口还有 `backdrop-filter: blur(14px)`，拖动时每帧重新采样移动的环境光。

**原因**：`pointermove` 直接调用 `setPos` / `setDim`，React 每帧调度一次渲染；位置使用 `left` / `top`，属于布局属性。

**改动**：

```tsx
const winRef = useRef<HTMLElement | null>(null);
const posRef = useRef(initial);

const move = (event: ReactPointerEvent<HTMLElement>) => {
  if (!drag.current) return;
  const x = Math.min(Math.max(4, drag.current.x + event.clientX - drag.current.px), window.innerWidth - 140);
  const y = Math.min(Math.max(4, drag.current.y + event.clientY - drag.current.py), window.innerHeight - 90);
  posRef.current = { x, y };
  // 只写这个元素的 transform，不进入 React 渲染
  winRef.current!.style.transform = `translate3d(${x}px, ${y}px, 0)`;
};

const up = () => {
  if (!drag.current) return;
  drag.current = null;
  grow.current = null;
  setPos(posRef.current);      // 一次提交，供下一次拖拽或重排使用
};
```

窗口基准样式改为 `left: 0; top: 0`，位置只由 `transform` 表达（React 渲染时同样写 `translate3d(x, y, 0)`，拖拽时由 ref 覆写同一属性）；拖拽期间设置 `data-drag`：

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

缩放没有 `transform` 等价物，因为内容需要重排；`winRef.current.style.width/height` 逐帧直写、松手再提交，避免整棵子树重新渲染。

**验证**：Rounds 同时开 3 个窗口，其中一个含 Monaco；录制 5 秒拖拽，对比改动前后的掉帧与 Long Task。

### P0-2 Nixie：在状态变化时落定

位置：[Nixie.tsx](../apps/web/src/ui/shared/Nixie.tsx#L51-L126)；调用点 [FaceBar.tsx](../apps/web/src/components/layout/FaceBar.tsx#L128-L139)、[MonitorLeft.tsx](../apps/web/src/ui/monitor/MonitorLeft.tsx#L290-L301)、[DripUI.tsx](../apps/web/src/ui/drip/DripUI.tsx#L238-L255)

**改动前**：Nixie 主题下，context 用量与 R/S/E/$ 计数在流式输出时持续变化。每次变化都重开 500ms 的 rAF 乱码，前 70% 逐帧重写所有数字单元，形成几乎常驻的逐帧 DOM 写入，读数持续抖动。

**原因**：落定效果没有频率门槛；`text` 是 effect 依赖，变化即重放。

**改动**：在组件内部增加最小间隔；首次挂载仍然播放：

```tsx
const lastSettled = useRef(-Infinity);

// 上次结果刚落下就再次变化：直接落值，不再掷骰
const canArrive = performance.now() - lastSettled.current > 900;
if (resolved !== "tube" || prefersReducedMotion() || !canArrive) {
  /* 直接写入最终值 */
  lastSettled.current = performance.now();
  return;
}
```

同时用现有的 `frameOf` 把乱码量化到 15fps：

```tsx
const frame = frameOf(t / 1000);
if (frame !== lastFrame) {
  lastFrame = frame;
  /* 重写 volatile cells */
}
```

**验证**：Nixie 主题与 mock agent 全速运行；DevTools Performance 中不再出现连续的 rAF 流，界面计数以跳变方式更新。

### P0-3 DiffStage：移除 framer-motion 入场与扫光

位置：[DiffStage.tsx](../apps/web/src/components/stage/DiffStage.tsx#L86-L115)

**改动前**：Monitor 的 Stage 以 `key={shownItem.id}` 重挂载（[MonitorStage.tsx](../apps/web/src/ui/monitor/MonitorStage.tsx#L315)），每出现一个新 diff 都在当前展示内容上播放 0.5s 的 `y: 8 → 0` 入场与 1s 扫光。它是实现中唯一使用 framer-motion 的地方。

**原因**：为偶发弹层准备的入场被用在高频阅读面上；framer-motion v11 的 `y` 简写不保证硬件加速（加速保证从 motion 14.2 起），并与数据到达、React 挂载竞争。

**改动**：删除 `motion.div` 与扫光元素，保留 120ms 的透明度过渡以避免硬切，不加入位移：

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

随后从 `apps/web/package.json` 移除 `framer-motion`，同时移除主线程动画运行时。

**验证**：连续触发多次文件编辑，Stage 保持可读且不位移；`npm run build` 产物体积下降。

### P0-4 无限 `box-shadow` 脉冲

位置：[rounds.css](../apps/web/src/ui/rounds/rounds.css#L608-L625)、[themes.css](../apps/web/src/ui/shared/themes.css#L595-L605)

**改动前**：Rounds 的当前卡每 2.6s 动画 `box-shadow`；Ink 的每个状态点每 2.2s 用 `box-shadow` 洇开。`box-shadow` 不在合成层，这些元素持续重绘。

**改动**：发光由静态阴影的伪元素承担，只动画它的 `opacity` / `scale`：

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

Ink 的墨晕采用相同模式（`.mon-dot` 加 `position: relative`，伪元素 `inset: -2px`，动画 `opacity` + `scale(1 → 2.2)`），保留原有的 `mon-ink-blob` 双帧圆角。

**验证**：Ink 主题下 Activity 出现 20+ 行，Performance 面板中不再有逐帧 Paint。

### P1-1 动效 token 与入场原语

新增 `.mon-root` 的运动 token（见第 2 节）以及一个可复用类：

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

`@starting-style` 在 Electron 37（Chromium 138）与当前浏览器构建中可用；它让挂载即入场不需要 JS 挂载标记。`--mon-delay` 只用于成组入场的错峰，上限 240ms，不阻塞交互。

`apps/web/src/lib/anim.ts` 增加一个纯函数：

```ts
/** 成组入场的错峰：单项 40ms，总计不超过 240ms。 */
export const stagger = (index: number, step = 40, cap = 240): number =>
  Math.min(index * step, cap);
```

### P1-2 页面入场按主题分工

位置：[FaceRise.tsx](../apps/web/src/ui/shared/FaceRise.tsx#L15-L30)、[MonitorStage.tsx](../apps/web/src/ui/monitor/MonitorStage.tsx#L300-L315)

**改动前**：FaceRise 使用 560ms 的 JS 弹簧；Stage 的页面上电固定使用 `mon-flick`。两者都在三种主题下播放同一套动作，而 `mon-flick` 属于 Nixie 的设备上电。

**改动**：FaceRise 改为纯 CSS 类，消除 face 挂载时的 rAF 竞争；页面入场由主题决定：

```css
.mon-pagein {
  animation: mon-rise var(--motion-dur-enter) var(--motion-ease-out) both;
}
@keyframes mon-rise {
  from { opacity: 0; transform: translateY(var(--motion-rise)) scale(var(--motion-scale)); }
  to   { opacity: 1; transform: none; }
}

/* 页面换页（原 .mon-flick 的调用点） */
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

`mon-flick` 保留给 Nixie；Ink 用 `clip-path` 绘制；Glass 以 8px 上浮与 2px 模糊入场。组件只携带类名，不读取主题。

### P1-3 Ink 卡片悬停与倾斜规则

位置：[themes.css](../apps/web/src/ui/shared/themes.css#L543-L549)、[rounds.css](../apps/web/src/ui/rounds/rounds.css#L562-L567)

**改动前**：`.theme-ink .rounds-card:nth-child(odd)` 的 `transform: rotate(0.45deg)` 特异性高于 `.rounds-card:hover`，Ink 主题下卡片悬停不放大，`transition` 中的 `transform` 也不发生。

**改动**：倾斜存入自定义属性，悬停时组合：

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

同时从过渡列表移除 `box-shadow`；它每帧重绘，阴影直接使用终值，`transform` 的放大已经提供抬升反馈。

### P1-4 时间轴游标：`left` 改为 `transform`

位置：[chart.css](../apps/web/src/ui/chart/chart.css#L603-L611)、[monitor.css](../apps/web/src/ui/monitor/monitor.css#L623-L631)、[ChartTimeline.tsx](../apps/web/src/ui/chart/ChartTimeline.tsx#L136-L142)、[MonitorStage.tsx](../apps/web/src/ui/monitor/MonitorStage.tsx#L811-L813)

重放时游标位置连续变化，`left` 过渡会让浏览器每帧做一次布局与绘制。游标改为全宽包裹，按轨道宽度的百分比平移：

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

Monitor 的 `.mon-tl__head` 采用同样处理；标签跟随包裹移动，锚定在线条位置。

### P1-5 Rounds 窗口入场

位置：[RoundsWindow.tsx](../apps/web/src/ui/rounds/RoundsWindow.tsx#L71-L105)

窗口此前瞬现。其来源是右侧 dock，入场从该方向展开：

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

使用独立的 `scale` 属性，避免与拖拽的 `translate3d` 冲突。关闭保持瞬断；关闭窗口是高频且主动的动作。

### P2-1 提示卡：主题语法与错峰

位置：[attention.css](../apps/web/src/components/attention/attention.css#L66-L76)、[AttentionNotice.tsx](../apps/web/src/components/attention/AttentionNotice.tsx)

提示卡偶发但会成组到达。保留现有的 180ms 入场，并做三处调整：

- 使用主题曲线（`var(--motion-ease-out)`）；
- 给第 2、3 张加 `--mon-delay`（40/80ms）；
- Activity 中的 Attention 行不加动画，该列表属于高频表面。

### P2-2 按钮按压反馈与悬停门控

位置：[shared.css](../apps/web/src/ui/shared/shared.css#L231-L281)、[rounds.css](../apps/web/src/ui/rounds/rounds.css#L902-L911)

- 按压：`.mon-btn:active:not(:disabled)`、`.rounds-di:active` 使用 `transform: scale(0.97)`，过渡 140ms，作为反馈。
- 悬停位移（卡片 `translateY(-2px)`、dock `translateY(-1px)`）置于 `@media (hover: hover) and (pointer: fine)` 内，避免触屏点按触发假 hover。

### P2-3 Nixie 灯丝与 Ink 沸腾的频率

- `.theme-nixie .mon-nix__cell--settled` 的 `filter: brightness()` 使用 `steps(1, end)`：每 3.7s 三个离散跳变，不做连续插值。
- `InkBoil` 的 seed 步进从 250ms 放宽到 333ms（一拍三）。Rounds 只让可见卡片参与沸腾（`IntersectionObserver`，或只让 `data-now` / hover 卡引用 `#mon-ink-boil` 过滤器）；30 张卡片同时沸腾是该实现中渲染开销最高的一项。

### P2-4 设置弹窗入场

位置：[SettingsDialog.tsx](../apps/web/src/components/common/SettingsDialog.tsx#L50-L60)

模态框位于屏幕中心，缩放居中：遮罩 200ms `opacity`，面板 250ms `opacity` + `scale(0.96)`（`.mon-arrive` 即可）。该动作低频，保留这段动效。

## 4. 实施顺序

| 阶段 | 内容 | 理由 |
|---|---|---|
| A 地基 | 运动 token、`.mon-arrive`、`.mon-pagein`；FaceRise 改 CSS；DiffStage 去掉 framer-motion | 统一动效写法，后续项复用 |
| B 性能 | Rounds 窗口拖拽；Nixie 限频 + 15fps；无限 `box-shadow` 改伪元素；时间轴游标；窗口/气泡去 `backdrop-filter` | 消除真实掉帧与主线程占用 |
| C 语法 | Ink 悬停修复；页面入场按主题；提示卡错峰；窗口入场；Drip 折回缓动改 `ease-out` | 统一三种风格的运动语言 |
| D 打磨 | 按压反馈、悬停门控、灯丝/沸腾降频、设置弹窗 | 完成手感，不改结构 |

**验收**：

1. `npm run typecheck` 与 `npm run build` 通过。
2. 3 风格 × 2 色系 × 4 个表面（Monitor / Rounds / Chart / Drip）逐一检查；入场不遮挡内容、不阻塞点击。
3. DevTools Performance：Rounds 拖拽（含 Monaco 窗口）、Nixie 全速运行、Ink 30 卡三种场景各录制 5 秒，确认无新增 Long Task。
4. 模拟 `prefers-reduced-motion: reduce`：所有动画与过渡立即停止，沿用现有策略。
5. 高频表面复查：Activity 行、右键菜单、键盘动作、逐事件计数仍然不做动画。
6. 移除 `framer-motion` 后构建产物体积下降。

## 5. 范围之外

- **Activity 行、时钟、context 用量与 R/S/E/$ 计数不做入场动画。** 它们属于高频功能数据；Nixie 的落定已经表达状态变化。
- **`prefers-reduced-motion` 的全停策略保持不变。** 它写在 [ui-style-interface.md](ui-style-interface.md) 中，属于既定决策。
- **Drip 胶囊宽度继续使用 `width`。** `scaleX` 会拉伸文字，`clip-path` 无法改变胶囊占位；这是没有同视觉替代的布局动画。
- **右键菜单、页签与 `⏎` 快捷键不做入场。** 这些动作每天执行上百次。
- **不引入动画库。** `lib/anim.ts` 的闭合弹簧已经足够，且移除 framer-motion 依赖。

## 6. 设计约束

- 动画使用 `transform` 与 `opacity`；不使用 `transition: all`。
- 动效频率遵循第 2 节的门槛；高频动作不做入场。
- `box-shadow` 不参与合成，不直接动画；脉冲改用伪元素的 `opacity`。
- 时长、位移与曲线来自第 2 节的运动 token；风格差异通过覆盖值表达。
- 进入与退出使用 `ease-out`；按压反馈保持在 100–160ms 区间。
