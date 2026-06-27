/* ═══════════════════════════════════════════════════════════════
   WayTrace GPS Challenge – Main Application
   ═══════════════════════════════════════════════════════════════ */

'use strict';

// ── Config ────────────────────────────────────────────────────────
const CONFIG = {
  API_BASE:      'https://gpstracking.kirkjlemon.workers.dev',
  MSAL_CLIENT_ID:'7af8d815-6146-4043-8676-a18109541812',
  MSAL_AUTHORITY: 'https://login.microsoftonline.com/5e2fefd4-3b55-4277-9cdd-fccaddf13fe2',
  MSAL_REDIRECT: 'https://kirkjl.github.io/WayTrace/index.html',
  SCOPES:        ['openid','profile','email','offline_access'],
  DEV_MODE:      false,
  //DEV_MODE: location.hostname === 'localhost' || location.hostname === '127.0.0.1',
};

// ── MSAL ──────────────────────────────────────────────────────────
let msalApp = null;
let currentAccount = null;

function initMsal() {
  if (typeof msal === 'undefined') { console.warn('MSAL not loaded – dev mode only'); return null; }
  return new msal.PublicClientApplication({
    auth: { clientId: CONFIG.MSAL_CLIENT_ID, authority: CONFIG.MSAL_AUTHORITY, redirectUri: CONFIG.MSAL_REDIRECT },
    cache: { cacheLocation: 'sessionStorage' },
  });
}

async function getAccessToken() {
  if (CONFIG.DEV_MODE) return buildDevToken();
  if (!msalApp) throw new Error('MSAL not initialised');
  const accounts = msalApp.getAllAccounts();
  if (!accounts.length) throw new Error('Not signed in');
  const result = await msalApp.acquireTokenSilent({ scopes: CONFIG.SCOPES, account: accounts[0] })
    .catch(async () => msalApp.acquireTokenPopup({ scopes: CONFIG.SCOPES }));
  return result.idToken;
}

function buildDevToken() {
  const header  = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const payload = btoa(JSON.stringify({ sub: 'dev-user-001', oid: 'dev-user-001', email: 'dev@localhost', name: 'Dev User', dev: true, exp: Math.floor(Date.now()/1000)+3600 }));
  return `${header}.${payload}.devtoken`;
}

// ── API ───────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const token = await getAccessToken();
  const res = await fetch(`${CONFIG.API_BASE}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, ...(opts.headers || {}) },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!res.ok) {
    const e = new Error(body?.error || `HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return body;
}

// ── State ─────────────────────────────────────────────────────────
const state = {
  tracking: false, paused: false, watchId: null, points: [],
  wakeLock: null, startTime: null, pausedMs: 0, pauseStart: null,
  elapsedTimer: null, map: null, userMarker: null, latestPoint: null,
  currentView: 'track', userData: null, lbPeriod: 'weekly', lbCategory: 'distance',
};

const $ = id => document.getElementById(id);

// ── Utilities ─────────────────────────────────────────────────────
function fmtTime(totalSec) {
  const h = Math.floor(totalSec/3600), m = Math.floor((totalSec%3600)/60), s = Math.floor(totalSec%60);
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}
function fmtPace(secPerKm) {
  if (!secPerKm || secPerKm === Infinity) return '--:--';
  return `${Math.floor(secPerKm/60)}:${String(Math.floor(secPerKm%60)).padStart(2,'0')}`;
}
function fmtDist(m) { return m < 1000 ? `${Math.round(m)}m` : `${(m/1000).toFixed(2)}km`; }
function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000, toRad = d => d*Math.PI/180;
  const dLat = toRad(lat2-lat1), dLng = toRad(lng2-lng1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLng/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}
