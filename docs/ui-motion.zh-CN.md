# 运动与动效

[English](ui-motion.md) | [简体中文](ui-motion.zh-CN.md)

本文描述 `apps/web` 的运动层：动效由什么驱动、按什么节奏播放、三种 UI 风格各自的运动语法，以及当前实现对应的盘点。它不改变 [ui-faces.zh-CN.md](ui-faces.zh-CN.md) 描述的界面结构，也不改变 [ui-style-interface.zh-CN.md](ui-style-interface.zh-CN.md) 定义的风格与色系维度。

## 1. 原则

| 原则 | 规则 |
|---|---|
| 频率门槛 | 更新频率高于约每秒一次的界面不做入场动画；状态变化可以落定一次数值 |
| 只动合成属性 | 位移只用 `transform` 与 `opacity`，不驱动布局属性 |
| 时间函数 | 动效表达为关于时间的纯函数（`apps/web/src/lib/anim.ts`）；face 不依赖动画库 |
| 减弱动效 | `prefers-reduced-motion: reduce` 停止动画与过渡，包括头像 |
| 风格语法 | 每种风格拥有一种运动语法；同一动作在不同风格下可以不同，但含义一致 |

`apps/web/src/lib/anim.ts` 提供闭合形式的阻尼弹簧（`spring`、`springV`、`pop`）、缓动函数、帧量化（`frameOf`，15 fps）、确定性哈希，以及遵守减弱动效设置的一次性 tween（`tween`）。

## 2. 运动语法

| 风格 | 语法 | 避免 |
|---|---|---|
| Nixie | 仪表感：数字滚动 3–5 帧后落定；页面上电是 4 帧 alpha 序列；位移不超过 4px；入场 180ms；只在状态变化时落定 | 长缓动、连续呼吸、对每秒变化的读数重掷 |
| Ink | 手绘感：一拍二或一拍三的离散节奏；描边与纸面以 `clip-path` 揭示；轻微过冲（`cubic-bezier(0.2, 0.8, 0.3, 1.3)`）；入场 260ms | 高斯模糊、玻璃高光、匀速线性位移 |
| Glass | 慢而透：`opacity` 加 8px 上浮与 `scale(0.98)`；只有胶囊与水银球允许弹簧；入场 380–500ms；交叉淡入允许 `blur(2px)` | 快动作、弹跳、超过 20px 的模糊 |

频率门槛：

| 频率 | 处理 |
|---|---|
| 每天 100 次以上（右键菜单、键盘动作、页签内的行） | 不做动画 |
| 每天数十次（按钮、dock、卡片悬停） | 只做 100–160ms 反馈 |
| 偶发（切 face、开窗、设置、Drip） | 标准入场 180–380ms |
| 稀有（首次报告、运行结束） | 一次短促的落定动画 |

## 3. 盘点

| 动效 | 位置 | 驱动 | 属性 | 频率 | 处理 |
|---|---|---|---|---|---|
| Face 入场 | `ui/shared/FaceRise.tsx` | JS rAF（`tween`） | `opacity`、`transform` | 每次切 face | 560ms 弹簧、12px 上浮；结束后清除内联样式 |
| Nixie 数字落定 | `ui/shared/Nixie.tsx` | JS rAF | `textContent` | 每次数值变化 | 500ms 乱码，只重写可变单元；末段 30% 降为隔帧 |
| 页面上电 | `ui/shared/shared.css`（`.mon-flick`） | CSS | `opacity` | Metrics/Chat 换页 | 0.33s 线性闪烁 |
| Ink 描边沸腾 | `ui/shared/InkBoil.tsx` | `setInterval` 250ms | SVG filter seed | 持续（Ink） | 三个 seed 轮换；减弱动效时停止 |
| Ink 墨滴 | `ui/shared/themes.css` | CSS keyframes | `transform`、`border-radius`、`box-shadow` | 状态变化 | 墨晕以伪元素绘制 |
| Nixie 电源纹波 | `ui/shared/themes.css` | CSS | `transform`、`opacity` | agent 运行中 | 3.2s 无限循环，仅合成属性 |
| 环境光漂移 | `ui/shared/shared.css`、`ui/rounds/rounds.css` | CSS | `transform` | 持续 | 38–57s 交替漂移；减弱动效时停止 |
| 角色动画 | `components/agent/whalebun.css` | CSS | `transform`、`opacity` | 持续 | 按状态播放 |
| 提示卡入场 | `components/attention/attention.css` | CSS | `transform`、`opacity` | 偶发 | 0.18s `att-in` |
| Drip 展开与折回 | `ui/drip/drip.css` | CSS keyframes | `transform`、`opacity` | 开关 | 展开 0.18s，折回 0.14s；Glass 使用 0.32s 弹簧 |
| 故事卡片悬停 | `ui/rounds/rounds.css` | CSS | `transform`、`box-shadow` | 高频 | 0.16s 过渡 transform、opacity 与边框；悬停抬升并放大 |
| 当前故事卡片 | `ui/rounds/rounds.css` | CSS keyframes | `box-shadow` | 持续 | 2.6s 脉冲；减弱动效时停止 |
| 时间轴游标 | `ui/monitor/monitor.css`、`ui/chart/chart.css` | CSS | `left` | 回放或选择 | 0.08s 线性过渡 |
| Diff 入场 | `components/stage/DiffStage.tsx` | framer-motion | `opacity`、`y` | 每次 Stage item 挂载 | 0.5s `y: 8 → 0` 入场与 1s 扫光 |
| 窗口拖拽与缩放 | `ui/rounds/RoundsWindow.tsx` | React state | `left`、`top`、`width`、`height` | 拖拽期间 | 每次 pointer move 触发一次 `setState` |
| Drip 胶囊宽度 | `ui/drip/drip.css` | CSS | `width` | 开关或悬停 | 无同视觉替代 |
| Glass 按钮光泽 | `ui/shared/themes.css` | CSS | `background-position` | 按钮悬停 | 渐变扫过 |

## 4. 约束

- 高频表面——Activity 信息流、指标计数、run 选择器与键盘动作——不做入场动画。每秒变化的读数直接写入，只有状态变化可以播放落定动画。
- 持续元素的动画只使用 `transform` 与 `opacity`。Nixie 灯丝与 Ink 沸腾是两个循环效果，均限定在对应风格内。
- 所有 face 遵守减弱动效查询：`shared.css` 停止环境层，`rounds.css` 停止房间漂移与当前卡片脉冲，`drip.css` 停止卡片动画，`themes.css` 停止角色动画。
- 桌面壳把 Drip 作为独立窗口打开；Document Picture-in-Picture 无法渲染 SVG filter，因此 Ink 沸腾只作用于主文档。

## 5. 已知成本

| 项目 | 成本 | 缓解 |
|---|---|---|
| `RoundsWindow` 拖拽与缩放 | 每次 pointer move 触发一次 React 渲染 | 窗口数量少；拖拽区域限于标题栏与角把手 |
| `DiffStage` 入场 | 高频表面上 0.5s 的挂载动画 | 保留为 Stage 上唯一的刻意入场；移除需要替代的落定提示 |
| `FaceRise` | 每次 face 挂载一个 560ms 的 rAF tween | 每次切换只运行一次；结束后清除 transform，不再约束 face |
| 时间轴游标 | `left` 过渡会重新布局游标元素 | 该元素是单个绝对定位子节点 |
| Nixie 乱码 | 每次落定 500ms 的 rAF 写入 | 量化到 15 fps；只写可变单元 |
