// Screenshot helper: node shot.mjs <url> <out-prefix> <ms1,ms2,...> [width] [height]
// Starts a hidden Chrome (headless, no window on the desktop), loads the page and saves a PNG at each time (ms after load).
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const [url, prefix, times = '3000', W = '1366', H = '1024'] = process.argv.slice(2);
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',
  ['--headless=new', '--disable-gpu', '--remote-debugging-port=9333', '--user-data-dir=' + process.env.TEMP + '/vdp-shot', '--hide-scrollbars', `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let tabs; for (let i = 0; i < 50; i++) { try { tabs = await (await fetch('http://127.0.0.1:9333/json')).json(); if (tabs.length) break; } catch {} await sleep(200); }
const ws = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise(r => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
await send('Emulation.setDeviceMetricsOverride', { width: +W, height: +H, deviceScaleFactor: 1, mobile: false });
await send('Page.enable'); await send('Page.navigate', { url });
const t0 = Date.now();
for (const t of times.split(',').map(Number)) {
  await sleep(Math.max(0, t - (Date.now() - t0)));
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${prefix}-${t}.png`, Buffer.from(r.data, 'base64')); console.log('saved', `${prefix}-${t}.png`, 'at', Date.now() - t0, 'ms');
}
ws.close(); chrome.kill();
