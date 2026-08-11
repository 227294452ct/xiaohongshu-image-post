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
  // 校验
  if (CFG.title.length > TITLE_LIMIT) throw new Error('title too long: ' + CFG.title.length + ' > ' + TITLE_LIMIT);
  if (CFG.body.length > BODY_LIMIT) throw new Error('body too long: ' + CFG.body.length + ' > ' + BODY_LIMIT);
  CFG.files.forEach((f) => { if (!fs.existsSync(f)) throw new Error('file not found: ' + f); });

  // 0. 开全新 tab（旧 tab 经多次注入/重置后 React 状态会坏：发布按钮不渲染！
  //    实测教训：在旧 tab 上重跑会导致 NO_BTN 假象。每次发布必须新 tab）
  await fetch('http://127.0.0.1:' + (process.env.CDP_PORT || '9222') + '/json/new?https://creator.xiaohongshu.com/publish/publish', { method: 'PUT' });
  await sleep(9000);

  // 1. 导航 + 登录检查（连到最新 tab）
  const target = await getPageTarget('xiaohongshu');
  const cdp = await connectTo(target);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('DOM.enable');
  await cdp.send('Accessibility.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 950, deviceScaleFactor: 1, mobile: false });
  const ev = (expr) => cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, timeout: 15000 });
  const shot = async (name) => {
    if (!CFG.shotDir) return;
    const s = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(CFG.shotDir + '\\' + name + '.png', Buffer.from(s.data, 'base64'));
    console.log('screenshot:', name + '.png');
  };

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

  // 8. 点"发布"按钮（<button class="ce-btn bg-red">发布</button>，右下角）
  //    首选 AX 树方案（实测最可靠）：Accessibility.getFullAXTree 找 role=button && name='发布'
  //    → backendDOMNodeId → DOM.resolveNode → callFunctionOn click
  let pubClicked = false;
  try {
    const ax = await cdp.send('Accessibility.getFullAXTree', {});
    const pubNode = ax.nodes.find(n => n.role && n.role.value === 'button' && n.name && n.name.value === '发布');
    if (pubNode && pubNode.backendDOMNodeId) {
      const res = await cdp.send('DOM.resolveNode', { backendNodeId: pubNode.backendDOMNodeId });
      const objId = res.object.objectId;
      await cdp.send('Runtime.callFunctionOn', {
        objectId: objId,
        functionDeclaration: `function() { this.click(); return 'CLICKED'; }`,
        returnByValue: true
      });
      pubClicked = true;
      console.log('publish click: AX_CLICKED (nodeId=' + pubNode.nodeId + ')');
    }
  } catch (e) {
    console.log('AX lookup failed:', e.message.slice(0, 60));
  }
  if (!pubClicked) {
    // 兜底：DOM 文本匹配（新 tab 下按钮 textContent 就是"发布"，x 最右）
    const pubRes = await ev(`(() => {
      const cands = [...document.querySelectorAll('*')].filter(e => {
        const r = e.getBoundingClientRect();
        return e.textContent.trim() === '发布' && r.width > 0 && r.height > 0 && r.width < 300;
      });
      if (!cands.length) return 'NO_BTN';
      cands.sort((a, b) => b.getBoundingClientRect().x - a.getBoundingClientRect().x);
      cands[0].click();
      return 'CLICKED';
    })()`);
    console.log('publish click:', pubRes.result.value);
  }
  await sleep(4000);

  // 弹窗确认（若有）：只在 modal/dialog 容器内找"确认发布/发布"按钮
  const confirmRes = await ev(`(() => {
    const modals = [...document.querySelectorAll('[role=dialog], [class*=modal i], [class*=dialog i]')]
      .filter(m => { const r = m.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    if (!modals.length) return 'NO_MODAL';
    const btn = [...modals[0].querySelectorAll('*')].find(e =>
      e.children.length === 0 && /^(确认发布|发布|确定)$/.test(e.textContent.trim()));
    if (!btn) return 'MODAL_NO_BTN:' + modals[0].innerText.slice(0, 100);
    btn.click();
    return 'CONFIRMED';
  })()`);
  console.log('confirm:', confirmRes.result.value);
  await shot('after_publish');

  // 9. 成功轮询：URL 跳 /publish/success 或出现"发布成功"（实测标志）
  let done = false;
  for (let i = 0; i < 12; i++) {
    await sleep(5000);
    const r = await ev(`JSON.stringify({url: location.href, hasSuccess: /发布成功/.test(document.body.innerText.slice(0, 800))})`);
    const s = JSON.parse(r.result.value);
    if (s.hasSuccess || s.url.includes('/publish/success')) { done = true; console.log('PUBLISH DONE:', s.url); break; }
  }
  if (!done) console.warn('publish result unverified - check 笔记管理 manually');
  cdp.close();
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
