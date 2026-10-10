# Avatar Skin — 个性化 Agent 形象

Agent 形象默认是内置的 HTML/CSS 角色 WhaleBun（鲸团团）。通过**设置弹窗左半**
可以直接上传动画文件替换它，**不需要写任何 URL 或代码**。

## 使用

1. 点顶栏 `⚙ settings`，左半是 **AVATAR SKIN** 面板。
2. 侧栏输入一个形象名称（如 `MyDragon`）点 `+` 创建——每个形象是服务端
   `avatar-skins/<名称>/` 下的一个独立文件夹。
3. 面板右侧列出全部状态（default / listening / thinking / speaking /
   reading / searching / editing / running / waiting / error）。点某行的
   `upload`，选择 mp4 / gif / png / webp / svg 文件，它就成为该状态的动画。
   重复上传会覆盖同一状态的旧文件；`✕` 清除该状态。
4. 点 `Apply` 启用该形象；选侧栏的 WhaleBun 再 Apply 恢复内置角色。

状态没有上传文件时回退到该形象的 `default` 文件；`default` 也没有时该状态
显示内置 WhaleBun 角色。上传后约 4 秒内自动生效，无需刷新。

## 存储

```
apps/server/src/process/avatar-skins/
├── active.json            { "active": "MyDragon" }（空 = 内置 WhaleBun）
└── MyDragon/
    ├── default.png
    ├── thinking.mp4
    └── error.gif
```

## 实现

- 服务端：`apps/server/src/process/avatarSkins.ts`（存储）+ `apps/server/src/api/avatarSkins.ts`（上传/激活/删除 API）
- 激活的形象文件通过 `/avatar/<status>` 提供（支持 HTTP Range——`<video>` 播放必需；404 = 未上传）
- 上传的视频用 ffmpeg 自动转码：`-map 0:v:0 -map_metadata -1`（去除 tmcd 等
  数据轨道，Chrome 拒绝播放含数据轨道的 mp4）+ `-c:v libx264 -pix_fmt yuv420p
  -movflags +faststart`。ffmpeg 不可用时保留原文件。
- 前端：`apps/web/src/lib/avatarSkin.ts`（轮询覆盖状态）+ `MediaAvatar.tsx`（video/img 渲染）
- 接入点：`AgentPanel.tsx` 与 `Stage.tsx`，共用同一个 `AgentVisualState` 接缝