function totalDistance(points) {
  let d = 0;
  for (let i = 1; i < points.length; i++) d += haversineMeters(points[i-1].lat, points[i-1].lng, points[i].lat, points[i].lng);
  return d;
}
function elapsedSec() {
  if (!state.startTime) return 0;
  return (Date.now() - state.startTime) / 1000 - state.pausedMs / 1000;
}
function pence2str(p) { return (p/100).toFixed(2); }
function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function relativeTime(unixSec) {
  const d = Math.floor(Date.now()/1000) - unixSec;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d/60)}m ago`;
  if (d < 86400) return `${Math.floor(d/3600)}h ago`;
  return `${Math.floor(d/86400)}d ago`;
}

// ── Toast ─────────────────────────────────────────────────────────
function toast(msg, type = '', duration = 3500) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('toastContainer').appendChild(el);
  setTimeout(() => el.remove(), duration);
}

// ── Modal ─────────────────────────────────────────────────────────
function showModal(title, bodyHtml, actions = []) {
  $('modalTitle').textContent = title;
  $('modalBody').innerHTML = bodyHtml;
  const actEl = $('modalActions');
  actEl.innerHTML = '';
  actions.forEach(({ label, cls, cb }) => {
    const btn = document.createElement('button');
    btn.className = cls || 'btn-secondary btn-sm';
    btn.textContent = label;
    btn.addEventListener('click', () => { hideModal(); cb?.(); });
    actEl.appendChild(btn);
  });
  $('modalBackdrop').hidden = false;
}
function hideModal() { $('modalBackdrop').hidden = true; }
$('modalBackdrop').addEventListener('click', e => { if (e.target === $('modalBackdrop')) hideModal(); });

// ── Views ─────────────────────────────────────────────────────────
function showView(name) {
  document.querySelectorAll('.view').forEach(v => { v.hidden = true; v.classList.remove('active'); });
  const view = document.getElementById(`view${name.charAt(0).toUpperCase()+name.slice(1)}`);
  if (view) { view.hidden = false; view.classList.add('active'); }
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  state.currentView = name;
  if (name === 'stats') loadStats();
  if (name === 'leaderboard') loadLeaderboard();
  if (name === 'social') loadSocial();
  if (name === 'profile') renderProfile();
  if (name === 'sponsor') loadSponsorView();
  if (name === 'track') { setTimeout(() => state.map?.resize(), 50); loadChallengeStrip(); }
}
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => showView(btn.dataset.view));
});

// ── Wake Lock ─────────────────────────────────────────────────────
async function requestWakeLock() {
  try { if (!('wakeLock' in navigator)) return; state.wakeLock = await navigator.wakeLock.request('screen'); $('wakeLockBadge').classList.add('active'); } catch {}
}
async function releaseWakeLock() {
  try { await state.wakeLock?.release(); } catch {}
  state.wakeLock = null; $('wakeLockBadge').classList.remove('active');
}
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && state.tracking && !state.paused) await requestWakeLock();
});

// ── Map ───────────────────────────────────────────────────────────
function initMap() {
  state.map = new maplibregl.Map({
    container: 'map',
    style: { version: 8, sources: { osm: { type: 'raster', tiles: ['https://a.tile.openstreetmap.org/{z}/{x}/{y}.png','https://b.tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256 } }, layers: [{ id: 'osm', type: 'raster', source: 'osm' }] },
    center: [-0.1276, 51.5072], zoom: 13, attributionControl: false,
  });
  state.map.addControl(new maplibregl.NavigationControl({ showZoom: true, showCompass: false }), 'bottom-right');
  window.addEventListener('resize', () => state.map?.resize());
  setTimeout(() => state.map?.resize(), 100);
  setTimeout(() => state.map?.resize(), 500);
  state.map.on('load', () => {
    $('btnStart').disabled = false;
    state.map.addSource('route', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } } });
    state.map.addLayer({ id: 'route-line', type: 'line', source: 'route', paint: { 'line-width': 4, 'line-opacity': 0.9, 'line-color': '#4ade80' } });
    centerOnUserLocation();
  });
}
function centerOnUserLocation() {
  if (!('geolocation' in navigator)) return;
  navigator.geolocation.getCurrentPosition(
    pos => state.map?.jumpTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: 14 }),
    () => {},
    { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 }
  );
}
function updateRouteOnMap() {
  if (!state.map?.getSource('route')) return;
  state.map.getSource('route').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: state.points.map(p => [p.lng, p.lat]) } });
}
function centerMap() {
  if (!state.latestPoint || !state.map) return;
  state.map.easeTo({ center: [state.latestPoint.lng, state.latestPoint.lat], zoom: Math.max(state.map.getZoom(), 15) });
}

// ── GPS ───────────────────────────────────────────────────────────
function onPosition(pos) {
  const c = pos.coords;
  const p = { lat: c.latitude, lng: c.longitude, acc: c.accuracy, spd: c.speed ?? null, alt: c.altitude ?? null, t: pos.timestamp };
  if (state.paused) return;
  const firstFix = !state.latestPoint;
  state.latestPoint = p;
  updateUserMarker(p);
  if (firstFix) centerMap();
  if (p.acc <= 80) { state.points.push(p); updateRouteOnMap(); updateHudMetrics(); }
  updateGpsBadge(p.acc, p.acc < 20 ? 'high' : p.acc <= 80 ? 'med' : 'low');
}
function updateGpsBadge(acc, quality) {
  $('gpsBadge').classList.toggle('active', quality !== 'low');
  $('hudSub').textContent = `GPS ±${Math.round(acc)}m · ${state.points.length} pts`;
}
function updateUserMarker(p) {
  if (!state.map) return;
  if (!state.userMarker) {
    const el = document.createElement('div'); el.className = 'user-marker';
    const dot = document.createElement('div'); dot.className = 'user-marker-dot';
    const acc = document.createElement('div'); acc.className = 'user-acc-circle';
    el.appendChild(acc); el.appendChild(dot);
    state.userMarker = new maplibregl.Marker(el).setLngLat([p.lng, p.lat]).addTo(state.map);
  } else { state.userMarker.setLngLat([p.lng, p.lat]); }
  try {
    const accEl = state.userMarker.getElement().querySelector('.user-acc-circle');
    if (accEl) {
      const deg = (p.acc||30)/111320, p1 = state.map.project([p.lng,p.lat]), p2 = state.map.project([p.lng+deg,p.lat]);
      const px = Math.max(20, Math.abs(p2.x-p1.x)*2);
      accEl.style.width = accEl.style.height = px+'px';
    }
  } catch {}
}

// ── Tracking ──────────────────────────────────────────────────────
async function startTracking() {
  if (!('geolocation' in navigator)) { toast('Geolocation not supported', 'error'); return; }
  state.points = []; state.startTime = Date.now(); state.pausedMs = 0; state.tracking = true; state.paused = false;
  await requestWakeLock();
  state.watchId = navigator.geolocation.watchPosition(onPosition, err => { $('hudSub').textContent = `GPS error: ${err.message}`; }, { enableHighAccuracy: $('hiAcc').checked, maximumAge: 3000, timeout: 15000 });
  state.elapsedTimer = setInterval(updateHudMetrics, 1000);
  setTrackState('tracking'); $('hudTitle').textContent = 'Tracking…'; saveDraft();
}
function pauseTracking() {
  state.paused = true; state.pauseStart = Date.now(); releaseWakeLock(); clearInterval(state.elapsedTimer);
  setTrackState('paused'); $('hudTitle').textContent = 'Paused'; toast('Paused – screen can now sleep','',2000);
}
function resumeTracking() {
  state.paused = false; state.pausedMs += Date.now()-(state.pauseStart||Date.now()); state.pauseStart = null;
  requestWakeLock(); state.elapsedTimer = setInterval(updateHudMetrics,1000);
  setTrackState('tracking'); $('hudTitle').textContent = 'Tracking…';
}
async function finishTracking() {
  if (state.watchId !== null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null; clearInterval(state.elapsedTimer); await releaseWakeLock();
  state.tracking = false; state.paused = false; setTrackState('idle'); $('hudTitle').textContent = 'Activity Saved';
  if (state.points.length < 2) { toast('Not enough GPS points to save','error'); clearDraft(); return; }
  await submitActivity();
}
function setTrackState(s) {
  const show = (id, vis) => { const el=$(id); if(el){el.hidden=!vis; el.disabled=!vis;} };
  show('btnStart', s==='idle'); show('btnPause', s==='tracking'); show('btnResume', s==='paused');
  show('btnFinish', s==='tracking'||s==='paused');
  $('actType').disabled = s!=='idle'; $('hiAcc').disabled = s!=='idle';
  if (s==='idle') $('btnExportGpx').disabled = state.points.length===0;
}
function updateHudMetrics() {
  const dist = totalDistance(state.points), sec = elapsedSec(), distKm = dist/1000;
  const pace = dist > 50 && sec > 0 ? sec/distKm : null;
  const cal = Math.round(($('actType').value==='run'?0.9:0.6)*distKm*70);
  $('metricDist').textContent = distKm.toFixed(2); $('metricTime').textContent = fmtTime(sec);
  $('metricPace').textContent = pace ? fmtPace(pace) : '--:--'; $('metricCal').textContent = cal;
}

// ── Submit Activity ───────────────────────────────────────────────
async function submitActivity() {
  const type = $('actType').value, startTime = state.startTime, endTime = Date.now(), points = state.points;
  $('syncBadge').classList.add('active');
  try {
    const result = await api('/activities', { method: 'POST', body: JSON.stringify({ type, startTime, endTime, points }) });
    clearDraft(); $('syncBadge').classList.remove('active');
    showFinishModal(result, type, points);
    if (result.stepsAdded > 0) { loadNotifBadge(); if (state.currentView==='sponsor') loadMyChallenges(); }
  } catch (e) {
    $('syncBadge').classList.remove('active');
    // A 4xx (other than rate-limiting) means the server actively rejected this
    // activity – e.g. anti-cheat, duplicate, too short. Retrying won't help,
    // so surface it instead of silently stuffing it in the offline queue
    // forever. Network failures / 5xx / 429 are transient – queue those.
    const isHardRejection = e.status >= 400 && e.status < 500 && e.status !== 429;
    if (isHardRejection) {
      clearDraft();
      showModal('Activity Not Saved', escHtml(e.message || 'This activity could not be saved.'), [{ label: 'OK', cls: 'btn-primary btn-sm' }]);
    } else {
      queueOfflineActivity({ type, startTime, endTime, points });
      toast('Saved offline – will sync when connected','error');
    }
  }
}
function showFinishModal(result, type, points) {
  const dist = totalDistance(points), sec = elapsedSec();
  let body = `<div class="finish-stat"><span>Distance</span><span class="finish-val">${fmtDist(dist)}</span></div>
