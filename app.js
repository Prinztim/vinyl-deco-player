'use strict';
/* Vinyl Deco Player: a turntable that plays your Spotify (Premium) inside the page. */
const CFG = {
  clientId: '21138b656ddc4d798e0e881360f5506f',
  redirect: 'https://prinztim.github.io/vinyl-deco-player/test/', // registered in the Spotify app; /test/ forwards to the app
  scopes: 'streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state playlist-read-private playlist-read-collaborative user-library-read',
  spinSeconds: 3.2,
};
const $ = id => document.getElementById(id);
const DEMO = new URLSearchParams(location.search).has('demo');
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ---------- small helpers ---------- */
let toastTimer;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 4500);
}
const store = {
  get: k => { try { return JSON.parse(localStorage.getItem('vdp.' + k)); } catch { return null; } },
  set: (k, v) => localStorage.setItem('vdp.' + k, JSON.stringify(v)),
  del: k => localStorage.removeItem('vdp.' + k),
};
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- Spotify login (PKCE, keeps a refresh token so you log in once) ---------- */
async function sha256b64(s) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return btoa(String.fromCharCode(...new Uint8Array(h))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function login() {
  const verifier = Array.from(crypto.getRandomValues(new Uint8Array(48)), b => b.toString(16).padStart(2, '0')).join('');
  store.set('verifier', verifier);
  const q = new URLSearchParams({ client_id: CFG.clientId, response_type: 'code', redirect_uri: CFG.redirect,
    scope: CFG.scopes, code_challenge_method: 'S256', code_challenge: await sha256b64(verifier) });
  location.href = 'https://accounts.spotify.com/authorize?' + q;
}
async function tokenRequest(params) {
  const r = await fetch('https://accounts.spotify.com/api/token', { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CFG.clientId, ...params }) });
  const j = await r.json();
  if (!j.access_token) throw new Error(j.error_description || j.error || 'login failed');
  const old = store.get('auth') || {};
  store.set('auth', { access: j.access_token, refresh: j.refresh_token || old.refresh, scope: j.scope || old.scope || '',
    expires: Date.now() + (j.expires_in - 60) * 1000 });
}
const hasScope = s => ((store.get('auth') || {}).scope || '').split(' ').includes(s);
async function getToken() {
  let a = store.get('auth');
  if (!a) throw new Error('not logged in');
  if (Date.now() > a.expires) {
    await tokenRequest({ grant_type: 'refresh_token', refresh_token: a.refresh });
    a = store.get('auth');
  }
  return a.access;
}
async function api(path, opts = {}) {
  const url = path.startsWith('http') ? path : 'https://api.spotify.com/v1' + path;
  const r = await fetch(url, { ...opts, headers: { Authorization: 'Bearer ' + await getToken(), 'Content-Type': 'application/json' } });
  if (r.status === 401) { store.del('auth'); showConnect(); throw new Error('Session expired, please log in again'); }
  if (!r.ok && r.status !== 204) {
    let m = ''; try { m = (await r.json()).error.message; } catch {}
    throw new Error(m || 'Spotify error ' + r.status);
  }
  return r.status === 204 ? null : r.json().catch(() => null);
}
async function apiAll(path, max = 1000) { // follows Spotify's "next" links so long libraries load completely
  let out = [], url = path;
  while (url && out.length < max) { const d = await api(url); out = out.concat((d.items || []).filter(Boolean)); url = d.next; }
  return out;
}

/* ---------- sound effects: needle drop and optional dust crackle (our own audio, not Spotify's) ---------- */
const Sound = {
  ctx: null, gain: null, on: store.get('crackle') ?? false,
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    const ctx = this.ctx = new AC(), len = ctx.sampleRate * 7, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    let lp = 0;
    for (let i = 0; i < len; i++) { lp = lp * 0.97 + (Math.random() * 2 - 1) * 0.03; d[i] = lp * 0.35; }
    for (let k = 0; k < len * 0.0003; k++) { // pops and ticks
      const at = Math.random() * len | 0, amp = (0.2 + Math.random() * 0.8) * (Math.random() < .5 ? -1 : 1), L = 6 + Math.random() * 40 | 0;
      for (let j = 0; j < L && at + j < len; j++) d[at + j] += amp * Math.exp(-j / (L / 4)) * (j % 2 ? -0.6 : 1);
    }
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 450;
    this.gain = ctx.createGain(); this.gain.gain.value = 0;
    src.connect(hp); hp.connect(this.gain); this.gain.connect(ctx.destination); src.start();
  },
  update(playing) {
    if (!this.gain) return;
    const t = this.ctx.currentTime; this.gain.gain.cancelScheduledValues(t);
    this.gain.gain.setTargetAtTime(this.on && playing ? 0.1 : 0, t, 0.35);
  },
  drop() { // soft thump + tick when the stylus touches the record
    if (!this.ctx || !this.on) return;
    const ctx = this.ctx, t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(70, t); o.frequency.exponentialRampToValueAtTime(38, t + 0.2);
    g.gain.setValueAtTime(0.32, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
    o.connect(g); g.connect(ctx.destination); o.start(t); o.stop(t + 0.3);
    const n = ctx.createBuffer(1, ctx.sampleRate * 0.03, ctx.sampleRate), nd = n.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = (Math.random() * 2 - 1) * Math.exp(-i / 120) * 0.5;
    const s = ctx.createBufferSource(); s.buffer = n; s.connect(ctx.destination); s.start(t);
  },
};
document.addEventListener('pointerdown', () => Sound.init(), { capture: true });

