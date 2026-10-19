'use strict';
/* Vinyl Deco Player: a turntable that plays your Spotify (Premium) inside the page. */
const CFG = {
  clientId: '21138b656ddc4d798e0e881360f5506f',
  redirect: 'https://prinztim.github.io/vinyl-deco-player/test/', // registered in the Spotify app; /test/ forwards to the app
  scopes: 'streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state playlist-read-private playlist-read-collaborative',
  spinSeconds: 3.2,
};
const $ = id => document.getElementById(id);
const DEMO = new URLSearchParams(location.search).has('demo');
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

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
  store.set('auth', { access: j.access_token, refresh: j.refresh_token || (store.get('auth') || {}).refresh,
    expires: Date.now() + (j.expires_in - 60) * 1000 });
}
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
  const r = await fetch('https://api.spotify.com/v1' + path, { ...opts,
    headers: { Authorization: 'Bearer ' + await getToken(), 'Content-Type': 'application/json' } });
  if (r.status === 401) { store.del('auth'); showConnect(); throw new Error('Session expired, please log in again'); }
  if (!r.ok && r.status !== 204) {
    let m = ''; try { m = (await r.json()).error.message; } catch {}
    throw new Error(m || 'Spotify error ' + r.status);
  }
  return r.status === 204 ? null : r.json().catch(() => null);
}

/* ---------- the turntable ---------- */
const ARM = { L: 40, P: [87, 16.5], C: [46, 37.5], rest: -5 };
function armAngleForRadius(r) { // find the arm angle (deg) whose needle lands on groove radius r (in plinth units)
  for (let a = 0; a < 90; a += 0.2) {
    const rad = a * Math.PI / 180;
    const x = ARM.P[0] - ARM.L * Math.sin(rad), y = ARM.P[1] + ARM.L * Math.cos(rad);
    if (Math.hypot(x - ARM.C[0], y - ARM.C[1]) <= r) return a;
  }
  return 60;
}
const ARM_OUT = armAngleForRadius(27.5), ARM_IN = armAngleForRadius(12.5);
const setArm = deg => $('tonearm').style.setProperty('--arm', deg + 'deg');

const spin = $('record').animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
  { duration: CFG.spinSeconds * 1000, iterations: Infinity });
spin.playbackRate = 0;
let spinTarget = 0;
(function spinLoop() { // ease the record up to speed and back down, like a real motor
  const r = spin.playbackRate, next = r + (spinTarget - r) * 0.035;
  spin.playbackRate = Math.abs(next - spinTarget) < 0.004 ? spinTarget : next;
  requestAnimationFrame(spinLoop);
})();

/* ---------- playback state ---------- */
const S = { track: null, paused: true, pos: 0, dur: 1, stamp: 0, deviceId: null, player: null, armLifted: false };
const curPos = () => S.paused ? S.pos : Math.min(S.dur, S.pos + (Date.now() - S.stamp));

