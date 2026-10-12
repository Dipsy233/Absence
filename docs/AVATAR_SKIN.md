# Avatar Skin — Personalize the Agent Character

The agent character defaults to the built-in HTML/CSS character WhaleBun. You
can replace it with your own animations directly from the **left half of the
Settings dialog** — no URLs, no code.

## Usage

1. Click the `⚙ settings` button in the session bar; the left half is the
   **AVATAR SKIN** pane.
2. Enter a skin name (e.g. `MyDragon`) in the sidebar and click `+` to create
   it — each skin is its own folder under `avatar-skins/<name>/` on the server.
3. The right side lists all states (default / listening / thinking / speaking /
   reading / searching / editing / running / waiting / error). Click `upload`
   on a row and pick an mp4 / gif / png / webp / svg file — it becomes that
   state's animation. Uploading again overwrites the state's previous file;
   `✕` clears the state.
4. Click `Apply` to activate the skin; select WhaleBun in the sidebar and
   `Apply` again to return to the built-in character.

A state with no uploaded file falls back to that skin's `default` file; when
`default` is missing too, the state shows the built-in WhaleBun character.
Changes take effect within about 4 seconds, no refresh needed.

## Storage

```
apps/server/src/process/avatar-skins/
├── active.json            { "active": "MyDragon" } (empty = built-in WhaleBun)
└── MyDragon/
    ├── default.png
    ├── thinking.mp4
    └── error.gif
```

## Implementation

- Server: `apps/server/src/process/avatarSkins.ts` (storage) +
  `apps/server/src/api/avatarSkins.ts` (upload / activate / delete API)
- The active skin's files are served at `/avatar/<status>` (HTTP Range
  supported — required by `<video>` playback; 404 = not uploaded)
- Uploaded videos are transcoded automatically with ffmpeg:
  `-map 0:v:0 -map_metadata -1` (drops tmcd and other data tracks, which Chrome
  refuses to play) + `-c:v libx264 -pix_fmt yuv420p -movflags +faststart`.
  When ffmpeg is unavailable the original file is kept as-is.
- Web: `apps/web/src/lib/avatarSkin.ts` (coverage polling) + `MediaAvatar.tsx`
  (video/img rendering)
- Integration points: `AgentPanel.tsx` and `Stage.tsx`, sharing the same
  `AgentVisualState` seam