/* ---------- the turntable ---------- */
// geometry in plinth units (1u = 1% of the plinth width); the stylus sits at V in the arm's own frame (see the SVG)
const ARM = { V: [3.2, 42], P: [87, 16.5], C: [46, 37.5], rest: -5 };
const needleAt = deg => { // world position of the stylus for an arm rotated clockwise by deg
  const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  return [ARM.P[0] + ARM.V[0] * c - ARM.V[1] * s, ARM.P[1] + ARM.V[0] * s + ARM.V[1] * c];
};
function armAngleForRadius(r) { // arm angle (deg) whose stylus lands on groove radius r
  for (let a = 0; a < 90; a += 0.2) {
    const [x, y] = needleAt(a);
    if (Math.hypot(x - ARM.C[0], y - ARM.C[1]) <= r) return a;
  }
  return 60;
}
const ARM_OUT = armAngleForRadius(27.5), ARM_IN = armAngleForRadius(12.5);
let armDeg = ARM.rest;
const setArm = deg => { armDeg = deg; $('tonearm').style.setProperty('--arm', deg + 'deg'); };
{ // park the arm rest under the tube at its resting angle
  const r = ARM.rest * Math.PI / 180, ly = 30, lx = 3.2, a = $('armrest');
  a.style.left = (ARM.P[0] + lx * Math.cos(r) - ly * Math.sin(r)) + '%';
  a.style.top = (ARM.P[1] + lx * Math.sin(r) + ly * Math.cos(r)) / 0.80 + '%'; // plinth is 80u tall
}

const spinFx = { duration: CFG.spinSeconds * 1000, iterations: Infinity };
const spin = $('record').animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], spinFx);
const strobeSpin = $('strobe').animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], spinFx);
spin.playbackRate = strobeSpin.playbackRate = 0;
let spinTarget = 0, rpmFactor = 1;
(function spinLoop() { // ease the record up to speed and back down, like a real motor
  const goal = spinTarget * rpmFactor, r = spin.playbackRate, next = r + (goal - r) * 0.035;
  spin.playbackRate = Math.abs(next - goal) < 0.004 ? goal : next;
  strobeSpin.currentTime = spin.currentTime; strobeSpin.playbackRate = spin.playbackRate;
  requestAnimationFrame(spinLoop);
})();

/* ---------- playback state ---------- */
const S = { track: null, paused: true, pos: 0, dur: 1, stamp: 0, deviceId: null, player: null,
  swapping: false, holding: false, holdResume: false, onPlatter: false, queued: null, resumeWanted: false, cueing: false, dragging: false, userId: null };
const curPos = () => S.paused ? S.pos : Math.min(S.dur, S.pos + (Date.now() - S.stamp));
const isPlaying = () => !S.paused && !!S.track && !S.swapping;

function renderArm() {
  if (S.cueing || S.dragging) return;
  if (!isPlaying()) { setArm(ARM.rest); return; }
  setArm(ARM_OUT + (ARM_IN - ARM_OUT) * clamp(curPos() / S.dur, 0, 1));
}
function renderPlaying() {
  document.body.classList.toggle('playing', isPlaying());
  spinTarget = isPlaying() || S.cueing ? 1 : 0;
  $('playIcon').setAttribute('d', isPlaying() ? 'M7 5h4v14H7zm6 0h4v14h-4z' : 'M8 5v14l11-7z');
  renderArm(); Sound.update(isPlaying());
  if (isPlaying()) requestWakeLock();
}
function showTrack(t) { // title and artist text
  const np = $('nowplaying'); np.style.opacity = 0;
  setTimeout(() => {
    $('title').textContent = t ? t.name : 'Vinyl Deco Player';
    $('artist').textContent = t ? t.artist : 'Tap the platter to choose a record';
    np.style.opacity = 1;
  }, 350);
}
function ambientFrom(img) { // tint the room with the album's dominant colour
  try {
    const c = document.createElement('canvas'); c.width = c.height = 8;
    const x = c.getContext('2d'); x.drawImage(img, 0, 0, 8, 8);
    const d = x.getImageData(0, 0, 8, 8).data; let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { if (Math.max(d[i], d[i + 1], d[i + 2]) > 40) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; } }
    if (n) document.documentElement.style.setProperty('--amb', [r, g, b].map(v => Math.min(255, Math.round(v / n * 1.25))).join(','));
  } catch { /* cross-origin image: keep the warm default */ }
}

/* ---------- player control (Spotify or the demo) ---------- */
const P = {
  pause: () => DEMO ? (S.pos = curPos(), S.paused = true, renderPlaying()) : S.player && S.player.pause(),
  resume: async () => { if (DEMO) { S.stamp = Date.now(); S.paused = false; renderPlaying(); return; } await S.player.activateElement(); return S.player.resume(); },
  seek: ms => { S.pos = ms; S.stamp = Date.now(); if (!DEMO && S.player) return S.player.seek(Math.round(ms)); },
};

