// 小红书图文发布（creator.xiaohongshu.com）
// 用法：node publish_template.js C:\temp\xhs_config.json  （env: CDP_PORT=9223）
// 配置：{ files: [Windows原生绝对路径...], title, body, shotDir }
// 已实测：上传/填标题/正文/话题识别/字数计数；发布按钮与成功标志待真实发布确认
const fs = require('fs');
const { getPageTarget, connectTo, sleep } = require('./cdp_helper.js');

const CFG = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const PUBLISH_URL = 'https://creator.xiaohongshu.com/publish/publish';
const TITLE_LIMIT = 20;
const BODY_LIMIT = 1000;

(async () => {
  const target = await getPageTarget('xiaohongshu');
  const cdp = await connectTo(target);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('DOM.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 950, deviceScaleFactor: 1, mobile: false });
  const ev = (expr) => cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, timeout: 15000 });
  const shot = async (name) => {
    if (!CFG.shotDir) return;
    const s = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(CFG.shotDir + '\\' + name + '.png', Buffer.from(s.data, 'base64'));
    console.log('screenshot:', name + '.png');
  };

  // 校验
  if (CFG.title.length > TITLE_LIMIT) throw new Error('title too long: ' + CFG.title.length + ' > ' + TITLE_LIMIT);
  if (CFG.body.length > BODY_LIMIT) throw new Error('body too long: ' + CFG.body.length + ' > ' + BODY_LIMIT);
  CFG.files.forEach((f) => { if (!fs.existsSync(f)) throw new Error('file not found: ' + f); });

  // 1. 导航 + 登录检查
  await cdp.send('Page.navigate', { url: PUBLISH_URL });
  await sleep(8000);
  const loginState = await ev(`document.body.innerText.includes('短信登录') ? 'LOGIN_PAGE' : 'OK'`);
  if (loginState.result.value === 'LOGIN_PAGE') {
    throw new Error('NOT LOGGED IN - run login_check.js first');
  }

  // 2. 切"上传图文"tab（文本匹配，哈希 class 免疫）
  const tabRes = await ev(`(() => {
    const cands = [...document.querySelectorAll('*')].filter(e =>
      e.children.length === 0 && /^上传图文$/.test(e.textContent.trim()));
    const vis = cands.filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    vis.sort((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y);
    if (vis.length) { vis[0].click(); return 'CLICKED'; }
    return 'NO_TAB';
  })()`);
  console.log('tab:', tabRes.result.value);
  if (tabRes.result.value !== 'CLICKED') throw new Error('upload-image tab not found');
  await sleep(5000);

  // 3. 注入图片（必须 Windows 原生路径）
  const doc = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  const q = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' });
  if (!q.nodeId) throw new Error('file input not found');
  await cdp.send('DOM.setFileInputFiles', { nodeId: q.nodeId, files: CFG.files });
  console.log('files injected:', CFG.files.length);

  // 4. 等上传完成（标题 input 出现）
  let ready = false;
  for (let i = 0; i < 12; i++) {
    await sleep(5000);
    const r = await ev(`[...document.querySelectorAll('input')].some(i => (i.placeholder || '').includes('填写标题'))`);
    if (r.result.value) { ready = true; break; }
  }
  if (!ready) throw new Error('upload timeout: form not ready');
  console.log('upload done, form ready');
  await sleep(2000);

  // 5. 标题（setter + input 事件）
  const titleRes = await ev(`(() => {
    const input = [...document.querySelectorAll('input')].find(i => (i.placeholder || '').includes('填写标题'));
    if (!input) return 'NO_INPUT';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(CFG.title)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return 'SET:' + input.value;
  })()`);
  console.log('title:', titleRes.result.value);
  await sleep(1500);

  // 6. 正文（ProseMirror 接受 execCommand insertText，实测通过）
  const bodyRes = await ev(`(() => {
    const ed = document.querySelector('[contenteditable=true]');
    if (!ed) return 'NO_EDITABLE';
    ed.focus();
    const ok = document.execCommand('insertText', false, ${JSON.stringify(CFG.body)});
    return 'INSERT:' + ok + ' LEN:' + ed.innerText.length;
  })()`);
  console.log('body:', bodyRes.result.value);
  await sleep(2500);

  // 7. 验证回读 + 截图
  const verify = await ev(`JSON.stringify({
    titleVal: [...document.querySelectorAll('input')].find(i => (i.placeholder || '').includes('填写标题'))?.value || null,
    bodyLen: document.querySelector('[contenteditable=true]')?.innerText.length || 0,
    charCount: (document.body.innerText.match(/\\d+\\s*\\/1000/) || ['?'])[0]
  })`);
  console.log('VERIFY:', verify.result.value);
  await shot('before_publish');

  // 8. 点"发布笔记"（若弹确认对话框，点含"发布"的按钮）
  const pubRes = await ev(`(() => {
    const btn = [...document.querySelectorAll('*')].find(e =>
      e.children.length === 0 && e.textContent.trim() === '发布笔记' && e.getBoundingClientRect().width > 0);
    if (!btn) return 'NO_BTN';
    btn.click();
    return 'CLICKED';
  })()`);
  console.log('publish click:', pubRes.result.value);
  await sleep(3000);

  // 弹窗确认（如有）
  const confirmRes = await ev(`(() => {
    const t = document.body.innerText;
    if (!/确认发布|发布笔记/.test(t.slice(0, 500))) return 'NO_DIALOG';
    const btn = [...document.querySelectorAll('*')].find(e =>
      e.children.length === 0 && /^(确认发布|发布|确定)$/.test(e.textContent.trim()) && e.getBoundingClientRect().width > 0);
    if (btn) { btn.click(); return 'CONFIRMED'; }
    return 'DIALOG_NO_BTN';
  })()`);
  console.log('confirm:', confirmRes.result.value);
  await shot('after_publish');

  // 9. 成功轮询：URL 离开 publish 页 或 出现"发布成功"
  let done = false;
  for (let i = 0; i < 6; i++) {
    await sleep(5000);
    const r = await ev(`JSON.stringify({url: location.href, hasSuccess: /发布成功|发布完成/.test(document.body.innerText.slice(0, 800))})`);
    const s = JSON.parse(r.result.value);
    if (s.hasSuccess || !s.url.includes('/publish/publish')) { done = true; console.log('PUBLISH DONE:', s.url); break; }
  }
  if (!done) console.warn('publish result unverified - check 笔记管理 manually');
  cdp.close();
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
