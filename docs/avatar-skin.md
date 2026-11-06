# Avatar skin

[English](avatar-skin.md) | [简体中文](avatar-skin.zh-CN.md)

This document describes how uploaded media replaces the agent's built-in character, how skins are stored, and what the interface does with a skin once it is active. Implementation details that affect behaviour are listed separately from the usage instructions.

## Terms

- Avatar: the agent's on-screen character. The default is the built-in HTML/CSS character WhaleBun.
- Skin: a named set of uploaded files, at most one file per status row (including `default`).
- Status: the agent's current state, which decides which animation plays. The nine statuses are `listening`, `thinking`, `speaking`, `reading`, `searching`, `editing`, `running`, `waiting`, and `error`. The status list adds `default` as a fallback slot; `default` is not an agent state.
- Active skin: the skin currently applied to the avatar.

## Usage

1. Open Settings with the `⚙` button in the top bar, and switch to the `Personalization` pane. The `AVATAR SKIN` section is its upper half.
2. Enter a skin name (for example `MyDragon`) beside `new name` and click `+` to create it. Each skin is its own folder under `avatar-skins/<name>/` on the server.
3. In the sidebar, click a skin name to edit it. `WhaleBun` opens no editor; it is the built-in character.
4. The status list shows ten rows: the nine agent statuses and `default`. For each row, click `upload` and pick an `mp4` / `gif` / `png` / `jpg` / `jpeg` / `webp` / `svg` / `webm` / `mov` file. The file becomes that row's animation. Uploading again overwrites the row's previous file. `✕` clears the row.
5. Click `Apply` to activate the loaded skin. Selecting `WhaleBun` and clicking `Apply` returns to the built-in character.

Rules:

- A status without its own file falls back to the skin's `default` file.
- When `default` is also missing, that status renders the built-in WhaleBun character.
- Uploading while WhaleBun is selected prompts for a new skin name and creates a skin folder.
- Uploaded files become effective without a reload. The web client polls the server every 4 seconds and re-renders the avatar when the active skin's files change.

## Storage

The server stores skins in `apps/server/src/process/avatar-skins/`:

```
apps/server/src/process/avatar-skins/
├── active.json            { "active": "MyDragon" } (empty = built-in WhaleBun)
└── MyDragon/
    ├── default.png
    ├── thinking.mp4
    └── error.gif
```

`active.json` records the active skin name. An empty value means the built-in WhaleBun. Deleting an active skin resets the active value.

## Limits

- A skin name must be non-empty, at most 64 characters, and must not contain `\ / : * ? " < > |`.
- Accepted file extensions are `png`, `gif`, `jpg`, `jpeg`, `webp`, `svg`, `mp4`, `webm`, and `mov`. The uploaded file is stored as `<status>.<extension>`; its original name is used only for the extension.
- The skin folder lives inside the server's install directory. In a packaged build that directory is a read-only asar archive, so uploads fail there.
- A video the browser cannot decode shows a decode-error notice in place of the animation. The notice names the required encoding: H.264, `yuv420p`, `faststart`.

## Implementation

- Server storage: `apps/server/src/process/avatarSkins.ts`. It lists skins, resolves the active name, stores uploaded files, deletes a status's file or a whole skin, and resolves the served file for a status with the `default` fallback.
- API: `apps/server/src/api/avatarSkins.ts`. `GET /api/avatar-skins` returns the skins, the active name, and the active skin's files. `POST /api/avatar-skins/:name` creates a skin. `PUT /api/avatar-skins/:name/files` uploads one file for one status. `DELETE /api/avatar-skins/:name/files/:status` clears a status. `DELETE /api/avatar-skins/:name` deletes a skin. `POST /api/avatar-skins/:name/activate` activates a skin.
- Serving: the active skin's files are served at `/avatar/<status>`. The handler supports HTTP Range requests, which browsers require for `<video>` playback. A 404 means no file for that status.
- Video normalisation: uploaded `mp4` and `mov` files are re-encoded in place with `ffmpeg` when it is available: video stream only, metadata dropped, `libx264`, `yuv420p`, `faststart`. This removes data tracks such as a timecode stream that some browsers refuse to play. When ffmpeg is unavailable, the original file is kept. A normalisation that fails or produces nothing leaves the original file in place.
- Web: `apps/web/src/lib/avatarSkin.ts` polls `GET /api/avatar-skins` and answers which statuses the active skin covers. `skinMediaFor` returns the media URL and whether it is a video, with the `default` fallback.
- Rendering: `apps/web/src/components/agent/Avatar.tsx` is the built-in character. `apps/web/src/components/agent/MediaAvatar.tsx` renders an uploaded file as `<video>` or `<img>` and shows a decode-error notice when a video cannot be played. `useAvatarSkinCoverage` drives the switch between them; both read the same `AgentVisualState`.

## Behaviour by placement

- Monitor right column: the avatar is an 88px tile in `AgentHead`. It renders the active skin when the shown status has its own file or a `default` file.
- Rounds: the avatar is the standing character in `RoundsScene`. It renders the active skin under the same fallback rules.
- Drip pill: the pill renders the built-in `Avatar` component only. Uploaded skin files are not used there.

In Monitor and Rounds, a pinned moment or a replay makes the avatar re-enact the status derived from that moment. While following, the avatar shows the live status.