/* ---------- changing records: music waits while the old record is stashed and the new one is put on ---------- */
const LIFT = 'drop-shadow(0 1.6vw 1.4vw rgba(0,0,0,.55))';
const flight = (frames, ms, easing) => $('disc').animate(frames, { duration: ms, easing, fill: 'forwards' }).finished.catch(() => {});
function loadArt(t) {
  return new Promise(res => {
    const img = $('art'); img.crossOrigin = 'anonymous';
    if (!t || !t.art) { img.removeAttribute('src'); return res(); }
    if (img.getAttribute('src') === t.art) { ambientFrom(img); return res(); }
    img.onload = () => { ambientFrom(img); res(); }; img.onerror = () => res();
    img.src = t.art; setTimeout(res, 1800);
  });
}
async function swapRecord(track, resume) {
  S.queued = track; S.resumeWanted = S.resumeWanted || resume;
  if (S.swapping) return; // a swap is running; it will pick up the newest record
  S.swapping = true; S.cueing = false; renderPlaying(); // arm back to its rest, motor winds down
  while (S.queued) {
    const t = S.queued; S.queued = null;
    if (S.onPlatter) {
      await sleep(armDeg > ARM.rest + 1 ? 1000 : 250);
      await flight([{ transform: 'none', filter: 'none' },
        { transform: 'scale(1.07)', filter: LIFT, offset: .3 },
        { transform: 'translate(-168%, -8%) rotate(-12deg) scale(1.07)', filter: LIFT }], 950, 'cubic-bezier(.55,0,.75,.45)');
      S.onPlatter = false; $('disc').classList.add('off'); stash(S.lastOn);
      if (S.queued) continue; // skipped again while lifting: go straight to the newest record
    }
    await loadArt(t);
    if (S.queued) continue;
    $('disc').classList.remove('off');
    await flight([{ transform: 'translate(0, 125%) rotate(8deg) scale(1.07)', filter: LIFT },
      { transform: 'scale(1.07)', filter: LIFT, offset: .72 },
      { transform: 'none', filter: 'none' }], 1250, 'cubic-bezier(.25,.6,.3,1)');
    S.onPlatter = true; S.lastOn = t;
  }
  S.swapping = false; S.holding = false;
  if (S.resumeWanted) { S.resumeWanted = false; await cueAndPlay(true); } else renderPlaying();
}
async function cueAndPlay(fromStart) { // lower the arm onto the record, then start the music
  S.cueing = true; renderPlaying();
  setArm(ARM_OUT + (ARM_IN - ARM_OUT) * (fromStart ? 0 : clamp(curPos() / S.dur, 0, 1)));
  await sleep(1050); Sound.drop();
  try {
    if (S.after) { const go = S.after; S.after = null; setTimeout(() => { S.expect = null; }, 4000); await go(); await sleep(250); await P.resume(); } // skip: Spotify moves to the new song only now
    else { if (fromStart) await P.seek(0); await P.resume(); }
  } catch (e) { toast(e.message); }
  await sleep(700); S.cueing = false; renderPlaying();
  if (!DEMO) setTimeout(() => { if (S.paused && !S.swapping) toast('Tap the record to keep playing'); }, 1500);
}
function stash(t) { // remember records that were taken off, newest first
  if (!t || !t.uri) return;
  const h = (store.get('recent') || []).filter(x => x.uri !== t.uri);
  h.unshift({ uri: t.uri, name: t.name, artist: t.artist, art: t.art }); store.set('recent', h.slice(0, 30));
}

function onState(s) {
  if (!s || !s.track_window.current_track) return;
  const t = s.track_window.current_track;
  const track = { id: t.id || t.uri, uri: t.uri, name: t.name, artist: t.artists.map(a => a.name).join(', '), art: (t.album.images[0] || {}).url };
  if (S.expect && S.expect !== track.id && (S.swapping || S.after)) { if (!s.paused) S.player.pause(); return; } // still the old song while the record is being changed
  if (S.expect === track.id) S.expect = null;
  const changed = !S.track || S.track.id !== track.id;
  S.paused = s.paused; S.pos = s.position; S.dur = s.duration || 1; S.stamp = Date.now();
  if (changed) {
    S.track = track; showTrack(track);
    const playing = !s.paused || S.holdResume;
    S.holdResume = false; S.holding = true;
    if (!s.paused) S.player.pause(); // no music until the new record is on the platter
    swapRecord(track, playing);
  } else if (!s.paused && (S.holding || S.swapping)) S.player.pause(); // Spotify started late: keep it silent until the record is on
  renderPlaying();
}
setInterval(renderArm, 1000);

