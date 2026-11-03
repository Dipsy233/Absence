# 头像皮肤

[English](avatar-skin.md) | [简体中文](avatar-skin.zh-CN.md)

本文说明如何用用户上传的媒体替换 agent 的内置角色、皮肤如何存储，以及皮肤激活后界面如何使用它。影响行为的实现细节单独列出，与使用说明分开。

## 术语

- 头像：agent 在界面上的角色。默认为内置的 HTML/CSS 角色 WhaleBun。
- 皮肤：一组按状态行命名的上传文件，每个状态行最多一个文件（包含 `default`）。
- 状态：agent 的当前状态，决定播放哪一段动画。九个状态为 `listening`、`thinking`、`speaking`、`reading`、`searching`、`editing`、`running`、`waiting`、`error`。状态列表额外包含 `default`，它作为回退槽位，不属于 agent 状态。
- 激活的皮肤：当前应用到头像的皮肤。

## 使用

1. 点顶栏 `⚙` 打开设置，切到 `Personalization` 面板。`AVATAR SKIN` 是该面板的上半部分。
2. 在 `new name` 旁输入皮肤名称（例如 `MyDragon`），点 `+` 创建。每个皮肤是服务端 `avatar-skins/<名称>/` 下的独立文件夹。
3. 在侧栏点击皮肤名称进行编辑。`WhaleBun` 不进入编辑；它是内置角色。
4. 状态列表显示十行：九个 agent 状态与 `default`。对每一行点 `upload`，选择 `mp4` / `gif` / `png` / `jpg` / `jpeg` / `webp` / `svg` / `webm` / `mov` 文件。该文件成为该行的动画。重复上传会覆盖该行之前的文件。`✕` 清除该行。
5. 点 `Apply` 激活当前载入的皮肤。选择 `WhaleBun` 后点 `Apply` 恢复内置角色。

规则：

- 状态没有自己的文件时，回退到该皮肤的 `default` 文件。
- `default` 也没有时，该状态渲染内置 WhaleBun 角色。
- 在 `WhaleBun` 上上传时，界面会要求输入新的皮肤名称，并创建一个真实皮肤文件夹。
- 上传后无需刷新即可生效。Web 客户端每 4 秒轮询服务端，在激活皮肤的文件变化后重新渲染头像。

## 存储

服务端把皮肤存放在 `apps/server/src/process/avatar-skins/`：

```
apps/server/src/process/avatar-skins/
├── active.json            { "active": "MyDragon" }（空 = 内置 WhaleBun）
└── MyDragon/
    ├── default.png
    ├── thinking.mp4
    └── error.gif
```

`active.json` 记录激活的皮肤名称。空值表示内置 WhaleBun。删除皮肤时，如果该皮肤正处于激活状态，激活值会被重置。

## 限制

- 皮肤名称必须非空、不超过 64 个字符，且不能包含 `\ / : * ? " < > |`。
- 接受的文件扩展名为 `png`、`gif`、`jpg`、`jpeg`、`webp`、`svg`、`mp4`、`webm`、`mov`。上传文件按 `<状态>.<扩展名>` 存储；原始文件名只用于取扩展名。
- 皮肤文件夹位于服务端的安装目录。打包构建中该目录是只读 asar 归档，因此在那里上传会失败。
- 浏览器无法解码的视频会在动画位置显示解码错误提示。提示写明所需编码：H.264、`yuv420p`、`faststart`。

## 实现

- 服务端存储：`apps/server/src/process/avatarSkins.ts`。它列出皮肤、解析激活名称、保存上传文件、删除某状态的文件或整个皮肤，并按状态解析对外提供的文件，带 `default` 回退。
- API：`apps/server/src/api/avatarSkins.ts`。`GET /api/avatar-skins` 返回皮肤列表、激活名称与激活皮肤的文件。`POST /api/avatar-skins/:name` 创建皮肤。`PUT /api/avatar-skins/:name/files` 为某状态上传一个文件。`DELETE /api/avatar-skins/:name/files/:status` 清除某状态。`DELETE /api/avatar-skins/:name` 删除皮肤。`POST /api/avatar-skins/:name/activate` 激活皮肤。
- 提供文件：激活皮肤的文件通过 `/avatar/<status>` 提供。处理器支持 HTTP Range 请求，`<video>` 播放需要该支持。404 表示该状态没有文件。
- 视频规范化：上传的 `mp4` 与 `mov` 在 ffmpeg 可用时就地重编码：仅保留视频流、去除元数据、`libx264`、`yuv420p`、`faststart`。这会去除部分浏览器拒绝播放的数据轨道，例如 timecode 流。ffmpeg 不可用时保留原文件。规范化失败或没有产出时，原文件保留。
- Web：`apps/web/src/lib/avatarSkin.ts` 轮询 `GET /api/avatar-skins`，给出激活皮肤覆盖了哪些状态。`skinMediaFor` 返回媒体 URL 与是否为视频，并应用 `default` 回退。
- 渲染：`apps/web/src/components/agent/Avatar.tsx` 是内置角色。`apps/web/src/components/agent/MediaAvatar.tsx` 把上传文件渲染为 `<video>` 或 `<img>`，视频无法播放时显示解码错误提示。`useAvatarSkinCoverage` 驱动两者之间的切换；两者读取同一个 `AgentVisualState`。

## 各位置的呈现

- Monitor 右栏：头像位于 `AgentHead` 的 88px tile 中。当前显示的状态有自己的文件或有 `default` 文件时，渲染激活皮肤。
- Rounds：头像位于 `RoundsScene`，是站立的角色。按相同回退规则渲染激活皮肤。
- Drip pill：pill 只渲染内置 `Avatar` 组件。该处不使用上传的皮肤文件。

在 Monitor 与 Rounds 中，固定的时刻或回放让头像重演该时刻推导出的状态。following 时显示实时状态。