<div class="finish-stat"><span>Duration</span><span class="finish-val">${fmtTime(sec)}</span></div>
<div class="finish-stat"><span>XP Earned</span><span class="finish-val text-gold">+${result.activity?.xpAwarded||0} XP</span></div>
<div class="finish-stat"><span>Streak</span><span class="finish-val">🔥 ${result.streak||0} days</span></div>`;
  if (result.newPersonalBests?.length) { body += `<div class="finish-rewards"><div class="small muted" style="margin-bottom:4px">New Personal Bests!</div>`; result.newPersonalBests.forEach(pb => { body += `<span class="reward-badge">🏆 ${pb.replace(/_/g,' ')}</span>`; }); body += '</div>'; }
  if (result.newAchievements?.length) { body += `<div class="finish-rewards"><div class="small muted" style="margin-bottom:4px">Achievements!</div>`; result.newAchievements.forEach(a => { body += `<span class="reward-badge">🎖 ${a.replace(/_/g,' ')}</span>`; }); body += '</div>'; }
  if (result.completedChallenges?.length) { body += `<div class="finish-rewards"><div class="small muted" style="margin-bottom:4px">Challenges completed!</div>`; result.completedChallenges.forEach(c => { body += `<span class="reward-badge" style="border-color:var(--green);color:var(--green)">✓ ${c.label}</span>`; }); body += '</div>'; }
  showModal(`${type==='run'?'🏃':'🚶'} Activity Saved!`, body, [{ label: 'Close', cls: 'btn-primary btn-sm', cb: () => { loadStats(); loadChallengeStrip(); } }]);
  toast(`+${result.activity?.xpAwarded||0} XP earned!`,'gold',4000);
}

// ── Button wiring ─────────────────────────────────────────────────
$('btnStart')?.addEventListener('click', startTracking);
$('btnPause')?.addEventListener('click', pauseTracking);
$('btnResume')?.addEventListener('click', resumeTracking);
$('btnFinish')?.addEventListener('click', () => showModal('Finish Activity?','Save and upload this activity?',[{ label:'Finish',cls:'btn-primary btn-sm',cb:finishTracking },{ label:'Cancel',cls:'btn-secondary btn-sm' }]));
$('btnCenter')?.addEventListener('click', centerMap);
$('btnExportGpx')?.addEventListener('click', exportGpx);

// ── Stats View ────────────────────────────────────────────────────
async function loadStats() {
  try {
    const [data, ach, acts] = await Promise.all([api('/stats'), api('/achievements'), api('/activities?limit=10')]);
    renderStats(data.stats, data.pbs, ach, acts);
  } catch { toast('Failed to load stats','error'); }
}
function computeLevelProgress(lifetimeXp) {
  let xp = lifetimeXp, level = 1;
  while (xp >= level*250) { xp -= level*250; level++; }
  const needed = level*250;
  return { level, current: xp, needed, pct: Math.min(100,(xp/needed)*100) };
}
function renderStats(stats, pbs, achievements, activities) {
  if (!stats) return;
  const lp = computeLevelProgress(stats.lifetime_xp||0);
  $('statLevel').textContent = lp.level; $('statXp').textContent = (stats.lifetime_xp||0).toLocaleString();
  $('xpBarFill').style.width = lp.pct+'%'; $('xpToNext').textContent = (lp.needed-lp.current).toLocaleString();
  const distKm = ((stats.lifetime_distance||0)/1000).toFixed(1), durHr = Math.floor((stats.lifetime_duration||0)/3600);
  $('statsGrid').innerHTML = [
    { val:distKm, lbl:'km total' },{ val:durHr, lbl:'hours active' },{ val:stats.total_activities||0, lbl:'activities' },
    { val:`${stats.current_streak||0}🔥`, lbl:'day streak' },{ val:stats.walk_count||0, lbl:'walks' },{ val:stats.run_count||0, lbl:'runs' },
  ].map(s => `<div class="stat-card"><div class="stat-val">${s.val}</div><div class="stat-lbl">${s.lbl}</div></div>`).join('');
  if (pbs) {
    const pbItems = [
      { key:'fastest_1k',lbl:'Fastest 1km',fmt:v=>fmtTime(v) },{ key:'fastest_mile',lbl:'Fastest Mile',fmt:v=>fmtTime(v) },
      { key:'fastest_5k',lbl:'Fastest 5km',fmt:v=>fmtTime(v) },{ key:'fastest_10k',lbl:'Fastest 10km',fmt:v=>fmtTime(v) },
      { key:'longest_walk',lbl:'Longest Walk',fmt:v=>fmtDist(v) },{ key:'longest_run',lbl:'Longest Run',fmt:v=>fmtDist(v) },
      { key:'best_avg_speed',lbl:'Best Speed',fmt:v=>v.toFixed(1)+' km/h' },{ key:'longest_duration',lbl:'Longest Session',fmt:v=>fmtTime(v) },
    ].filter(i=>pbs[i.key]!=null);
    $('pbList').innerHTML = pbItems.map(i=>`<div class="pb-row"><span class="pb-name">${i.lbl}</span><span class="pb-val">${i.fmt(pbs[i.key])}</span></div>`).join('') || '<p class="small muted" style="padding:8px 0">No personal bests yet – get moving!</p>';
  }
  if (achievements) $('achGrid').innerHTML = achievements.map(a=>`<div class="ach-card ${a.earned_at?'earned':''}" title="${a.description}"><div class="ach-icon">${a.icon}</div><div class="ach-name">${a.name}</div></div>`).join('');
  if (activities) $('actList').innerHTML = activities.map(a=>{
    const d = new Date(a.start_time), dateStr = d.toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'});
    return `<div class="act-card"><div class="act-type-icon">${a.type==='run'?'🏃':'🚶'}</div><div class="act-info"><div class="act-title">${a.type==='run'?'Run':'Walk'} · ${fmtDist(a.distance)}</div><div class="act-meta">${dateStr} · ${fmtTime(a.duration)} · ${fmtPace(a.avg_pace)}/km</div></div><div class="act-xp">+${a.xp_awarded} XP</div></div>`;
  }).join('') || '<p class="small muted" style="padding:8px 0">No activities yet.</p>';
}

// ── Leaderboard ───────────────────────────────────────────────────
async function loadLeaderboard() {
  try { renderLeaderboard(await api(`/leaderboard?period=${state.lbPeriod}&category=${state.lbCategory}`)); }
  catch { toast('Failed to load leaderboard','error'); }
}
function renderLeaderboard(rows) {
  $('lbList').innerHTML = rows.map((r,i)=>{
    const rank=i+1, rankCls=rank===1?'gold':rank===2?'silver':rank===3?'bronze':'';
    const val = state.lbCategory==='distance' ? r.value?.toFixed(1)+' km' : state.lbCategory==='duration' ? Math.round(r.value)+' min' : Math.round(r.value)+' '+(state.lbCategory==='xp'?'XP':'acts');
    return `<div class="lb-row"><div class="lb-rank ${rankCls}">#${rank}</div><div class="avatar-sm">${(r.display_name||'?')[0].toUpperCase()}</div><div class="lb-name">${r.display_name||'Unknown'}</div><div class="lb-val">${val}</div></div>`;
  }).join('') || '<p class="small muted" style="padding:16px">No data yet for this period.</p>';
}
document.querySelectorAll('#lbPeriod .pill').forEach(p => p.addEventListener('click', () => { document.querySelectorAll('#lbPeriod .pill').forEach(x=>x.classList.remove('active')); p.classList.add('active'); state.lbPeriod=p.dataset.val; loadLeaderboard(); }));
document.querySelectorAll('#lbCategory .pill').forEach(p => p.addEventListener('click', () => { document.querySelectorAll('#lbCategory .pill').forEach(x=>x.classList.remove('active')); p.classList.add('active'); state.lbCategory=p.dataset.val; loadLeaderboard(); }));

