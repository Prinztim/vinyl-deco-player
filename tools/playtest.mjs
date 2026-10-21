// Playback state-machine test with a fake Spotify player (no network, hidden Chrome).
// node tools/playtest.mjs   -> prints PASS/FAIL for each scenario
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const url = pathToFileURL(resolve(here, '../index.html')).href;
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',
  ['--headless=new', '--disable-gpu', '--remote-debugging-port=9334', '--user-data-dir=' + process.env.TEMP + '/vdp-test', '--host-resolver-rules=MAP *.scdn.co 127.0.0.1, MAP accounts.spotify.com 127.0.0.1, MAP api.spotify.com 127.0.0.1', '--window-size=1180,820', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let tabs; for (let i = 0; i < 50; i++) { try { tabs = await (await fetch('http://127.0.0.1:9334/json')).json(); if (tabs.length) break; } catch {} await sleep(200); }
const ws = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') console.log('PAGE ERROR:', m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); };
const send = (method, params = {}) => new Promise(r => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async expr => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result ? r.result.value : undefined; };

const STUB = `
(() => {
  localStorage.setItem('vdp.auth', JSON.stringify({ access: 'x', refresh: 'y', scope: 'user-library-read', expires: Date.now() + 1e8 }));
  const T = i => ({ id: 't' + i, uri: 'spotify:track:t' + i, name: 'Song ' + i, artists: [{ name: 'Artist' }], album: { images: [{ url: '' }] } });
  class FP {
    constructor() { FP.inst = this; this.l = {}; this.cur = 0; this.paused = true; this.position = 0; this.log = []; }
    addListener(e, f) { this.l[e] = f; }
    connect() { setTimeout(() => this.l.ready && this.l.ready({ device_id: 'dev' }), 30); return Promise.resolve(true); }
    st() { return { paused: this.paused, position: this.position, duration: 200000, shuffle: false, track_window: { current_track: T(this.cur), next_tracks: [T(this.cur + 1), T(this.cur + 2)], previous_tracks: this.cur ? [T(this.cur - 1)] : [] } }; }
    emit() { this.l.player_state_changed && this.l.player_state_changed(this.st()); }
    pause() { this.log.push('pause'); this.paused = true; this.emit(); return Promise.resolve(); }
    resume() { this.log.push('resume'); this.paused = false; this.emit(); return Promise.resolve(); }
    seek(ms) { this.position = ms; return Promise.resolve(); }
    nextTrack() { this.log.push('next'); this.cur++; this.position = 0; this.paused = false; this.emit(); return Promise.resolve(); }
    previousTrack() { this.cur = Math.max(0, this.cur - 1); this.position = 0; this.paused = false; this.emit(); return Promise.resolve(); }
    getCurrentState() { return Promise.resolve(this.st()); }
    activateElement() { return Promise.resolve(); } setVolume() { return Promise.resolve(); } disconnect() {}
  }
  window.Spotify = { Player: FP };
  const realFetch = window.fetch;
  window.fetch = (u, o = {}) => {
    u = String(u); const ok = (j) => Promise.resolve({ ok: true, status: j ? 200 : 204, json: () => Promise.resolve(j || null) });
    if (u.includes('/me/player/play')) { const b = JSON.parse(o.body || '{}'); const uri = (b.uris || [])[0] || 'spotify:track:t5'; FP.inst.cur = +uri.split('t').pop(); FP.inst.position = 0; FP.inst.paused = false; setTimeout(() => FP.inst.emit(), 40); return ok(); }
    if (u.includes('/me/player')) return ok();
    return realFetch(u, o);
  };
})();`;
await send('Page.enable'); await send('Runtime.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
await send('Page.navigate', { url }); await sleep(1500);
await ev('startPlayer()'); await sleep(400);

let fails = 0;
const check = (name, ok, extra = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!ok) fails++; };
const state = () => ev('({ track: S.track && S.track.id, paused: S.paused, swapping: S.swapping, cueing: S.cueing, holding: S.holding, after: !!S.after, expect: S.expect, device: S.deviceId, onPlatter: S.onPlatter })');

// 1. a song starts playing in Spotify: record goes on, music resumes
await ev('FP = Spotify.Player; FP.inst.paused = false; FP.inst.emit()');
await sleep(9000);
let s = await state(); check('1 first song plays after the record is on', s.track === 't0' && !s.paused && !s.swapping && !s.cueing, JSON.stringify(s));

// 2. skip, then press pause during the record swap (leaves a pending skip behind in the old code)
await ev('skip(1)'); await sleep(700); await ev('togglePlay()'); await sleep(7000);
s = await state(); check('2 after pausing during a skip, nothing is stuck', !s.swapping && !s.cueing && !s.holding, JSON.stringify(s));

// 3. pick a song from search while that is pending: it must play (old code ignored and paused it forever)
await ev("playSafe({ uris: ['spotify:track:t9'] }, true)"); await sleep(9500);
s = await state(); check('3 song picked from search plays', s.track === 't9' && !s.paused && !s.swapping && !s.cueing, JSON.stringify(s));

// 4. play button works again after pausing
await ev('togglePlay()'); await sleep(500); s = await state(); check('4a pause works', s.paused, JSON.stringify(s));
await ev('togglePlay()'); await sleep(4500); s = await state(); check('4b play works again', !s.paused && !s.cueing, JSON.stringify(s));

// 5. the player connection dropped: playing must reconnect instead of doing nothing
await ev("FP.inst.l.not_ready({ device_id: 'dev' })"); await sleep(100);
await ev("playSafe({ uris: ['spotify:track:t12'] }, true)"); await sleep(10500);
s = await state(); check('5 plays after the connection dropped', s.track === 't12' && !s.paused, JSON.stringify(s));

// 6. skip when Spotify has nothing after this song (no next track): must not leave the hold on
await ev("FP.inst.st = function () { const o = FP.prototype.st.call(this); o.track_window.next_tracks = []; return o; }; FP.inst.nextTrack = function () { this.log.push('next-noop'); return Promise.resolve(); };");
await ev('skip(1)'); await sleep(12000);
await ev('FP.inst.paused = true; FP.inst.emit()'); await sleep(300);
await ev('togglePlay()'); await sleep(5000);
s = await state(); check('6 play works after a skip that did nothing', !s.paused && !s.holding, JSON.stringify(s));

// 6b. a song reaches its end: Spotify would start the next one by itself; the app must stop first, swap the record, then play the next song once
await ev("delete FP.inst.st; delete FP.inst.nextTrack; FP.inst.log = []; FP.inst.cur = 20; FP.inst.position = 0; FP.inst.paused = false; FP.inst.emit()"); await sleep(9500);
await ev("FP.inst.position = 198400; FP.inst.emit()");           // 1.6 s before the end of a 200 s song
await sleep(1500);
let e1 = await ev("({ log: FP.inst.log.slice(), cur: FP.inst.cur, paused: FP.inst.paused, swapping: S.swapping })");
check('6b near the end the app pauses first; the next song has NOT started yet', e1.log.includes('pause') && !e1.log.includes('next') && e1.cur === 20 && e1.paused, JSON.stringify(e1));
await sleep(8500);
s = await state(); let e2 = await ev("FP.inst.log.slice()");
check('6b after the record swap the next song plays, exactly one skip', s.track === 't21' && !s.paused && !s.swapping && e2.filter(x => x === 'next').length === 1, JSON.stringify({ s, log: e2 }));

// 6c. Space typed into a text field must not pause the music; Space on the page still does
await ev("FP.inst.log = []; window.__i = document.createElement('input'); document.body.appendChild(window.__i); window.__i.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }))"); await sleep(400);
let sp = await ev("({ log: FP.inst.log.slice(), paused: FP.inst.paused })");
check('6c Space in the search box does not pause', !sp.log.includes('pause') && !sp.paused, JSON.stringify(sp));
await ev("window.__i.remove(); document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }))"); await sleep(400);
sp = await ev("({ paused: FP.inst.paused })");
check('6c Space on the page still pauses', sp.paused, JSON.stringify(sp));
await ev("FP.inst.paused = false; FP.inst.emit()"); await sleep(300);
// 6d. a song from search is played inside its album (so Spotify continues afterwards)
await ev("window.__body = songBody('spotify:track:t5', 'spotify:album:a1'); window.__body2 = songBody('spotify:track:t6', null)");
sp = await ev("({ a: window.__body, b: window.__body2 })");
check('6d search song plays inside its album, with a fallback to the single song', sp.a.context_uri === 'spotify:album:a1' && sp.a.offset.uri === 'spotify:track:t5' && sp.b.uris[0] === 'spotify:track:t6', JSON.stringify(sp));

// 6e. the top-left knob opens a sleep timer menu (15/30/45/60/Off); the crackle dial toggles the crackle; the bottom bar timer opens the same menu
await ev("document.getElementById('bTimer').click()"); await sleep(200);
let m1 = await ev("({ open: !document.getElementById('sleepMenu').classList.contains('hidden'), items: [...document.querySelectorAll('#sleepMenu button')].map(b => b.dataset.m).join() })");
check('6e timer button opens the sleep menu with 15, 30, 45, 60, Off', m1.open && m1.items === '15,30,45,60,0', JSON.stringify(m1));
await ev("document.querySelector('#sleepMenu button[data-m=\"45\"]').click()"); await sleep(200);
await ev("document.getElementById('bTimer').click()"); await sleep(300);
let lt = await ev("document.getElementById('sleepLeft').textContent");
check('6e the open menu shows the time left', /^4[45]:\d\d left$/.test(lt), lt);
await ev("document.getElementById('bTimer').click()"); await sleep(100);
m1 = await ev("({ min: sleepMin, left: Math.round((sleepAt - Date.now()) / 60000), closed: document.getElementById('sleepMenu').classList.contains('hidden') })");
check('6e choosing 45 sets the timer and closes the menu', m1.min === 45 && m1.left >= 44 && m1.closed, JSON.stringify(m1));
await ev("document.getElementById('bTimer').click()"); await sleep(200);
m1 = await ev("({ open: !document.getElementById('sleepMenu').classList.contains('hidden') })");
check('6e the bottom bar timer button opens the menu too (no cycling)', m1.open && (await ev('sleepMin')) === 45, JSON.stringify(m1));
await ev("document.querySelector('#sleepMenu button[data-m=\"0\"]').click()");
let c0 = await ev("Sound.on"); await ev("document.getElementById('powerknob').click()"); let c1 = await ev("({ on: Sound.on, attr: document.documentElement.dataset.crackle })");
check('6e the top-left knob toggles the crackle (and its lamp)', c1.on === !c0 && c1.attr === (c1.on ? 'on' : 'off'), JSON.stringify(c1));
await ev("document.getElementById('powerknob').click()");

// 6f. tap on the parked arm continues the song; dragging the record off with the mouse skips to the next song
const mouse = (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
await ev("FP.inst.log = []; FP.inst.cur = 30; FP.inst.position = 5000; FP.inst.paused = false; FP.inst.emit()"); await sleep(9500);
await ev("P.pause()"); await sleep(600);
let pt = await ev("(() => { const r = document.querySelector('#tonearm rect[fill=\"url(#gg)\"]').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()");
await mouse('mousePressed', ...pt); await mouse('mouseReleased', ...pt); await sleep(3800);
s = await state();
check('6f a tap on the parked arm continues the song', !s.paused && s.track === 't30', JSON.stringify(s));
await sleep(1500);
let dp = await ev("(() => { const r = document.getElementById('disc').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2, r.width]; })()");
await mouse('mousePressed', dp[0], dp[1]);
for (let i = 1; i <= 8; i++) await mouse('mouseMoved', dp[0] - dp[2] * 0.6 * i / 8, dp[1]);
await mouse('mouseReleased', dp[0] - dp[2] * 0.6, dp[1]); await sleep(11000);
s = await state();
check('6f dragging the record off with the mouse skips to the next song', s.track === 't31' && !s.paused && !s.swapping, JSON.stringify(s));

// 7-10. the login survives: a refused access token is refreshed once and retried, only a revoked refresh token logs out
const AUTH = (tokenReply, setup = '') => ev(`(async () => {
  ${setup}
  const prev = window.fetch, calls = [];
  window.fetch = (u, o = {}) => { u = String(u);
    const res = (status, j) => Promise.resolve({ ok: status < 300, status, json: () => Promise.resolve(j) });
    if (u.includes('accounts.spotify.com/api/token')) { calls.push('token'); return ${tokenReply}; }
    if (u.endsWith('/v1/me')) { const a = o.headers.Authorization; calls.push('me ' + a); return a === 'Bearer fresh' ? res(200, { id: 'tim' }) : res(401, { error: { status: 401, message: 'The access token expired' } }); }
    return prev(u, o); };
  let me = null, err = null;
  try { me = (await api('/me')).id; } catch (e) { err = e.message; } finally { window.fetch = prev; }
  return { me, err, calls, auth: JSON.parse(localStorage.getItem('vdp.auth')), idb: await authDb.get(), connect: !$('connect').classList.contains('hidden'), why: ($('connectWhy') || {}).textContent || '' };
})()`);
let a = await AUTH(`res(200, { access_token: 'fresh', expires_in: 3600 })`);
check('7 API answers 401: refresh once, retry succeeds, login kept (and mirrored to IndexedDB)', a.me === 'tim' && a.calls.join() === 'me Bearer x,token,me Bearer fresh' && a.auth && a.auth.access === 'fresh' && a.auth.refresh === 'y' && a.idb && a.idb.access === 'fresh' && !a.connect, JSON.stringify(a));

await ev(`window.__f = window.fetch; window.fetch = (u, o = {}) => String(u).includes('accounts.spotify.com/api/token') ? Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ access_token: 'sdkfresh', expires_in: 3600 }) }) : window.__f(u, o); S.deviceId = null; FP.inst.l.authentication_error({ message: 'Invalid token' });`);
await sleep(1000);
s = await ev(`(() => { window.fetch = window.__f; return { auth: JSON.parse(localStorage.getItem('vdp.auth')), device: S.deviceId, connect: !$('connect').classList.contains('hidden'), toast: $('toast').textContent }; })()`);
check('8 SDK authentication_error: refresh + reconnect, login kept', s.auth && s.auth.access === 'sdkfresh' && s.auth.refresh === 'y' && s.device === 'dev' && !s.connect, JSON.stringify(s));

a = await AUTH(`Promise.reject(new TypeError('Failed to fetch'))`, `localStorage.setItem('vdp.auth', JSON.stringify({ access: 'old', refresh: 'y', scope: 'user-library-read', expires: 0 }));`);
check('9 network error while refreshing: login kept', !a.me && a.err && a.calls.join() === 'token' && a.auth && a.auth.refresh === 'y' && !a.connect, JSON.stringify(a));

a = await AUTH(`res(400, { error: 'invalid_grant', error_description: 'Refresh token revoked' })`);
check('10 refresh token revoked (invalid_grant): login cleared everywhere, connect button says why', !a.me && !a.auth && !a.idb && a.connect && /log in again/.test(a.why), JSON.stringify(a));

console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
ws.close(); chrome.kill(); process.exit(fails ? 1 : 0);
