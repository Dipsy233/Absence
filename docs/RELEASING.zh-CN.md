# 发布流程

Absence 以桌面安装包的形式发布（Windows 是 NSIS 安装器，Linux 是 AppImage 和
`tar.gz`）。`.github/workflows/release.yml` 在 GitHub 的 runner 上同时构建两个
平台，并把安装包附加到 GitHub Release，因此发布不依赖任何本地环境。

## 两种触发方式

### 1. 手动触发（推荐）

1. 先写发布说明：`docs/RELEASE_NOTES_v<版本>.md`（英文正文，末尾带
   `## 中文摘要` 小节，可参考 `docs/RELEASE_NOTES_v0.4.0.md`）。
2. 提交并推送到 `main`。
3. GitHub ▸ **Actions** ▸ **Release** ▸ **Run workflow**：
   - `version`：`0.4.0`（不要带 `v`）
   - `prerelease`：`-beta` / `-rc` 之类的版本勾选
   - `draft`：默认勾选，先生成草稿 Release，检查无误后自己发布；
     取消勾选则直接发布
4. 运行结束后打开 **Releases**，确认说明和产物，再发布草稿：

   ```bash
   gh release edit v0.4.0 --draft=false
   ```

工作流只在构建期间把版本号写进各个 `package.json`，不会提交，因此即使仓库里
的版本号落后，安装包也会按本次发布版本命名（`Absence Setup 0.4.0.exe`、
`Absence-0.4.0.AppImage`）。

### 2. 推 tag 自动发布

```bash
git tag v0.4.0
git push origin v0.4.0
```

推 tag 会以 `draft: false` 运行同一个工作流，并根据 tag 名自动判断是否为
预发布（`v0.5.0-beta.1` → 预发布）。这是全自动路径：构建、说明、发布一次完成。

## 工作流做了什么

| Job | Runner | 作用 |
| --- | --- | --- |
| `prepare` | ubuntu | 归一化 `version`/`tag`，查找 `docs/RELEASE_NOTES_v<tag>.md`，决定 draft / prerelease |
| `checks` | ubuntu | `npm run typecheck --workspaces` + `npm run check:offline`，测试不过就不发布 |
| `build` | windows-latest、ubuntu-latest | `npm ci`、`npm --prefix apps/desktop ci`、`npm run desktop:dist`，上传安装包 |
| `publish` | ubuntu | 合并两平台的产物、生成 `SHA256SUMS.txt`、选择或生成发布说明、创建或更新 Release |

如果存在 `docs/RELEASE_NOTES_<tag>.md`（或 `docs/RELEASE_<tag>.md`），就用它作为
发布说明；否则从上一个 tag 到本次 tag 之间的提交信息自动生成，按
conventional-commit 类型分组（`scripts/release/notes.mjs`，本地也可以运行
`npm run release:notes -- v0.4.0`）。不使用 GitHub 自带的自动说明，因为它按
PR 分组，而本仓库大多是直接推送到 `main`；`.github/release.yml` 只保留给
Releases 页面里的 “Generate release notes” 按钮使用。

Release 上附加的文件：

- `Absence Setup <版本>.exe` —— Windows 安装器（NSIS）
- `Absence-<版本>.AppImage`、`Absence-<版本>.tar.gz` —— Linux
- `SHA256SUMS.txt` —— 以上文件的校验和

electron-builder 产生的 `latest*.yml` 也会一并附加。它们只供自动更新使用，
Absence 目前没有自动更新器，留着无害。

## 构建相关的注意点

- 内核进程观察器（`native/agentwatch/agentwatch.exe`、
  `native/agentwatch-linux/agentwatch-linux`）是**预编译并提交进仓库**的。
  CI 不编译它们；源码变化时请在本地重新构建并提交新二进制：Windows 用
  `npm run build:agentwatch`（MinGW 或 MSVC），Linux 用
  `native/agentwatch-linux/build.sh`（clang + libbpf）。
- 安装包未签名。Windows SmartScreen 和 macOS Gatekeeper 会提示风险；签名需要
  证书和仓库 secrets，目前不在范围内。工作流设置了
  `CSC_IDENTITY_AUTO_DISCOVERY=false`，避免 electron-builder 去探测签名身份。
- Linux 构建需要观察器有可执行位：git 里存的是 `100644`，所以打包前工作流会
  执行 `chmod +x`。
- 失败后可以安全地重跑：如果 Release 已存在，`publish` 会用 `--clobber`
  重新上传产物并刷新说明，而不是报错退出。

## 版本号

`package.json` 里的版本号决定产物文件名。发布工作流在构建时用输入/tag 覆盖它们，
所以不 bump 版本号也能发布。如果希望仓库本身就带版本号，在打 tag 前先 bump：

```bash
npm version 0.4.0 --no-git-tag-version --workspaces --include-workspace-root
npm --prefix apps/desktop version 0.4.0 --no-git-tag-version
git commit -am "chore: release v0.4.0"
git tag v0.4.0 && git push origin main --tags
```

## 本地跑打包步骤

```bash
npm ci
npm --prefix apps/desktop ci
npm run desktop:dist        # web 构建 + 服务端打包 + electron-builder
```

产物在 `dist/desktop/release/`（已被 git 忽略）。打包目录里具体放了什么，见
[ARCHITECTURE.zh-CN.md](ARCHITECTURE.zh-CN.md)。