/* ---------- actions ---------- */
let shuffleOn = !!store.get('shuffle');
const setShuffle = on => api('/me/player/shuffle?state=' + on + '&device_id=' + S.deviceId, { method: 'PUT' });
async function play(body, remember, total) { // total = number of tracks, so a shuffled start can be a random track
  if (DEMO) return toast('Demo mode: Spotify is not connected');
  if (!S.deviceId) return toast('Player is still starting, try again in a moment');
  await S.player.activateElement();
  const b = { ...body };
  if (shuffleOn && total > 1 && b.context_uri && !b.offset) b.offset = { position: Math.floor(Math.random() * total) };
  try { await setShuffle(shuffleOn); } catch { /* playing still works without it */ }
  await api('/me/player/play?device_id=' + S.deviceId, { method: 'PUT', body: JSON.stringify(b) });
  if (remember) store.set('last', body);
}
const playSafe = (body, remember, total) => play(body, remember, total).catch(e => toast(e.message));
async function playLiked() {
  try {
    if (!S.userId) S.userId = (await api('/me')).id;
    const total = shuffleOn ? (await api('/me/tracks?limit=1')).total : 0;
    await play({ context_uri: `spotify:user:${S.userId}:collection` }, true, total);
  } catch { // fallback: queue the newest liked songs directly
    try { const d = await api('/me/tracks?limit=50'); await play({ uris: d.items.map(i => i.track.uri) }, true); } catch (e) { toast(e.message); }
  }
}
async function togglePlay() {
  if (S.swapping) { S.resumeWanted = !S.resumeWanted; return; }
  if (S.cueing) return;
  if (!DEMO && !S.player) return;
  if (!DEMO && !store.get('auth')) return showConnect();
  if (S.track) return isPlaying() ? P.pause() : cueAndPlay(false);
  const last = store.get('last');
  if (last) playSafe(typeof last === 'string' ? { context_uri: last } : last); else openSheet();
}
function trackOf(t) { return { id: t.id || t.uri, uri: t.uri, name: t.name, artist: t.artists.map(a => a.name).join(', '), art: (t.album.images[0] || {}).url }; }
async function skip(dir) { // the record changes first; Spotify is only told to skip when the needle drops, so the song starts once
  if (DEMO) return demoSkip(dir);
  if (!S.player || S.cueing) return;
  if (S.swapping) { S.resumeWanted = true; return; }
  const st = await S.player.getCurrentState().catch(() => null);
  const w = st && st.track_window, cand = w && (dir > 0 ? w.next_tracks[0] : w.previous_tracks[w.previous_tracks.length - 1]);
  const wasPlaying = isPlaying();
  if (dir < 0 && curPos() > 3000) { // like a real "back": restart this record
    S.swapping = true; renderPlaying(); try { await S.player.pause(); } catch {}
    S.swapping = false; return cueAndPlay(true);
  }
  if (!cand) { S.holdResume = wasPlaying; S.holding = true; try { await S.player.pause(); } catch {} return dir > 0 ? S.player.nextTrack() : S.player.previousTrack(); }
  const track = trackOf(cand);
  S.expect = track.id; S.after = () => dir > 0 ? S.player.nextTrack() : S.player.previousTrack();
  try { if (!S.paused) await S.player.pause(); } catch {}
  S.track = track; showTrack(track); swapRecord(track, true);
}
const next = () => skip(1), prev = () => skip(-1);

/* ---------- record crate: playlists, liked songs, albums, recently played ---------- */
let tab = 'playlists';
const loaded = {};
function card(img, name, sub, onclick, cls = '') {
  const c = document.createElement('button'); c.className = 'card ' + cls;
  c.innerHTML = `<div class="sleeve">${img ? `<img src="${esc(img)}" alt="" loading="lazy">` : '<div class="ph"></div>'}</div><div class="n">${esc(name)}</div><div class="s">${esc(sub)}</div>`;
  c.onclick = () => { $('sheet').classList.add('hidden'); onclick(); };
  return c;
}
function needLibrary(box) {
  const b = document.createElement('div'); b.className = 'notice';
  b.innerHTML = 'To show your Liked Songs and saved albums, Spotify needs one more permission.<br><button>Reconnect Spotify</button>';
  b.querySelector('button').onclick = login; box.appendChild(b);
}
async function renderTab() {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  const box = $('lists'); box.innerHTML = '<div class="loading">Loading…</div>'; $('count').textContent = '';
  try {
    if (tab === 'search') return renderSearch(box);
    if (DEMO) { box.innerHTML = ''; DEMO_TRACKS.forEach(t => box.appendChild(card(t.art, t.name, t.artist, () => toast('Demo mode')))); return; }
    if (tab === 'playlists') {
      const items = loaded.playlists || (loaded.playlists = await apiAll('/me/playlists?limit=50'));
      box.innerHTML = '';
      if (hasScope('user-library-read')) box.appendChild(card(null, 'Liked Songs', 'Your library', playLiked, 'liked'));
      items.forEach(p => box.appendChild(card(p.images && p.images[0] && p.images[0].url, p.name,
        (p.items || p.tracks) ? (p.items || p.tracks).total + ' tracks' : 'by ' + ((p.owner && p.owner.display_name) || 'Spotify'),
        () => playSafe({ context_uri: p.uri }, true, (p.items || p.tracks || {}).total || 0))));
      $('count').textContent = items.length + ' playlists';
      if (!hasScope('user-library-read')) needLibrary(box);
    } else if (tab === 'albums') {
      if (!hasScope('user-library-read')) { box.innerHTML = ''; return needLibrary(box); }
      const items = loaded.albums || (loaded.albums = await apiAll('/me/albums?limit=50', 500));
      box.innerHTML = '';
      items.forEach(({ album: a }) => box.appendChild(card(a.images[0] && a.images[0].url, a.name, a.artists.map(x => x.name).join(', '),
        () => playSafe({ context_uri: a.uri }, true, a.total_tracks || 0))));
      $('count').textContent = items.length + ' albums';
      if (!items.length) box.textContent = 'No saved albums yet.';
    } else {
      const items = store.get('recent') || [];
      box.innerHTML = '';
      items.forEach(t => box.appendChild(card(t.art, t.name, t.artist, () => playSafe({ uris: [t.uri] }))));
      $('count').textContent = items.length + ' records';
      if (!items.length) box.textContent = 'Records you take off the turntable will be stacked here.';
    }
  } catch (e) { box.textContent = 'Could not load: ' + e.message; }
}
function openSheet() { $('sheet').classList.remove('hidden'); hideControlsSoon(true); renderTab(); }
document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => { tab = b.dataset.tab; renderTab(); });