function renderArm() {
  if (S.armLifted) return;
  if (S.paused || !S.track) { setArm(ARM.rest); return; }
  const f = Math.max(0, Math.min(1, curPos() / S.dur));
  setArm(ARM_OUT + (ARM_IN - ARM_OUT) * f);
}
function renderPlaying() {
  document.body.classList.toggle('playing', !S.paused && !!S.track);
  spinTarget = (!S.paused && S.track) ? 1 : 0;
  $('playIcon').setAttribute('d', S.paused ? 'M8 5v14l11-7z' : 'M7 5h4v14H7zm6 0h4v14h-4z');
  renderArm();
  if (!S.paused) requestWakeLock();
}
function showTrack(t) {
  const np = $('nowplaying'); np.style.opacity = 0;
  setTimeout(() => {
    $('title').textContent = t ? t.name : 'Vinyl Deco Player';
    $('artist').textContent = t ? t.artist : 'Tap the record to begin';
    np.style.opacity = 1;
  }, 350);
  const img = $('art');
  if (t && t.art) { img.crossOrigin = 'anonymous'; img.onload = () => ambientFrom(img); img.src = t.art; }
}
function ambientFrom(img) { // tint the room with the album's dominant colour
  try {
    const c = document.createElement('canvas'); c.width = c.height = 8;
    const x = c.getContext('2d'); x.drawImage(img, 0, 0, 8, 8);
    const d = x.getImageData(0, 0, 8, 8).data; let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { const m = Math.max(d[i], d[i + 1], d[i + 2]); if (m > 40) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; } }
    if (n) { document.documentElement.style.setProperty('--amb', [r, g, b].map(v => Math.min(255, Math.round(v / n * 1.25))).join(',')); }
  } catch { /* cross-origin image: keep the warm default */ }
}
function onState(s) {
  if (!s || !s.track_window.current_track) return;
  const t = s.track_window.current_track;
  const track = { id: t.id || t.uri, name: t.name, artist: t.artists.map(a => a.name).join(', '), art: (t.album.images[0] || {}).url };
  const changed = !S.track || S.track.id !== track.id;
  S.paused = s.paused; S.pos = s.position; S.dur = s.duration || 1; S.stamp = Date.now();
  if (changed) {
    const had = !!S.track; S.track = track; showTrack(track);
    if (had && !s.paused) { S.armLifted = true; setArm(ARM.rest); setTimeout(() => { S.armLifted = false; renderArm(); }, 1500); }
  }
  $('bShuffle').classList.toggle('on', !!s.shuffle);
  renderPlaying();
}
setInterval(renderArm, 1000);

/* ---------- actions ---------- */
async function playContext(uri) {
  if (!S.deviceId) return toast('Player is still starting, try again in a moment');
  try {
    await S.player.activateElement();
    await api('/me/player/play?device_id=' + S.deviceId, { method: 'PUT', body: JSON.stringify({ context_uri: uri }) });
    store.set('last', uri);
  } catch (e) { toast(e.message); }
}
async function togglePlay() {
  if (DEMO) { S.paused = !S.paused; S.stamp = Date.now(); renderPlaying(); return; }
  if (!S.player) return;
  if (!store.get('auth')) return showConnect();
  if (S.track) { await S.player.activateElement(); return S.player.togglePlay(); }
  const last = store.get('last');
  if (last) playContext(last); else openSheet();
}
const next = () => !DEMO && S.player && S.player.nextTrack();
const prev = () => !DEMO && S.player && S.player.previousTrack();

async function openSheet() {
  $('sheet').classList.remove('hidden'); hideControlsSoon(true);
  if ($('lists').dataset.loaded) return;
  try {
    const d = await api('/me/playlists?limit=50');
    $('lists').innerHTML = '';
    (d.items || []).filter(Boolean).forEach(p => {
      const c = document.createElement('button'); c.className = 'card'; c.style.cssText = 'width:auto;height:auto;border-radius:8px;display:block';
      const im = (p.images && p.images[0]) ? `<img src="${p.images[0].url}" alt="">` : '<div class="ph"></div>';
      c.innerHTML = im + `<div class="n"></div><div class="s"></div>`;
      c.querySelector('.n').textContent = p.name;
      c.querySelector('.s').textContent = (p.items && p.items.total || p.tracks && p.tracks.total || '') + ' tracks';
      c.onclick = () => { $('sheet').classList.add('hidden'); playContext(p.uri); };
      $('lists').appendChild(c);
    });
    $('lists').dataset.loaded = 1;
    if (!(d.items || []).length) $('lists').textContent = 'No playlists found.';
  } catch (e) { toast(e.message); }
}

