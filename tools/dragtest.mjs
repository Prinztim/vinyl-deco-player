// Hidden-Chrome check: drag the tonearm to the middle of the record and read back the song position.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const [url, out] = process.argv.slice(2);
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',
  ['--headless=new', '--disable-gpu', '--remote-debugging-port=9334', '--user-data-dir=' + process.env.TEMP + '/vdp-drag', '--hide-scrollbars', '--window-size=1366,1024', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let tabs; for (let i = 0; i < 50; i++) { try { tabs = await (await fetch('http://127.0.0.1:9334/json')).json(); if (tabs.length) break; } catch {} await sleep(200); }
const ws = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') console.log('PAGE ERROR:', m.params.exceptionDetails.exception?.description); };
const send = (method, params = {}) => new Promise(r => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result.value;
await send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 1024, deviceScaleFactor: 1, mobile: false });
await send('Page.enable'); await send('Runtime.enable'); await send('Page.navigate', { url });
await sleep(5000);
const pts = await ev(`(() => { const r = document.querySelector('#tonearm rect[fill="url(#gg)"]').getBoundingClientRect();
  const pr = document.getElementById('plinth').getBoundingClientRect(), u = pr.width / 100;
  const [x, y] = needleAt((ARM_OUT + ARM_IN) / 2);
  return { from: [r.left + r.width / 2, r.top + r.height / 2], to: [pr.left + x * u, pr.top + y * u], before: Math.round(curPos() / 1000) }; })()`);
console.log('before drag: song at', pts.before, 's');
const mouse = (type, [x, y]) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
await mouse('mousePressed', pts.from);
for (let i = 1; i <= 10; i++) await mouse('mouseMoved', [pts.from[0] + (pts.to[0] - pts.from[0]) * i / 10, pts.from[1] + (pts.to[1] - pts.from[1]) * i / 10]);
await sleep(200);
const shot = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log('while dragging, display shows:', await ev(`document.getElementById('vfdText').textContent`));
await mouse('mouseReleased', pts.to); await sleep(800);
console.log('after drop: song at', await ev('Math.round(curPos() / 1000)'), 's of', await ev('Math.round(S.dur / 1000)'), '| playing:', await ev('isPlaying()'));
ws.close(); chrome.kill();
