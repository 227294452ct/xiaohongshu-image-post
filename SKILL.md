---
name: xiaohongshu-image-post
description: 发布小红书图文笔记时用：Edge CDP 自动上传发布（creator.xiaohongshu.com）。
version: 1.0.0
---

# 小红书图文自动发布（Edge CDP）

适用场景：用户要求"发小红书/发布笔记/小红书图文"。通过 Edge CDP 自动化发布小红书图文笔记（creator.xiaohongshu.com）：上传图片、填标题正文、话题自动识别、发布、三层登录防线（profile 复用/静默继承/扫码回退）。**2026-08-12 已实测发布成功 2 条**（手动 1 条 + 自动化 1 条）：上传/填表/发布/成功验证全链路打通。

## 前提

- Windows + Edge + Node ≥22（原生 WebSocket，零依赖）
- 素材：图片若干（.jpg/.jpeg/.png/.webp，**不支持 gif**；单张 ≤32MB；推荐 3:4 竖版）、标题（**硬限 20 字**）、正文（≤1000 字，可含 #话题 自动识别）
- 配套脚本在本 skill 目录：`cdp_helper.js`、`login_check.js`、`publish_template.js`
- **全程不碰用户主 Edge**，独立实例（`--user-data-dir=C:\temp\edge-xhs-pub` + `--remote-debugging-port=9223`）
- 与抖音 skill 共用 `cdp_helper.js` 协议层；端口用 9223 避免冲突

## Steps

### 1. 启动独立 Edge（profile 持久化）

PowerShell 脚本（勿用 bash 直接跑 PS 内联，`$_` 会被吃；写成 .ps1 用 `-File` 执行）：

```powershell
# C:\temp\start_xhs_edge.ps1
$edge = (Get-Command msedge -ErrorAction SilentlyContinue).Source
if (-not $edge) { $edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" }
if (-not (Test-Path $edge)) { $edge = "C:\Program Files\Microsoft\Edge\Application\msedge.exe" }
Start-Process $edge -ArgumentList @(
  "--remote-debugging-port=9223", "--user-data-dir=C:\temp\edge-xhs-pub",
  "--no-first-run", "--no-default-browser-check", "--disable-extensions",
  "https://creator.xiaohongshu.com/publish/publish"
)
Start-Sleep -Seconds 6
Invoke-RestMethod http://127.0.0.1:9223/json/version | Select-Object Browser,webSocketDebuggerUrl
```

- profile 目录**长期保留**（登录态复用，登录是一次性成本）；换账号才删目录重建
- 验证端口：`Invoke-RestMethod http://127.0.0.1:9223/json/version`

### 2. 三层登录防线（login_check.js）

`CDP_PORT=9223 node "<skill目录>/login_check.js" [outPng]`

1. **复用**：导航 `/publish/publish`，body 不含"短信登录"即已登录 → 直接发布
2. **静默继承**（新建 profile 触发）：Edge 新 profile 1~2 分钟内静默导入主 Edge cookie；**实测有效**（主 Edge 登录过小红书即自动登录）。轮询重载最多 3 分钟
3. **扫码回退**：登录页先点二维码 tab（"短信登录"表单旁的 image，cursor:pointer），再截近正方形 img/canvas 发给用户；轮询扫码，失效自动刷新；无人值守（UNATTENDED=1）不进入扫码直接中止

### 3. 发布（publish_template.js + 配置 JSON）

写配置 `C:\temp\xhs_config.json`：`{files:[Windows原生绝对路径...], title, body, shotDir}`，然后
`CDP_PORT=9223 node "<skill目录>/publish_template.js" C:\temp\xhs_config.json`