/* ---------- controls: tap background to show, tap record to play, swipe for next/prev ---------- */
let hideTimer;
function showControls() { $('controls').classList.remove('hidden'); document.body.classList.add('ctl'); hideControlsSoon(); }
function hideControlsSoon(now) { clearTimeout(hideTimer); hideTimer = setTimeout(() => { $('controls').classList.add('hidden'); document.body.classList.remove('ctl'); }, now ? 0 : 6000); }
$('stage').addEventListener('click', e => {
  if (e.target.closest('#record, #label, #platter')) { togglePlay(); showControls(); }
  else if ($('controls').classList.contains('hidden')) showControls(); else hideControlsSoon(true);
});
let sx = 0, sy = 0;
$('stage').addEventListener('touchstart', e => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
$('stage').addEventListener('touchend', e => {
  const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
  if (Math.abs(dx) > 70 && Math.abs(dy) < 60) { dx < 0 ? next() : prev(); showControls(); }
}, { passive: true });
$('controls').addEventListener('pointerdown', () => { clearTimeout(hideTimer); hideControlsSoon(); });
$('bPlay').onclick = togglePlay; $('bNext').onclick = next; $('bPrev').onclick = prev;
$('bPlaylists').onclick = openSheet; $('sheetClose').onclick = () => $('sheet').classList.add('hidden');
$('bShuffle').onclick = async () => {
  const on = !$('bShuffle').classList.contains('on');
  try { await api('/me/player/shuffle?state=' + on + '&device_id=' + S.deviceId, { method: 'PUT' }); $('bShuffle').classList.toggle('on', on); } catch (e) { toast(e.message); }
};
$('bNight').onclick = () => { document.body.classList.toggle('night'); $('bNight').classList.toggle('on', document.body.classList.contains('night')); store.set('night', document.body.classList.contains('night')); };
if (store.get('night')) { document.body.classList.add('night'); $('bNight').classList.add('on'); }
if (IS_IOS) $('vol').style.display = 'none'; // iOS ignores web volume; use the iPad volume buttons
$('vol').value = store.get('vol') ?? 70;
$('vol').oninput = e => { store.set('vol', +e.target.value); S.player && S.player.setVolume(e.target.value / 100); };

/* keep the screen awake while a record is playing */
let wake = null;
async function requestWakeLock() { try { if ('wakeLock' in navigator && !wake) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => wake = null); } } catch { /* not allowed */ } }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !S.paused) requestWakeLock(); });
document.addEventListener('keydown', e => { if (e.code === 'Space') { e.preventDefault(); togglePlay(); } if (e.code === 'ArrowRight') next(); if (e.code === 'ArrowLeft') prev(); });

/* ---------- start-up ---------- */
function showConnect() { $('connect').classList.remove('hidden'); }
$('bConnect').onclick = login;

function startPlayer() {
  const p = new Spotify.Player({ name: 'Vinyl Deco Player', volume: (store.get('vol') ?? 70) / 100,
    getOAuthToken: cb => getToken().then(cb).catch(e => toast(e.message)) });
  S.player = p;
  p.addListener('ready', ({ device_id }) => { S.deviceId = device_id; });
  p.addListener('not_ready', () => { S.deviceId = null; });
  p.addListener('player_state_changed', onState);
  p.addListener('initialization_error', e => toast('Player: ' + e.message));
  p.addListener('authentication_error', e => { toast('Login problem: ' + e.message); store.del('auth'); showConnect(); });
  p.addListener('account_error', () => toast('Spotify Premium is required to play music here'));
  p.addListener('playback_error', e => toast('Playback: ' + e.message));
  p.connect();
}

async function init() {
  setArm(ARM.rest); showTrack(null);
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

function demo() { // ?demo=1 : preview without Spotify
  const art = 'data:image/svg+xml;utf8,' + encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' width='300' height='300'><defs><linearGradient id='g' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#f6c37a'/><stop offset='.55' stop-color='#d9783c'/><stop offset='1' stop-color='#3a2a3f'/></linearGradient></defs><rect width='300' height='300' fill='url(#g)'/><circle cx='150' cy='150' r='58' fill='#ffe3a8'/><rect y='190' width='300' height='110' fill='#2a1d2c'/></svg>");
  S.track = { id: 'demo', name: 'Golden Hour', artist: 'Demo Artist', art }; S.dur = 200000; S.pos = 40000; S.stamp = Date.now(); S.paused = new URLSearchParams(location.search).get('demo') === 'paused';
  $('art').src = art; $('art').onload = () => ambientFrom($('art')); showTrack(S.track); renderPlaying(); showControls();
}
init();