/* search: songs, albums, playlists and artists from all of Spotify */
let searchQ = '', searchTimer;
function renderSearch(box) {
  box.innerHTML = ''; $('count').textContent = '';
  const inp = document.createElement('input'); inp.id = 'q'; inp.type = 'search'; inp.placeholder = 'Search songs, albums, artists, playlists'; inp.value = searchQ;
  inp.setAttribute('autocomplete', 'off'); inp.setAttribute('autocorrect', 'off'); inp.setAttribute('autocapitalize', 'off'); inp.enterKeyHint = 'search';
  const out = document.createElement('div'); out.id = 'results';
  box.appendChild(inp); box.appendChild(out);
  const go = async () => {
    searchQ = inp.value.trim(); clearTimeout(searchTimer);
    if (searchQ.length < 2) { out.innerHTML = '<div class="loading">Type at least two letters.</div>'; return; }
    out.innerHTML = '<div class="loading">Searching…</div>';
    try {
      const r = DEMO ? { tracks: { items: DEMO_TRACKS.filter(t => (t.name + t.artist).toLowerCase().includes(searchQ.toLowerCase())).map(t => ({ uri: t.uri, name: t.name, artists: [{ name: t.artist }], album: { images: [{ url: t.art }] } })) } }
        : await api('/search?type=track,album,artist,playlist&limit=10&q=' + encodeURIComponent(searchQ));
      if (inp.value.trim() !== searchQ) return; // a newer search is already running
      out.innerHTML = '';
      const sec = (title, items, make) => { items = (items || []).filter(Boolean); if (!items.length) return 0;
        const h = document.createElement('div'); h.className = 'sec'; h.textContent = title; out.appendChild(h); items.forEach(i => out.appendChild(make(i))); return items.length; };
      const img = o => (o.images && o.images[0] && o.images[0].url) || (o.album && o.album.images && o.album.images[0] && o.album.images[0].url);
      let n = 0;
      n += sec('Songs', r.tracks && r.tracks.items, t => card(img(t), t.name, t.artists.map(a => a.name).join(', '), () => playSafe({ uris: [t.uri] }, true)));
      n += sec('Albums', r.albums && r.albums.items, a => card(img(a), a.name, a.artists.map(x => x.name).join(', '), () => playSafe({ context_uri: a.uri }, true, a.total_tracks || 0)));
      n += sec('Artists', r.artists && r.artists.items, a => card(img(a), a.name, 'Artist', () => playSafe({ context_uri: a.uri }, true), 'artist'));
      n += sec('Playlists', r.playlists && r.playlists.items, p => card(img(p), p.name, 'by ' + ((p.owner && p.owner.display_name) || 'Spotify'), () => playSafe({ context_uri: p.uri }, true)));
      if (!n) out.innerHTML = '<div class="loading">Nothing found for "' + esc(searchQ) + '".</div>';
    } catch (e) { out.innerHTML = '<div class="loading">Search failed: ' + esc(e.message) + '</div>'; }
  };
  inp.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(go, 450); });
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); go(); } });
  if (searchQ) go(); else { out.innerHTML = '<div class="loading">Find any song on Spotify, not just your own playlists.</div>'; setTimeout(() => inp.focus(), 50); }
}