脚本内部流程（**已实测全链路，2026-08-12 发布成功**）：
0. **开全新 tab**（`PUT /json/new`）：旧 tab 经多次注入/重置后 React 状态会坏——发布按钮不渲染，导致 NO_BTN 假象。**每次发布必须新 tab**（实测教训）
1. 导航 `/publish/publish`；若登录页则中止（先跑 login_check）
2. 点"上传图文"tab：叶子元素（`children.length===0`）文本精确匹配 `上传图文`，取可见者按 y 排序第一个 click（哈希 class 名每次发版会变，只用文本）
3. `DOM.enable` → `DOM.getDocument` → `DOM.querySelector` 找 `input[type=file]`（accept=.jpg,.jpeg,.png,.webp）→ `DOM.setFileInputFiles` 一次注入全部图片
4. **文件路径必须是 Windows 原生格式（`F:\...`）**；MSYS 风格 `/f/...` 会导致注入失败页面卡死（实测踩坑）
5. 等上传完成：placeholder"填写标题会有更多赞哦"的 input 出现即表单就绪（约 10~15s，轮询超时 abort）
6. 标题：`HTMLInputElement.prototype` 的 value setter + `input` 事件（semi 受控组件）；**硬限 20 字**，长标题必须缩短
7. 正文：`[contenteditable=true]`（tiptap ProseMirror）focus + `document.execCommand('insertText', false, body)`；**实测 ProseMirror 接受 execCommand**；字数 UI `N/1000` 实时更新；#话题 在正文里直接写会被自动识别为话题标签
8. **点"发布"按钮（`<button class="ce-btn bg-red">发布</button>`，右下角）**：首选 **CDP Accessibility 方案**（实测最可靠）——`Accessibility.getFullAXTree` 找 `role==='button' && name==='发布'` → `backendDOMNodeId` → `DOM.resolveNode` → `Runtime.callFunctionOn` click；兜底 DOM 文本匹配（textContent==='发布' 且宽<300，x 最右）。**注意区分**：侧边栏顶部红色"发布笔记"是导航入口（点击跳视频页+重置表单），不是发布按钮
9. **成功标志（实测）**：URL 跳转 `/publish/success` + 页面出现"发布成功"，3 秒后自动返回发布页（`published=true`）；轮询 60s

### 4. 收尾

- 只 Stop-Process 命令行含 `edge-xhs-pub` 的 msedge（`Get-CimInstance Win32_Process` 过滤，勿用 taskkill）
- **保留 profile 目录**；验证 9223 端口无监听

## Pitfalls

- **路径必须 Windows 原生格式**（`F:\dir\file.jpg`）：setFileInputFiles 传 `/f/...` 会失败并让页面渲染进程卡死（Runtime.evaluate 超时）。这是与抖音 skill 最大的环境差异
- 新 profile 静默导入会带入主 Edge 扩展 → 必须 `--disable-extensions`；cookie 导入不受影响
- 小红书哈希 class 名每次发版会变 → 只用文本/placeholder/属性选择器；失灵先 dump DOM
- 标题硬限 20 字；正文 1000 字（UI 实时计数）
- 图片不支持 gif/live 及其转化图片；单张 ≤32MB
- 登录页特征文本："短信登录"；已登录特征：侧边栏"发布笔记"/用户名
- 发布频率别太高（小红书风控较敏感），定时发布功能可做人工兜底
- Edge 136+：默认 profile 禁 remote-debugging-port，独立 user-data-dir 是唯一通路
- 页面偶发卡死（渲染进程忙）：`PUT /json/new?<url>` 开新 tab 绕开，别在原 tab 死等
- **旧 tab 状态污染**：同一 tab 反复注入/导航后发布按钮会消失（React 状态坏），表现为"表单完整但无发布按钮"——每次发布流程必须开全新 tab
- **发布按钮定位用 CDP Accessibility 树**（`getFullAXTree` 找 role=button name=发布）最可靠；视觉模型（LLM 看图）会脑补不存在的按钮，DOM 诊断别信截图描述，用 OCR 或 AX 树验证

## Verification

- 发布前截图核对：标题字数、正文、N 张缩略图、字数计数 N/1000、话题列表
- 填表验证脚本回读：titleVal / bodyText / charCount / tags（2026-08 实测全部通过）
- 收尾后：`Get-NetTCPConnection -LocalPort 9223` 无监听、无残留独立实例进程
