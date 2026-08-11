// Minimal CDP client helper (Node >=22 native WebSocket, zero deps)
// Port via env CDP_PORT (default 9222)
const http = require('http');
const PORT = Number(process.env.CDP_PORT || 9222);

function httpJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = (e) => reject(new Error('ws error: ' + (e.message || 'unknown')));
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        (this.listeners.get(msg.method) || []).forEach((fn) => fn(msg.params));
      }
    };
  }
  send(method, params = {}, timeoutMs = 30000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('timeout: ' + method)); }, timeoutMs);
      this.pending.set(id, {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }
  close() { try { this.ws.close(); } catch (_) {} }
}

async function getPageTarget(urlIncludes) {
  const targets = await httpJson('/json');
  return targets.filter((t) => t.type === 'page').find((t) => !urlIncludes || t.url.includes(urlIncludes))
    || targets.filter((t) => t.type === 'page')[0];
}

async function connectTo(target) {
  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.ready;
  return cdp;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { httpJson, CDP, getPageTarget, connectTo, sleep, PORT };