// ── Social ────────────────────────────────────────────────────────
async function loadSocial() { loadFriends(); loadClubs(); loadChallengeList(); }
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tabName = btn.dataset.tab; if (!tabName) return;
    btn.closest('.tab-bar').querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active')); btn.classList.add('active');
    const panel = btn.closest('.view-scroll') || btn.closest('.view');
    panel.querySelectorAll('.tab-content').forEach(c=>c.hidden=true);
    const target = document.getElementById(`tab${tabName.charAt(0).toUpperCase()+tabName.slice(1)}`);
    if (target) target.hidden = false;
  });
});
async function loadFriends() {
  try { const data = await api('/friends'); renderFriends(data.friends, data.pendingRequests); } catch {}
}
function renderFriends(friends, pending) {
  $('pendingRequests').innerHTML = (pending||[]).map(p=>`<div class="person-card"><div class="avatar-sm">${(p.display_name||'?')[0].toUpperCase()}</div><div class="person-info"><div class="person-name">${p.display_name}</div></div><div class="person-actions"><button class="btn-primary btn-sm" onclick="acceptFriend('${p.id}')">Accept</button><button class="btn-secondary btn-sm" onclick="rejectFriend('${p.id}')">Reject</button></div></div>`).join('') || '<p class="small muted">No pending requests.</p>';
  $('friendList').innerHTML = (friends||[]).map(f=>`<div class="person-card"><div class="avatar-sm">${(f.display_name||'?')[0].toUpperCase()}</div><div class="person-info"><div class="person-name">${f.display_name}</div><div class="person-meta">Level ${f.current_level||1} · ${((f.lifetime_distance||0)/1000).toFixed(1)} km</div></div></div>`).join('') || '<p class="small muted">Add friends to compare stats!</p>';
}
window.acceptFriend = async id => { try { await api('/friends/accept',{method:'POST',body:JSON.stringify({fromUserId:id})}); loadFriends(); toast('Friend accepted!','success'); } catch(e){toast(e.message,'error');} };
window.rejectFriend = async id => { try { await api('/friends/reject',{method:'POST',body:JSON.stringify({fromUserId:id})}); loadFriends(); } catch {} };
$('btnFriendSearch').addEventListener('click', async () => {
  const q = $('friendSearch').value.trim(); if (!q) return;
  try {
    const results = await api(`/users/search?q=${encodeURIComponent(q)}`);
    $('friendSearchResults').innerHTML = results.map(u=>`<div class="person-card"><div class="avatar-sm">${(u.display_name||'?')[0].toUpperCase()}</div><div class="person-info"><div class="person-name">${u.display_name}</div></div><button class="btn-secondary btn-sm" onclick="sendFriendRequest('${u.id}')">Add</button></div>`).join('') || '<p class="small muted">No users found.</p>';
  } catch(e){toast(e.message,'error');}
});
window.sendFriendRequest = async id => { try { await api('/friends/request',{method:'POST',body:JSON.stringify({toUserId:id})}); toast('Friend request sent!','success'); } catch(e){toast(e.message,'error');} };
async function loadClubs() {
  try {
    const clubs = await api('/clubs');
    $('clubList').innerHTML = clubs.map(c=>{
      const isOwner = c.role === 'owner';
      const ownerActions = isOwner
        ? `<button class="btn-secondary btn-sm" onclick="openTransferOwnership('${c.id}','${escHtml(c.name)}')">Transfer Ownership</button><button class="btn-danger btn-sm" onclick="confirmDeleteClub('${c.id}','${escHtml(c.name)}')">Delete Club</button>`
        : `<button class="btn-secondary btn-sm" onclick="confirmLeaveClub('${c.id}','${escHtml(c.name)}')">Leave</button>`;
      return `<div class="club-card"><div class="club-name">${escHtml(c.name)}</div><div class="club-meta">${c.member_count} members · ${c.role}</div><div class="club-meta">Invite: <span class="club-code">${c.invite_code}</span></div><div class="club-actions" style="margin-top:6px"><button class="btn-secondary btn-sm" onclick="viewClubLeaderboard('${c.id}','${escHtml(c.name)}')">Leaderboard</button>${ownerActions}</div></div>`;
    }).join('') || '<p class="small muted">You haven\'t joined any clubs yet.</p>';
  } catch {}
}
window.viewClubLeaderboard = async (clubId, name) => {
  try { const rows = await api(`/clubs/${clubId}/leaderboard`); showModal(`${name} – Club Leaderboard`, rows.map((r,i)=>`<div class="finish-stat"><span>#${i+1} ${r.display_name}</span><span class="finish-val text-gold">${((r.lifetime_distance||0)/1000).toFixed(1)} km</span></div>`).join('') || 'No data', [{label:'Close',cls:'btn-secondary btn-sm'}]); } catch(e){toast(e.message,'error');}
};
window.confirmLeaveClub = (clubId, name) => {
  showModal('Leave Club?', `Leave "${escHtml(name)}"? You can rejoin later with the invite code.`, [
    { label: 'Leave', cls: 'btn-danger btn-sm', cb: async () => {
      try { await api('/clubs/leave', { method: 'POST', body: JSON.stringify({ clubId }) }); toast('Left club', 'success'); loadClubs(); }
      catch (e) { toast(e.message, 'error'); }
    } },
    { label: 'Cancel', cls: 'btn-secondary btn-sm' },
  ]);
};
window.confirmDeleteClub = (clubId, name) => {
  showModal('Delete Club?', `This permanently deletes "${escHtml(name)}" and removes all its members. This cannot be undone.`, [
    { label: 'Delete', cls: 'btn-danger btn-sm', cb: async () => {
      try { await api(`/clubs/${clubId}/delete`, { method: 'POST' }); toast('Club deleted', 'success'); loadClubs(); }
      catch (e) { toast(e.message, 'error'); }
    } },
    { label: 'Cancel', cls: 'btn-secondary btn-sm' },
  ]);
};
window.openTransferOwnership = async (clubId, name) => {
  try {
    const members = (await api(`/clubs/${clubId}/leaderboard`)).filter(m => m.id !== state.userData?.user?.id);
    if (!members.length) { toast('No other members to transfer ownership to', 'error'); return; }
    const body = `<p class="small muted" style="margin-bottom:10px">Pick the new owner of "${escHtml(name)}". You'll become an admin.</p>` +
      members.map(m => `<div class="person-card"><div class="avatar-sm">${(m.display_name||'?')[0].toUpperCase()}</div><div class="person-info"><div class="person-name">${escHtml(m.display_name)}</div></div><button class="btn-primary btn-sm" onclick="transferClubOwnership('${clubId}','${m.id}','${escHtml(m.display_name)}')">Make Owner</button></div>`).join('');
    showModal('Transfer Ownership', body, [{ label: 'Cancel', cls: 'btn-secondary btn-sm' }]);
  } catch (e) { toast(e.message, 'error'); }
};
window.transferClubOwnership = async (clubId, newOwnerId, newOwnerName) => {
  hideModal();
  try {
    await api(`/clubs/${clubId}/transfer-ownership`, { method: 'POST', body: JSON.stringify({ newOwnerId }) });
    toast(`${newOwnerName} is now the owner`, 'success');
    loadClubs();
  } catch (e) { toast(e.message, 'error'); }
};
$('btnCreateClub').addEventListener('click', () => showModal('Create Club','<input id="clubNameInput" class="input-field" placeholder="Club name" style="width:100%;margin-bottom:8px"><input id="clubDescInput" class="input-field" placeholder="Description (optional)" style="width:100%">',[{label:'Create',cls:'btn-primary btn-sm',cb:async()=>{const name=$('clubNameInput')?.value?.trim(),desc=$('clubDescInput')?.value?.trim();if(!name){toast('Name required','error');return;}try{const r=await api('/clubs',{method:'POST',body:JSON.stringify({name,description:desc})});toast(`Club created! Code: ${r.inviteCode}`,'success',5000);loadClubs();}catch(e){toast(e.message,'error');}}},{label:'Cancel',cls:'btn-secondary btn-sm'}]));
$('btnJoinClub').addEventListener('click', () => showModal('Join Club','<input id="inviteCodeInput" class="input-field" placeholder="Invite code" style="width:100%;text-transform:uppercase">',[{label:'Join',cls:'btn-primary btn-sm',cb:async()=>{const code=$('inviteCodeInput')?.value?.trim();if(!code)return;try{await api('/clubs/join',{method:'POST',body:JSON.stringify({inviteCode:code})});toast('Joined club!','success');loadClubs();}catch(e){toast(e.message,'error');}}},{label:'Cancel',cls:'btn-secondary btn-sm'}]));
async function loadChallengeList() {
  try { const challenges=await api('/challenges'); $('challengeList').innerHTML=challenges.map(c=>`<div class="challenge-card ${c.completed_at?'done':''}"><div><div class="challenge-label">${c.label}</div><div class="challenge-xp">+${c.xp_reward} XP</div></div>${c.completed_at?'<div class="challenge-tick">✓</div>':''}</div>`).join('')||'<p class="small muted">No challenges today.</p>'; } catch {}
}
async function loadChallengeStrip() {
  try { const cs=await api('/challenges'),strip=$('challengeStrip'); if(!cs?.length){strip.hidden=true;return;} strip.innerHTML=cs.map(c=>`<div class="challenge-chip ${c.completed_at?'done':''}">${c.completed_at?'✓ ':''}${c.label}</div>`).join(''); strip.hidden=false; } catch { $('challengeStrip').hidden=true; }
}

