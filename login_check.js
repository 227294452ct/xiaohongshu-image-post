// 小红书登录三层防线：状态检测 / 静默继承轮询 / 扫码截图+失效自动刷新
// 用法：node login_check.js [outPngPath]   （env: CDP_PORT=9223, UNATTENDED=1 时不进入扫码轮询）
const fs = require('fs');
const { getPageTarget, connectTo, sleep } = require('./cdp_helper.js');

const OUT = process.argv[2] || 'C:\\temp\\xhs_qr.png';
const UNATTENDED = process.env.UNATTENDED === '1';
const PUBLISH_URL = 'https://creator.xiaohongshu.com/publish/publish';

(async () => {
  const target = await getPageTarget('xiaohongshu');
  const cdp = await connectTo(target);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false });
  const ev = (expr) => cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, timeout: 15000 });

  for (let attempt = 1; attempt <= 10; attempt++) {
    await cdp.send('Page.navigate', { url: PUBLISH_URL });
    await sleep(6000);
    const probe = await ev(`JSON.stringify({
      isLoginPage: document.body.innerText.includes('短信登录'),
      head: document.body.innerText.slice(0, 300)
    })`);
    const st = JSON.parse(probe.result.value);

    if (!st.isLoginPage) {
      console.log('LOGGED IN. HEAD:', st.head.replace(/\n+/g, ' | '));
      cdp.close();
      return;
    }

    console.log(`[attempt ${attempt}] login page (not logged in)`);
    if (UNATTENDED) {
      console.error('ABORT: unattended mode, refuse QR flow. Notify user to login first.');
      cdp.close();
      process.exit(2);
    }

    // 确保在扫码 tab：登录页默认可能是短信登录，找二维码入口（短信表单旁的 image，cursor:pointer）
    const tabRes = await ev(`(() => {
      const imgs = [...document.querySelectorAll('img')].filter(i => {
        const r = i.getBoundingClientRect();
        return r.width > 50 && r.width < 300 && r.height > 50;
      });
      const qrTab = imgs.find(i => i.closest('[class*=tab]') || (i.parentElement && /cursor/.test(i.parentElement.style.cursor)));
      if (qrTab && !/扫码/.test(qrTab.alt || '')) { return 'LOOKS_LIKE_QR_TAB'; }
      return 'DEFAULT_TAB';
    })()`);
    console.log('qr tab state:', tabRes.result.value);
    await sleep(2000);

    // 失效遮罩检测与刷新
    const refreshed = await ev(`(() => {
      const t = document.body.innerText;
      if (/已失效|点击刷新|重新获取/.test(t)) {
        const btn = [...document.querySelectorAll('*')].find(e => e.children.length === 0 && /刷新|重新获取/.test(e.textContent));
        if (btn) { btn.click(); return 'REFRESHED'; }
      }
      return 'FRESH';
    })()`);
    console.log('qr state:', refreshed.result.value);
    await sleep(2500);

    // 截二维码（近正方形 img/canvas）
    const qrBox = await ev(`(() => {
      const cands = [...document.querySelectorAll('img, canvas')].map(el => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      }).filter(b => b.w > 80 && b.w < 600 && Math.abs(b.w - b.h) < 20 && b.x >= 0 && b.y >= 0);
      return JSON.stringify(cands[0] || null);
    })()`);
    const box = JSON.parse(qrBox.result.value);
    if (box) {
      const pad = 24;
      const shot = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.w + pad * 2, height: box.h + pad * 2, scale: 2 },
      });
      fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
      console.log('QR saved to', OUT, '(present to user for scanning)');
    } else {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
      console.log('QR element not isolated, full-page shot saved to', OUT);
    }

    // 轮询等待扫码成功
    let scanned = false;
    for (let i = 0; i < 4; i++) {
      await sleep(5000);
      const p = await ev(`!document.body.innerText.includes('短信登录')`);
      if (p.result.value) { scanned = true; break; }
    }
    if (scanned) {
      await sleep(3000);
      const head = await ev(`document.body.innerText.slice(0, 300)`);
      console.log('LOGGED IN AFTER SCAN. HEAD:', String(head.result.value).replace(/\n+/g, ' | '));
      cdp.close();
      return;
    }
    console.log('not scanned yet, next attempt will refresh QR if expired...');
  }
  console.error('GIVE UP: still not logged in after retries');
  cdp.close();
  process.exit(3);
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