/* ---------- display on the plinth: clock, song time, pitch, sleep timer ---------- */
let vfdMode = store.get('vfd') || 'clock', vfdFlash = null, vfdFlashUntil = 0, sleepAt = 0;
const mmss = ms => { const s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
function flashVfd(text, ms = 1600) { vfdFlash = text; vfdFlashUntil = Date.now() + ms; renderVfd(); }
function renderVfd() {
  let txt;
  const flashing = Date.now() < vfdFlashUntil;
  if (flashing) txt = vfdFlash;
  else if (vfdMode === 'time' && S.track) txt = '-' + mmss(S.dur - curPos());
  else { const d = new Date(); txt = String(d.getHours()).padStart(2, '0') + (d.getSeconds() % 2 ? ' ' : ':') + String(d.getMinutes()).padStart(2, '0'); }
  $('vfdText').textContent = txt;
  $('vfdMode').textContent = flashing ? '' : vfdMode === 'time' && S.track ? 'REMAIN' : 'TIME';
  $('vfdSleep').classList.toggle('on', !!sleepAt);
}
setInterval(renderVfd, 500);
$('vfd').addEventListener('click', e => { e.stopPropagation(); vfdMode = vfdMode === 'clock' ? 'time' : 'clock'; store.set('vfd', vfdMode); vfdFlashUntil = 0; renderVfd(); });

/* sleep timer: stops the music after a while */
const SLEEP_STEPS = [0, 15, 30, 60, 90];
let sleepIdx = 0;
$('bTimer').onclick = () => {
  sleepIdx = (sleepIdx + 1) % SLEEP_STEPS.length; const m = SLEEP_STEPS[sleepIdx];
  sleepAt = m ? Date.now() + m * 60000 : 0;
  $('bTimer').classList.toggle('on', !!m);
  toast(m ? `Sleep timer: music stops in ${m} min` : 'Sleep timer off'); flashVfd(m ? 'SL ' + m : 'SL --');
};
setInterval(() => { if (sleepAt && Date.now() > sleepAt) { sleepAt = 0; sleepIdx = 0; $('bTimer').classList.remove('on'); if (isPlaying()) P.pause(); toast('Sleep timer: good night'); } }, 5000);

/* ---------- tonearm: drag it across the record to jump within the song, or back to its rest to stop ---------- */
{
  const arm = $('tonearm'), V_ANG = Math.atan2(ARM.V[1], ARM.V[0]) * 180 / Math.PI;
  const angleAt = e => { const r = $('armbase').getBoundingClientRect();
    return clamp(Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180 / Math.PI - V_ANG, ARM.rest, ARM_IN + 1); };
  let grabbed = false;
  arm.addEventListener('pointerdown', e => {
    if (S.swapping || S.cueing || !S.track) return;
    e.stopPropagation(); e.preventDefault(); grabbed = true; S.dragging = true;
    arm.classList.add('drag'); arm.setPointerCapture(e.pointerId); setArm(angleAt(e));
  });
  arm.addEventListener('pointermove', e => {
    if (!grabbed) return; const a = angleAt(e); setArm(a);
    if (a > ARM_OUT - 1.5) flashVfd(mmss(clamp((a - ARM_OUT) / (ARM_IN - ARM_OUT), 0, 1) * S.dur), 800);
  });
  const release = async e => {
    if (!grabbed) return; grabbed = false; arm.classList.remove('drag');
    const a = angleAt(e);
    if (a > ARM_OUT - 1.5) { // dropped on the record: jump there and play
      const ms = clamp((a - ARM_OUT) / (ARM_IN - ARM_OUT), 0, 1) * S.dur;
      try { await P.seek(ms); if (S.paused) { Sound.drop(); await P.resume(); } } catch (err) { toast(err.message); }
    } else if (isPlaying()) P.pause(); // put back on its rest: stop
    setTimeout(() => { S.dragging = false; renderPlaying(); }, 300);
  };
  arm.addEventListener('pointerup', release); arm.addEventListener('pointercancel', release);
}

/* ---------- controls: tap background to show, tap record to play, swipe for next/prev ---------- */
let hideTimer;
function showControls() { $('controls').classList.remove('hidden'); document.body.classList.add('ctl'); hideControlsSoon(); }
function hideControlsSoon(now) { clearTimeout(hideTimer); hideTimer = setTimeout(() => { $('controls').classList.add('hidden'); document.body.classList.remove('ctl'); }, now ? 0 : 6000); }
$('stage').addEventListener('click', e => {
  if (!$('skinSheet').classList.contains('hidden')) return closeSkins();
  if (e.target.closest('#ctl, #pitch, #tonearm, #vfd') || S.dragging) return;
  if (e.target.closest('#platter')) { if (!S.track && !store.get('last')) openSheet(); else togglePlay(); showControls(); }
  else if ($('controls').classList.contains('hidden')) showControls(); else hideControlsSoon(true);
});
let sx = 0, sy = 0;
$('stage').addEventListener('touchstart', e => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
$('stage').addEventListener('touchend', e => {
  if (S.dragging) return;
  const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
  if (Math.abs(dx) > 70 && Math.abs(dy) < 60) { dx < 0 ? next() : prev(); showControls(); }
}, { passive: true });
$('controls').addEventListener('pointerdown', () => { clearTimeout(hideTimer); hideControlsSoon(); });
$('startstop').onclick = togglePlay;

/* speed buttons and pitch fader turn the record faster or slower (Spotify does not allow changing the music's speed) */
let rpmBase = 1, rpmPitch = 1;
const setRpm = () => { rpmFactor = rpmBase * rpmPitch; };
document.querySelectorAll('.pbtn[data-spd]').forEach(b => b.onclick = () => {
  rpmBase = b.dataset.spd === '45' ? 1.36 : 1; setRpm(); flashVfd(b.dataset.spd + ' RPM');
  document.querySelectorAll('.pbtn[data-spd]').forEach(x => x.classList.toggle('on', x === b));
});
$('spd33').classList.add('on');
{ const slot = document.querySelector('#pitch .slot'), fader = document.querySelector('#pitch .fader');
  const move = e => { const r = slot.getBoundingClientRect(), f = clamp((e.clientY - r.top) / r.height, 0, 1);
    fader.style.top = (f * 100) + '%'; fader.style.marginTop = 'calc(var(--u) * -1.2)';
    rpmPitch = 1.08 - f * 0.16; setRpm(); const p = (rpmPitch - 1) * 100; flashVfd((p >= 0 ? '+' : '') + p.toFixed(1) + '%', 1200); };
  slot.parentElement.addEventListener('pointerdown', e => { e.stopPropagation(); slot.setPointerCapture?.(e.pointerId); move(e); slot.onpointermove = move; });
  slot.parentElement.addEventListener('pointerup', () => { slot.onpointermove = null; });
  slot.parentElement.addEventListener('dblclick', () => { fader.style.top = ''; fader.style.marginTop = ''; rpmPitch = 1; setRpm(); flashVfd('+0.0%'); }); }

$('bPlay').onclick = togglePlay; $('bNext').onclick = next; $('bPrev').onclick = prev;
$('bPlaylists').onclick = openSheet; $('sheetClose').onclick = () => $('sheet').classList.add('hidden');
$('bShuffle').classList.toggle('on', shuffleOn);
$('bShuffle').onclick = async () => {
  shuffleOn = !shuffleOn; store.set('shuffle', shuffleOn); $('bShuffle').classList.toggle('on', shuffleOn);
  toast(shuffleOn ? 'Shuffle on: a playlist or album starts on a random song' : 'Shuffle off');
  if (!DEMO && S.deviceId && S.track) setShuffle(shuffleOn).catch(() => {}); // also change what is playing now
};
$('bNight').onclick = () => { document.body.classList.toggle('night'); $('bNight').classList.toggle('on', document.body.classList.contains('night')); store.set('night', document.body.classList.contains('night')); };
if (store.get('night')) { document.body.classList.add('night'); $('bNight').classList.add('on'); }
$('bDust').classList.toggle('on', Sound.on);
$('bDust').onclick = () => { Sound.on = !Sound.on; store.set('crackle', Sound.on); $('bDust').classList.toggle('on', Sound.on); Sound.init(); Sound.update(isPlaying());
  toast(Sound.on ? 'Vinyl crackle on' : 'Vinyl crackle off'); };
if (IS_IOS) $('vol').style.display = 'none'; // iOS ignores web volume; use the iPad volume buttons
$('vol').value = store.get('vol') ?? 70;
$('vol').oninput = e => { store.set('vol', +e.target.value); S.player && S.player.setVolume(e.target.value / 100); };

/* ---------- turntable skins: same player, different cabinet (looks live in skins.css) ---------- */
const SKINS = [
  { id: 'walnut', name: 'Walnut', badge: ['VINYL', 'DECO · HI-FI'], drive: 'DIRECT DRIVE · QUARTZ LOCK', room: '#0d0b09' },
  { id: 'teak', name: 'Teak', badge: ['TEAK', 'NORDIC · 62'], drive: 'BELT DRIVE · HAND OILED TEAK', room: '#100a07' },
  { id: 'acrylic', name: 'Smoked Acrylic', badge: ['PRISM', 'CLEAR AUDIO'], drive: 'ISOLATED PLATTER · LED EDGE', room: '#06060b' },
  { id: 'deco', name: 'Art Deco', badge: ['ODEON', 'EST · 1932'], drive: '', room: '#0a0806' },
  { id: 'cream', name: "Cream '72", badge: ['vinyl', 'PS 72'], drive: 'BELT DRIVE', room: '#3a3a3a' },
  { id: 'dj', name: 'DJ Deck', badge: ['VINYL', 'DJ · MK II'], drive: 'DIRECT DRIVE · HIGH TORQUE', room: '#070505' },
  { id: 'marble', name: 'Marble', badge: ['MARMO', 'STONE · BRASS'], drive: 'BELT DRIVE · CARRARA MARBLE', room: '#e8e4dd' },
];
function applySkin(id) {
  const k = SKINS.find(x => x.id === id) || SKINS[0];
  document.documentElement.dataset.skin = k.id;
  $('badge').querySelector('b').textContent = k.badge[0]; $('badge').querySelector('span').textContent = k.badge[1];
  $('silkDrive').textContent = k.drive;
  document.querySelector('meta[name=theme-color]').content = k.room;
  document.querySelectorAll('#skinList .skin').forEach(c => c.classList.toggle('on', c.dataset.id === k.id));
  return k;
}
SKINS.forEach(k => {
  const c = document.createElement('button'); c.className = 'skin'; c.dataset.id = k.id;
  c.innerHTML = `<img src="skins/${k.id}.jpg" alt=""><span>${esc(k.name)}</span>`;
  c.onclick = () => {
    if (document.documentElement.dataset.skin === k.id) return;
    $('stage').classList.add('swapskin'); store.set('skin', k.id);
    setTimeout(() => { applySkin(k.id); $('stage').classList.remove('swapskin'); }, 300);
  };
  $('skinList').appendChild(c);
});
const openSkins = () => { $('sheet').classList.add('hidden'); $('skinSheet').classList.remove('hidden'); clearTimeout(hideTimer); };
const closeSkins = () => { $('skinSheet').classList.add('hidden'); hideControlsSoon(); };
$('bSkin').onclick = () => $('skinSheet').classList.contains('hidden') ? openSkins() : closeSkins();
$('skinClose').onclick = closeSkins;
$('skinSheet').addEventListener('pointerdown', () => clearTimeout(hideTimer));
{ const q = new URLSearchParams(location.search);
  applySkin(q.get('skin') || store.get('skin') || 'walnut');
  if (q.has('clean')) document.body.classList.add('clean'); } // ?clean: turntable only (for the preview pictures)

/* glass lid on/off */
$('bLid').onclick = () => { document.body.classList.toggle('lidoff'); $('bLid').classList.toggle('on', !document.body.classList.contains('lidoff')); store.set('lid', !document.body.classList.contains('lidoff')); };
if (store.get('lid') === false) document.body.classList.add('lidoff'); $('bLid').classList.toggle('on', !document.body.classList.contains('lidoff'));

/* keep the screen awake while a record is playing */
let wake = null;
async function requestWakeLock() { try { if ('wakeLock' in navigator && !wake) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => wake = null); } } catch { /* not allowed */ } }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && isPlaying()) requestWakeLock(); });
document.addEventListener('keydown', e => { if (e.code === 'Space') { e.preventDefault(); togglePlay(); } if (e.code === 'ArrowRight') next(); if (e.code === 'ArrowLeft') prev(); });