// ── Profile ───────────────────────────────────────────────────────
function renderProfile() {
  const d = state.userData; if (!d) return;
  const { user, stats } = d;
  $('profileAvatar').textContent = (user?.display_name||'?')[0].toUpperCase();
  if (user?.avatar_url) { const img=document.createElement('img'); img.src=user.avatar_url; img.alt=''; $('profileAvatar').textContent=''; $('profileAvatar').appendChild(img); }
  $('profileName').textContent = user?.display_name||'Unknown';
  $('profileJoin').textContent = user?.join_date ? `Joined ${new Date(user.join_date*1000).toLocaleDateString('en-GB',{month:'long',year:'numeric'})}` : '';
  const lp = computeLevelProgress(stats?.lifetime_xp||0);
  $('profileLevel').textContent = lp.level; $('profileStreak').textContent = stats?.current_streak||0;
}
$('btnSignOut').addEventListener('click', async () => {
  if (msalApp) { const a=msalApp.getAllAccounts(); if(a[0]) await msalApp.logoutPopup({account:a[0]}).catch(()=>{}); }
  showAuth();
});

// ── Avatar upload ────────────────────────────────────────────────
function resizeImageFile(file, maxSize = 256, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Could not decode image'));
      img.onload = () => {
        const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
$('profileAvatar')?.addEventListener('click', () => $('avatarFileInput').click());
$('avatarFileInput')?.addEventListener('change', async () => {
  const file = $('avatarFileInput').files[0];
  $('avatarFileInput').value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) { toast('Please choose an image file', 'error'); return; }
  try {
    const avatarDataUrl = await resizeImageFile(file);
    const result = await api('/profile/avatar', { method: 'POST', body: JSON.stringify({ avatarDataUrl }) });
    if (state.userData?.user) state.userData.user.avatar_url = result.avatarUrl;
    renderProfile();
    toast('Profile photo updated', 'success');
  } catch (e) { toast(e.message || 'Failed to update photo', 'error'); }
});

// ── GPX Export ────────────────────────────────────────────────────
function exportGpx() {
  if (!state.points.length) return;
  let gpx = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="WayTrace">\n<trk><name>${$('actType').value}</name><trkseg>`;
  state.points.forEach(p => { gpx += `<trkpt lat="${p.lat}" lon="${p.lng}"><time>${new Date(p.t).toISOString()}</time>${p.alt!=null?`<ele>${p.alt.toFixed(1)}</ele>`:''}</trkpt>`; });
  gpx += '</trkseg></trk></gpx>';
  const blob = new Blob([gpx],{type:'application/gpx+xml'}), url=URL.createObjectURL(blob), a=document.createElement('a');
  a.href=url; a.download='activity.gpx'; a.click(); URL.revokeObjectURL(url);
}

// ── Offline Draft ─────────────────────────────────────────────────
function saveDraft() { try { localStorage.setItem('wt_draft',JSON.stringify({type:$('actType').value,startTime:state.startTime,points:state.points})); } catch {} }
function clearDraft() { localStorage.removeItem('wt_draft'); }
function recoverDraft() {
  try {
    const raw=localStorage.getItem('wt_draft'); if(!raw) return;
    const d=JSON.parse(raw); if(!d.points?.length) return;
    showModal('Recover Activity?',`Found an unsaved activity from ${new Date(d.startTime).toLocaleString()} with ${d.points.length} GPS points.`,[
      {label:'Recover',cls:'btn-primary btn-sm',cb:async()=>{state.points=d.points;state.startTime=d.startTime;$('actType').value=d.type;updateRouteOnMap();updateHudMetrics();setTrackState('paused');$('hudTitle').textContent='Recovered';clearDraft();}},
      {label:'Discard',cls:'btn-danger btn-sm',cb:clearDraft},
    ]);
  } catch {}
}
function queueOfflineActivity(activity) { try { const q=JSON.parse(localStorage.getItem('wt_queue')||'[]'); q.push(activity); localStorage.setItem('wt_queue',JSON.stringify(q)); } catch {} }
async function syncOfflineQueue() {
  try {
    const q=JSON.parse(localStorage.getItem('wt_queue')||'[]'); if(!q.length) return;
    const failed=[]; let rejectedCount=0;
    for (const act of q) {
      try { await api('/activities',{method:'POST',body:JSON.stringify(act)}); }
      catch (e) {
        // A hard rejection (anti-cheat, duplicate, etc.) will never succeed on
        // retry – drop it instead of retrying forever on every reconnect.
        const isHardRejection = e.status >= 400 && e.status < 500 && e.status !== 429;
        if (isHardRejection) rejectedCount++; else failed.push(act);
      }
    }
    localStorage.setItem('wt_queue',JSON.stringify(failed));
    const synced = q.length - failed.length - rejectedCount;
    if (synced > 0) toast(`Synced ${synced} queued activities!`,'success');
    if (rejectedCount > 0) toast(`${rejectedCount} queued activit${rejectedCount===1?'y':'ies'} could not be saved and ${rejectedCount===1?'was':'were'} discarded`,'error',5000);
  } catch {}
}

// ── Offline bar ───────────────────────────────────────────────────
const offlineBar = document.createElement('div'); offlineBar.id='offlineBar'; offlineBar.textContent='⚠️ Offline – activities will sync when reconnected'; document.body.prepend(offlineBar);
window.addEventListener('offline', ()=>document.body.classList.add('offline'));
window.addEventListener('online', ()=>{ document.body.classList.remove('offline'); syncOfflineQueue(); });
if (!navigator.onLine) document.body.classList.add('offline');

// ── Auth Flow ─────────────────────────────────────────────────────
function showAuth() { document.getElementById('screenAuth').classList.add('active'); document.getElementById('screenAuth').style.display=''; document.getElementById('screenApp').hidden=true; document.getElementById('screenApp').classList.remove('active'); }
function showApp()  { document.getElementById('screenAuth').classList.remove('active'); document.getElementById('screenAuth').style.display='none'; document.getElementById('screenApp').hidden=false; document.getElementById('screenApp').classList.add('active'); }

async function handleSignIn() {
  const errEl=$('authError'); errEl.hidden=true; $('btnSignIn').disabled=true;
  try {
    if (CONFIG.DEV_MODE) { const me=await api('/auth/me'); state.userData=me; showApp(); initMap(); showView('track'); recoverDraft(); syncOfflineQueue(); return; }
    if (!msalApp) throw new Error('MSAL failed to load');
    const result=await msalApp.loginPopup({scopes:CONFIG.SCOPES}); currentAccount=result.account;
    const me=await api('/auth/me'); state.userData=me; showApp(); initMap(); showView('track'); recoverDraft(); syncOfflineQueue();
  } catch(e) { errEl.textContent=e.message||'Sign in failed'; errEl.hidden=false; }
  finally { $('btnSignIn').disabled=false; }
}
document.addEventListener('DOMContentLoaded', () => {
  window.addEventListener('load', () => {
  document.getElementById('btnSignIn').addEventListener('click', handleSignIn);
});
});

// ── Beta access request ──────────────────────────────────────────
$('btnRequestAccess')?.addEventListener('click', () => {
  showModal('Request Access', `
    <p class="small muted" style="margin-bottom:10px">WayTrace is invite-only right now. Tell us a bit about yourself and we'll be in touch.</p>
    <input id="reqName" class="input-field" placeholder="Your name" style="width:100%;margin-bottom:8px">
    <input id="reqEmail" type="email" class="input-field" placeholder="Email address" style="width:100%;margin-bottom:8px">
    <textarea id="reqMessage" class="input-field" placeholder="Why are you interested? (optional)" style="width:100%;min-height:70px;resize:vertical"></textarea>
  `, [
    { label: 'Send Request', cls: 'btn-primary btn-sm', cb: submitAccountRequest },
    { label: 'Cancel', cls: 'btn-secondary btn-sm' },
  ]);
});
async function submitAccountRequest() {
  const name = $('reqName')?.value?.trim();
  const email = $('reqEmail')?.value?.trim();
  const message = $('reqMessage')?.value?.trim();
  if (!name) { toast('Name is required', 'error'); return; }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast('A valid email is required', 'error'); return; }
  try {
    // Deliberately not using api() – there's no token yet, this must work signed-out.
    const res = await fetch(`${CONFIG.API_BASE}/account-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, message }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    toast("Request received – we'll be in touch!", 'success', 5000);
  } catch (e) {
    toast(e.message || 'Failed to send request', 'error');
  }
}

