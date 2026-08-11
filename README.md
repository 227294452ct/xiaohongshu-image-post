# xiaohongshu-image-post

小红书图文自动发布 Agent Skill（Edge CDP，零依赖）。

通过 Chrome DevTools Protocol 驱动独立 Edge 实例，在 creator.xiaohongshu.com 自动完成：
上传图片 → 填标题/正文 → 话题自动识别 → 发布 → 验证，内置三层登录防线
（profile 复用 / 新 profile 静默继承主 Edge 登录态 / 扫码回退+失效自愈）。

2026-08 已实测全链路：上传、填表、字数计数、话题识别全部通过。

## 文件

| 文件 | 说明 |
|---|---|
| `SKILL.md` | 流程手册：步骤、坑、验证方法（agent 读取执行） |
| `cdp_helper.js` | 零依赖 CDP 客户端（Node ≥22 原生 WebSocket） |
| `login_check.js` | 登录检测 / 静默继承轮询 / 扫码截图+失效自动刷新 |
| `publish_template.js` | 发布主脚本，读配置 JSON 一条龙执行 |

## 安装

- **Hermes**：把整个目录复制到 `~/AppData/Local/hermes/skills/social-media/xiaohongshu-image-post/`，新会话说"发小红书"即自动加载
- **QwenWork / 千问办公**：复制到 `~/.qwenworkcn/skills/xiaohongshu-image-post/`

## 快速使用

```bash
# 1. 启动独立 Edge（profile 持久化，登录一次长期复用；端口 9223 与抖音 9222 区分）
msedge --remote-debugging-port=9223 --user-data-dir=C:\temp\edge-xhs-pub --no-first-run --disable-extensions https://creator.xiaohongshu.com/publish/publish

# 2. 登录检查（已登录则直接输出账号信息；新 profile 等待 1~2 分钟静默继承主 Edge 登录态）
CDP_PORT=9223 node login_check.js

# 3. 写配置并发布
CDP_PORT=9223 node publish_template.js config.json
```

config.json 示例：

```json
{
  "files": ["F:\\cards\\01.jpg", "F:\\cards\\02.jpg"],
  "title": "标题硬限20字以内",
  "body": "正文 ≤1000 字，结尾直接写 #话题 会被自动识别为标签",
  "shotDir": "C:\\temp"
}
```

## 关键限制（踩过的坑）

- **文件路径必须 Windows 原生格式**（`F:\...`）：`DOM.setFileInputFiles` 传 MSYS 风格 `/f/...` 会导致注入失败、页面渲染进程卡死（与抖音 skill 最大的环境差异）
- Edge 136+/151 默认 profile 禁 `--remote-debugging-port`，必须独立 `--user-data-dir`
- 小红书图文标题硬限 **20 字**，正文 1000 字；图片支持 jpg/jpeg/png/webp，**不支持 gif**，单张 ≤32MB
- 前端哈希 class 名每次发版会变，脚本只用文本/placeholder/属性选择器
- 新建 profile 时 Edge 会在 1~2 分钟内静默导入主 Edge 的登录 cookie（本 skill 的核心技巧）