/* ---------- start-up ---------- */
function showConnect() { $('connect').classList.remove('hidden'); }
$('bConnect').onclick = login;

function startPlayer() {
  const p = new Spotify.Player({ name: 'Vinyl Deco Player', volume: (store.get('vol') ?? 70) / 100,
    getOAuthToken: cb => getToken().then(cb).catch(e => toast(e.message)) });
  S.player = p;
  p.addListener('ready', ({ device_id }) => { S.deviceId = device_id; });
  p.addListener('not_ready', () => { S.deviceId = null; setTimeout(() => S.player && !S.deviceId && S.player.connect(), 2500); }); // reconnect after a drop
  p.addListener('player_state_changed', onState);
  p.addListener('initialization_error', e => toast('Player: ' + e.message));
  p.addListener('authentication_error', e => { toast('Login problem: ' + e.message); store.del('auth'); showConnect(); });
  p.addListener('account_error', () => toast('Spotify Premium is required to play music here'));
  p.addListener('playback_error', e => toast('Playback: ' + e.message));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !S.deviceId) p.connect(); }); // coming back from the Home Screen / lock screen
  p.connect();
}

async function init() {
  setArm(ARM.rest); showTrack(null); renderVfd(); $('disc').classList.add('off');
  if (DEMO) return demo();
  const code = new URLSearchParams(location.search).get('code');
  if (code) {
    try { await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: CFG.redirect, code_verifier: store.get('verifier') }); }
    catch (e) { toast(e.message); }
    history.replaceState(null, '', location.pathname);
  }
  if (!store.get('auth')) return showConnect();
  const sdk = document.createElement('script'); sdk.src = 'https://sdk.scdn.co/spotify-player.js';
  window.onSpotifyWebPlaybackSDKReady = startPlayer; document.head.appendChild(sdk);
  setTimeout(showControls, 600);
}