// ── Boot ──────────────────────────────────────────────────────────
async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(()=>{});
  msalApp = initMsal();
  if (msalApp) {
    try { await msalApp.initialize(); } catch {}
  }
  // Always show auth screen on load — never auto-login
  document.getElementById('screenAuth').style.display='flex';
  $('btnSignIn').disabled = false;
}
boot();

/* ═══════════════════════════════════════════════════════════════
   Sponsorship Feature – Step Challenges
   ═══════════════════════════════════════════════════════════════ */

const spState = {
  selectedWalkerId: null, selectedWalkerName: null,
  charities: [], currentLbCat: 'earnings',
  countdownInterval: null,
};

function formatCountdown(secs) {
  if (secs <= 0) return '⏰ Expired';
  const d=Math.floor(secs/86400), h=Math.floor((secs%86400)/3600), m=Math.floor((secs%3600)/60), s=secs%60;
  if (d > 0) return `⏱ ${d}d ${h}h remaining`;
  if (h > 0) return `⏱ ${h}h ${m}m remaining`;
  return `⏱ ${m}m ${String(s).padStart(2,'0')}s remaining`;
}

// ── Countdown ticker ──────────────────────────────────────────────
function startCountdownTick() {
  if (spState.countdownInterval) clearInterval(spState.countdownInterval);
  spState.countdownInterval = setInterval(() => {
    if (state.currentView !== 'sponsor') return;
    document.querySelectorAll('[data-deadline]').forEach(el => {
      const secsLeft = Math.max(0, parseInt(el.dataset.deadline) - Math.floor(Date.now()/1000));
      el.textContent = formatCountdown(secsLeft);
      el.classList.toggle('urgent', secsLeft < 3600);
      el.classList.toggle('warning', secsLeft >= 3600 && secsLeft < 21600);
    });
  }, 1000);
}

// ── Load sponsor view ─────────────────────────────────────────────
async function loadSponsorView() {
  loadMyChallenges();
  loadNotifBadge();
  startCountdownTick();
}

// ── Sponsor sub-tab switching ─────────────────────────────────────
document.querySelectorAll('[data-stab]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-stab]').forEach(b=>b.classList.remove('active')); btn.classList.add('active');
    const tab = btn.dataset.stab;
    ['stabMyChallenges','stabSponsorSomeone','stabSpLeaderboard','stabNotifications'].forEach(id=>{ const el=document.getElementById(id); if(el) el.hidden=true; });
    const tId = 'stab'+tab.split('-').map(w=>w[0].toUpperCase()+w.slice(1)).join('');
    const el = document.getElementById(tId); if (el) el.hidden=false;
    if (tab==='my-challenges') loadMyChallenges();
    if (tab==='sponsor-someone') loadSponsorForm();
    if (tab==='sp-leaderboard') loadSpLeaderboard();
    if (tab==='notifications') loadNotifications();
  });
});

