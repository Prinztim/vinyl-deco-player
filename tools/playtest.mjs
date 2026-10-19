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

console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
ws.close(); chrome.kill(); process.exit(fails ? 1 : 0);