/* ---------- ?demo=1 : preview without Spotify (?demo=paused, ?demo=swap, ?demo=sheet, ?demo=skins) ---------- */
const DEMO_TRACKS = [['Golden Hour', 'Demo Artist', '#f6c37a', '#d9783c', '#3a2a3f', '#ffe3a8'],
  ['Blue Hours', 'Night Owls', '#7fb2ff', '#3d5fc4', '#101a3d', '#e6f1ff'],
  ['Green Room', 'The Fernes', '#b7e08a', '#4a9a5b', '#12301f', '#f3ffd9']].map(([name, artist, c1, c2, c3, sun]) => ({
  id: name, uri: 'demo:' + name, name, artist, art: 'data:image/svg+xml;utf8,' + encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='300' height='300'><defs><linearGradient id='g' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='${c1}'/><stop offset='.55' stop-color='${c2}'/><stop offset='1' stop-color='${c3}'/></linearGradient></defs><rect width='300' height='300' fill='url(#g)'/><circle cx='150' cy='150' r='58' fill='${sun}'/><rect y='190' width='300' height='110' fill='${c3}'/></svg>`) }));
let demoIdx = 0;
function demoSkip(d) {
  demoIdx = (demoIdx + d + DEMO_TRACKS.length) % DEMO_TRACKS.length;
  const wasPlaying = isPlaying() || S.resumeWanted;
  S.track = DEMO_TRACKS[demoIdx]; S.pos = 0; S.paused = true; showTrack(S.track); swapRecord(S.track, wasPlaying);
}
function demo() {
  const mode = new URLSearchParams(location.search).get('demo');
  S.track = mode === 'long' ? { ...DEMO_TRACKS[0], name: 'A Very Long Song Title That Keeps Going (Remastered 2011 · Live at the Royal Albert Hall)', artist: 'The Extremely Long Named Orchestra, Featuring Many Guests' } : DEMO_TRACKS[0]; S.dur = 200000; S.pos = 40000; S.stamp = Date.now(); S.paused = true;
  showTrack(S.track); showControls();
  swapRecord(S.track, mode !== 'paused');
  if (mode === 'swap') setTimeout(() => demoSkip(1), 6500);
  if (mode === 'sheet') openSheet();
  if (mode === 'skins') openSkins();
  if (mode === 'search') { tab = 'search'; searchQ = 'ee'; openSheet(); }
}
init();