// ── My Challenges ─────────────────────────────────────────────────
async function loadMyChallenges() {
  try {
    const [walkerChs, sponsorChs, meStats] = await Promise.all([
      api('/sponsored-challenges?role=walker'),
      api('/sponsored-challenges?role=sponsor'),
      api('/sponsor-stats/me'),
    ]);
    const challenges = [...walkerChs.map(c=>({...c,role:'walker'})), ...sponsorChs.map(c=>({...c,role:'sponsor'}))];
    const ws = meStats.walkerStats||{};
    $('wbPot').textContent    = '£'+pence2str(ws.current_pot_pence||0);
    $('wbEarned').textContent = '£'+pence2str(ws.lifetime_earnings_pence||0);
    $('wbCharity').textContent= '£'+pence2str(ws.charity_raised_pence||0);
    $('wbSteps').textContent  = (meStats.steps||0).toLocaleString();
    $('walkerBanner').hidden  = false;
    const pending   = challenges.filter(c=>c.status==='pending'&&c.role==='walker');
    const active    = challenges.filter(c=>c.status==='active');
    const completed = challenges.filter(c=>['completed','paid'].includes(c.status));
    const asSponsor = challenges.filter(c=>c.role==='sponsor');
    $('activeChallengesList').innerHTML   = [...pending,...active].map(c=>renderChallengeCard(c)).join('')   || '<p class="small muted" style="padding:8px 0">No active challenges.</p>';
    $('completedChallengesList').innerHTML= completed.map(c=>renderChallengeCard(c)).join('')                || '<p class="small muted" style="padding:8px 0">No completed challenges yet.</p>';
    $('sponsoredByMeList').innerHTML      = asSponsor.map(c=>renderChallengeCard(c,true)).join('')           || '<p class="small muted" style="padding:8px 0">You haven\'t sponsored anyone yet.</p>';
    document.querySelectorAll('[data-accept-id]').forEach(btn=>btn.addEventListener('click',()=>acceptChallenge(btn.dataset.acceptId)));
  } catch(e) { toast('Failed to load challenges','error'); }
}

function renderChallengeCard(c, asSponsor=false) {
  const isActive=c.status==='active', isDone=['completed','paid'].includes(c.status), isExpired=['expired','refunded','donated_to_charity','cancelled'].includes(c.status), isPending=c.status==='pending';
  const cardClass=isActive?'active-card':isDone?'done-card':isExpired?'expired-card':'';
  const badgeClass=isActive?'active':isDone?'done':isExpired?'expired':'';
  const statusLabel={pending:'Pending',active:'Active',completed:'✓ Completed',expired:'Expired',refunded:'Refunded',donated_to_charity:'Donated',cancelled:'Cancelled',paid:'Paid'}[c.status]||c.status;
  const gross=pence2str(c.gross_amount_pence);
  const walkerPayout=c.walker_payout_pence?pence2str(c.walker_payout_pence):pence2str(c.gross_amount_pence-Math.max(c.gross_amount_pence*0.1,100));
  let progressHTML='';
  if (isActive&&c.start_steps!=null) {
    const progress=Math.max(0,(c.current_steps||c.start_steps)-c.start_steps), pct=Math.min(100,(progress/c.steps_required)*100), secsLeft=Math.max(0,(c.deadline||0)-Math.floor(Date.now()/1000));
    progressHTML=`<div class="sc-progress-wrap"><div class="sc-progress-bar"><div class="sc-progress-fill ${pct>=100?'done':''}" style="width:${pct.toFixed(1)}%"></div></div></div><div class="sc-steps-row"><span>Progress: <span class="sc-steps-current">${progress.toLocaleString()}</span> / ${c.steps_required.toLocaleString()} steps</span><span>${pct.toFixed(1)}%</span></div><div class="sc-countdown ${secsLeft<3600?'urgent':secsLeft<21600?'warning':''}" data-deadline="${c.deadline}">${formatCountdown(secsLeft)}</div>`;
  }
  let footerHTML='';
  if (isDone) footerHTML=`<div class="sc-footer"><span>Walker earned</span><span class="sc-payout">£${walkerPayout}</span></div>`;
  else if (isActive) footerHTML=`<div class="sc-footer"><span class="sc-failure-note">${c.failure_action==='charity'?'🏥 Fails → charity':'↩ Fails → refund'}</span><span class="sc-payout">Pot: £${gross}</span></div>`;
  else if (isExpired) footerHTML=`<div class="sc-footer"><span>${c.status==='donated_to_charity'?'🏥 Donated to charity':'↩ Refunded to sponsor'}</span><span>£${gross}</span></div>`;
  const messageHTML=c.message?`<div class="sc-message">"${escHtml(c.message)}"</div>`:'';
  const roleLabel=asSponsor?`→ ${escHtml(c.walker_name||'Walker')}` : `← ${escHtml(c.sponsor_name||'Sponsor')}`;
  const acceptBtn=isPending&&!asSponsor?`<div class="sc-actions"><button class="btn-primary btn-sm btn-full" data-accept-id="${c.id}">Accept Challenge</button></div>`:'';
  return `<div class="sc-card ${cardClass}"><div class="sc-header"><div><div class="sc-amount ${isExpired?'expired':''}">£${gross}</div><div class="small muted">${(c.steps_required||0).toLocaleString()} steps · ${roleLabel}</div></div><span class="sc-status-badge ${badgeClass}">${statusLabel}</span></div>${messageHTML}${progressHTML}${footerHTML}${acceptBtn}</div>`;
}

async function acceptChallenge(challengeId) {
  try {
    await api(`/sponsored-challenges/${challengeId}/accept`,{method:'POST'});
    const burst=document.createElement('div'); burst.className='completion-burst'; burst.innerHTML='<div class="burst-icon">🤝</div>'; document.body.appendChild(burst); setTimeout(()=>burst.remove(),1200);
    toast('Challenge accepted! Timer started.','success',4000); loadMyChallenges();
  } catch(e) { toast(e.message,'error'); }
}

// ── Sponsor form ──────────────────────────────────────────────────
async function loadSponsorForm() {
  try {
    spState.charities = await api('/charities');
    $('spCharity').innerHTML = spState.charities.map(c=>`<option value="${c.id}">${escHtml(c.name)}</option>`).join('');
  } catch {}
  spState.selectedWalkerId=null; spState.selectedWalkerName=null;
  $('spSelectedWalker').hidden=true; $('spWalkerResults').innerHTML='';
  $('spAmount').value=''; $('spSteps').value=''; $('spMessage').value='';
  $('spFeePreview').textContent=''; $('spTimerPreview').textContent=''; updateCreateBtn();
}

$('btnSpWalkerSearch')?.addEventListener('click', async () => {
  const q=$('spWalkerSearch').value.trim(); if(!q) return;
  try {
    const results=await api(`/users/search?q=${encodeURIComponent(q)}`);
    $('spWalkerResults').innerHTML=results.map(u=>`<div class="person-card" style="cursor:pointer" data-uid="${u.id}" data-name="${escHtml(u.display_name)}"><div class="avatar-sm">${(u.display_name||'?')[0].toUpperCase()}</div><div class="person-info"><div class="person-name">${escHtml(u.display_name)}</div></div><button class="btn-secondary btn-sm">Select</button></div>`).join('')||'<p class="small muted">No users found.</p>';
    $('spWalkerResults').querySelectorAll('.person-card').forEach(card=>{
      card.addEventListener('click',()=>{
        spState.selectedWalkerId=card.dataset.uid; spState.selectedWalkerName=card.dataset.name;
        $('spSelectedWalker').hidden=false;
        $('spSelectedWalker').innerHTML=`<div class="avatar-sm">${spState.selectedWalkerName[0].toUpperCase()}</div><div class="person-info"><div class="person-name">${escHtml(spState.selectedWalkerName)}</div></div><button class="btn-secondary btn-sm" id="btnClearWalker">✕</button>`;
        $('btnClearWalker').addEventListener('click',()=>{ spState.selectedWalkerId=null; $('spSelectedWalker').hidden=true; updateCreateBtn(); });
        $('spWalkerResults').innerHTML=''; updateCreateBtn();
      });
    });
  } catch(e){toast(e.message,'error');}
});

['spAmount','spSteps'].forEach(id=>{ $(id)?.addEventListener('input', updateSponsorPreviews); });
function updateSponsorPreviews() {
  const grossPence=Math.round((parseFloat($('spAmount').value)||0)*100), steps=parseInt($('spSteps').value)||0;
  if (grossPence>=100) { const pf=Math.max(100,Math.round(grossPence*0.02)),sf=Math.max(Math.round(grossPence*0.1),100),wg=grossPence-sf,tc=grossPence+pf; $('spFeePreview').innerHTML=`Processing fee: <strong>£${pence2str(pf)}</strong> · You pay: <strong>£${pence2str(tc)}</strong> · Walker gets: <strong>£${pence2str(wg)}</strong>`; } else { $('spFeePreview').textContent=''; }
  if (steps>=100) { const h=steps/500,d=Math.floor(h/24),hr=Math.floor(h%24); $('spTimerPreview').textContent=`Timer: ${d>0?d+'d '+hr+'h':hr+'h'} (500 steps/hour)`; } else { $('spTimerPreview').textContent=''; }
  updateCreateBtn();
}
document.querySelectorAll('input[name="spFailure"]').forEach(r=>r.addEventListener('change',()=>{ $('spCharityGroup').hidden=document.querySelector('input[name="spFailure"]:checked')?.value!=='charity'; updateCreateBtn(); }));
function updateCreateBtn() {
  const amount=parseFloat($('spAmount').value)||0, steps=parseInt($('spSteps').value)||0;
  const isCharity=document.querySelector('input[name="spFailure"]:checked')?.value==='charity';
  $('btnCreateChallenge').disabled=!(spState.selectedWalkerId&&amount>=1&&steps>=100&&(!isCharity||!!$('spCharity')?.value));
}

$('btnCreateChallenge')?.addEventListener('click', async () => {
  const grossAmountPence=Math.round((parseFloat($('spAmount').value)||0)*100), stepsRequired=parseInt($('spSteps').value)||0;
  const failureAction=document.querySelector('input[name="spFailure"]:checked')?.value||'refund';
  const charityId=failureAction==='charity'?$('spCharity').value:null, message=$('spMessage').value.trim();
  const pf=Math.max(100,Math.round(grossAmountPence*0.02)), tc=grossAmountPence+pf;
  showModal('Confirm Sponsorship',`<div class="finish-stat"><span>Walker</span><span class="finish-val">${escHtml(spState.selectedWalkerName)}</span></div><div class="finish-stat"><span>Challenge pot</span><span class="finish-val">£${pence2str(grossAmountPence)}</span></div><div class="finish-stat"><span>Processing fee</span><span class="finish-val">£${pence2str(pf)}</span></div><div class="finish-stat"><span>Total charged</span><span class="finish-val text-gold">£${pence2str(tc)}</span></div><div class="finish-stat"><span>Steps required</span><span class="finish-val">${stepsRequired.toLocaleString()}</span></div><div class="finish-stat"><span>If failed</span><span class="finish-val">${failureAction==='charity'?'Donate to charity':'Refund'}</span></div><p class="small muted" style="margin-top:8px">Processing fee is non-refundable.</p>`,[
    {label:'Confirm & Pay',cls:'btn-primary btn-sm',cb:async()=>{
      try { $('btnCreateChallenge').disabled=true; const r=await api('/sponsored-challenges',{method:'POST',body:JSON.stringify({walkerId:spState.selectedWalkerId,grossAmountPence,stepsRequired,failureAction,charityId,message})}); toast(`Challenge sent! Walker has ${r.durationHours?.toFixed(1)}h to complete.`,'success',5000); loadSponsorForm(); loadMyChallenges(); document.querySelector('[data-stab="my-challenges"]')?.click(); } catch(e){toast(e.message,'error');} finally{$('btnCreateChallenge').disabled=false;}
    }},
    {label:'Cancel',cls:'btn-secondary btn-sm'},
  ]);
});

// ── Sponsorship leaderboard ───────────────────────────────────────
document.querySelectorAll('#spLbCat .pill').forEach(p=>p.addEventListener('click',()=>{ document.querySelectorAll('#spLbCat .pill').forEach(x=>x.classList.remove('active')); p.classList.add('active'); spState.currentLbCat=p.dataset.val; loadSpLeaderboard(); }));
async function loadSpLeaderboard() {
  try { const rows=await api(`/sponsored-leaderboard?category=${spState.currentLbCat}`); renderSpLeaderboard(rows); } catch(e){toast('Failed to load leaderboard','error');}
}
function renderSpLeaderboard(rows) {
  const cat=spState.currentLbCat, fv=v=>['earnings','charity','largest','top_sponsors'].includes(cat)?'£'+pence2str(v):cat==='completion_rate'?v+'%':cat==='steps'?parseInt(v).toLocaleString()+' steps':parseInt(v).toLocaleString();
  $('spLbList').innerHTML=rows.map((r,i)=>{ const rank=i+1,rc=rank===1?'gold':rank===2?'silver':rank===3?'bronze':''; return `<div class="lb-row"><div class="lb-rank ${rc}">#${rank}</div><div class="avatar-sm">${(r.display_name||'?')[0].toUpperCase()}</div><div class="lb-name">${escHtml(r.display_name||'Unknown')}</div><div class="lb-val">${fv(r.value)}</div></div>`; }).join('')||'<p class="small muted" style="padding:16px">No data yet.</p>';
}

// ── Notifications ─────────────────────────────────────────────────
async function loadNotifications() {
  try {
    const notifs=await api('/notifications');
    $('notifList').innerHTML=notifs.map(n=>`<div class="notif-card ${n.read?'':'unread'}"><div class="notif-title">${escHtml(n.title)}</div><div class="notif-body">${escHtml(n.body)}</div><div class="notif-time">${relativeTime(n.created_at)}</div></div>`).join('')||'<p class="small muted" style="padding:8px 0">No notifications.</p>';
    $('btnNotifRead').hidden=!notifs.some(n=>!n.read);
  } catch {}
}
$('btnNotifRead')?.addEventListener('click', async()=>{ try{await api('/notifications/read-all',{method:'POST'});loadNotifications();$('notifBadge').hidden=true;}catch{} });
async function loadNotifBadge() {
  try { const n=await api('/notifications'),u=n.filter(x=>!x.read).length,badge=$('notifBadge'); if(u>0){badge.textContent=u>9?'9+':u;badge.hidden=false;}else{badge.hidden=true;} } catch {}
}

// ── Poll notifications every 60s ──────────────────────────────────
setInterval(()=>{ if(state.userData) loadNotifBadge(); }, 60000);
