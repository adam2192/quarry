/* QUARRY client. One file, no build step — this is meant to be readable
   and hackable by whoever ends up hosting it for their friend group. */

(() => {
  'use strict';

  // ------------------------------------------------------------- session
  const store = {
    get: () => {
      try { return JSON.parse(localStorage.getItem('quarry') || '{}'); }
      catch { return {}; }
    },
    set: (patch) => {
      const cur = store.get();
      localStorage.setItem('quarry', JSON.stringify({ ...cur, ...patch }));
    },
  };

  const els = (id) => document.getElementById(id);
  const screens = {
    landing: els('screen-landing'),
    lobby: els('screen-lobby'),
    game: els('screen-game'),
  };
  function showScreen(name) {
    Object.entries(screens).forEach(([k, el]) => el.classList.toggle('hidden', k !== name));
  }

  function toast(msg) {
    const stack = els('toast-stack');
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    stack.appendChild(t);
    setTimeout(() => t.remove(), 4200);
  }

  // ------------------------------------------------------------------- ws
  let ws = null;
  let wsReady = false;
  let reconnectDelay = 800;
  let clockOffset = 0; // serverNow - Date.now()
  let state = null;    // last full room view from server
  let you = null;

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);

    ws.onopen = () => {
      wsReady = true;
      reconnectDelay = 800;
      const saved = store.get();
      if (saved.code && saved.playerId) {
        send({ type: 'join', code: saved.code, playerId: saved.playerId, name: saved.name });
      }
    };

    ws.onclose = () => {
      wsReady = false;
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.6, 8000);
    };

    ws.onerror = () => ws.close();

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handleMessage(msg);
    };
  }

  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  function handleMessage(msg) {
    if (msg.type === 'joined') {
      store.set({ code: msg.code, playerId: msg.playerId });
      return;
    }
    if (msg.type === 'error') {
      if (screens.landing.classList.contains('hidden')) toast(msg.msg);
      else showLandingError(msg.msg);
      return;
    }
    if (msg.type === 'state') {
      clockOffset = msg.serverNow - Date.now();
      const prevStatus = state && state.room.status;
      const prevReveal = state && state.room.lastReveal && state.room.lastReveal.at;
      state = msg;
      you = msg.you;
      render(prevStatus, prevReveal);
    }
  }

  function serverNow() { return Date.now() + clockOffset; }

  // -------------------------------------------------------------- landing
  let landingMode = 'join';
  const nameInput = els('name-input');
  const codeInput = els('code-input');

  els('tab-join').onclick = () => setLandingMode('join');
  els('tab-create').onclick = () => setLandingMode('create');
  function setLandingMode(mode) {
    landingMode = mode;
    els('tab-join').classList.toggle('active', mode === 'join');
    els('tab-create').classList.toggle('active', mode === 'create');
    els('join-fields').classList.toggle('hidden', mode !== 'join');
    els('create-fields').classList.toggle('hidden', mode !== 'create');
    showLandingError('');
  }
  function showLandingError(msg) { els('landing-error').textContent = msg || ''; }

  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  });

  els('btn-create').onclick = () => {
    const name = nameInput.value.trim();
    if (!name) return showLandingError('Enter a name first.');
    store.set({ name });
    send({ type: 'create', name });
  };

  els('btn-join').onclick = () => {
    const name = nameInput.value.trim();
    const code = codeInput.value.trim();
    if (!name) return showLandingError('Enter a name first.');
    if (code.length !== 4) return showLandingError('Room codes are 4 letters.');
    store.set({ name });
    send({ type: 'join', code, name });
  };

  (function restoreName() {
    const saved = store.get();
    if (saved.name) nameInput.value = saved.name;
  })();

  // ---------------------------------------------------------------- lobby

  function renderLobby() {
    const { room } = state;
    els('lobby-code').textContent = room.code;
    els('lobby-you').textContent = you.isHost ? `${you.name} · host` : you.name;

    const players = room.players;
    els('roster-count').textContent = players.length;

    els('roster').innerHTML = players.map((p) => {
      const isHost = p.isHost;
      const canManage = you.isHost && !isHost;
      return `
        <div class="roster-row">
          <div class="who">
            <span>${p.connected ? '' : '· '}${escapeHtml(p.name)}${p.isYou ? ' (you)' : ''}</span>
            ${isHost ? '<span class="host-star">HOST</span>' : ''}
          </div>
          <div class="actions">
            ${canManage ? `
              <div class="role-switch">
                <button data-role-btn="hunter" data-pid="${p.id}" class="${p.role === 'hunter' ? 'on hunter' : ''}">Hunter</button>
                <button data-role-btn="prey" data-pid="${p.id}" class="${p.role === 'prey' ? 'on prey' : ''}">Prey</button>
              </div>
              <button class="icon-btn" data-kick="${p.id}" title="Remove">✕</button>
            ` : `
              <span class="pill role-${p.role}"><span class="dot"></span>${p.role}</span>
            `}
          </div>
        </div>`;
    }).join('');

    els('roster').querySelectorAll('[data-role-btn]').forEach((btn) => {
      btn.onclick = () => send({ type: 'setRole', playerId: btn.dataset.pid, role: btn.dataset.roleBtn });
    });
    els('roster').querySelectorAll('[data-kick]').forEach((btn) => {
      btn.onclick = () => send({ type: 'kick', playerId: btn.dataset.kick });
    });

    // shuffle control (host only)
    els('shuffle-wrap').innerHTML = you.isHost
      ? `<button class="btn btn-ghost btn-sm" id="btn-shuffle">Shuffle roles</button>` : '';
    if (you.isHost) {
      els('btn-shuffle').onclick = () => {
        const hunterCount = Math.max(1, Math.round(players.length / 4));
        send({ type: 'shuffle', hunterCount });
      };
    }

    // settings (host editable, others read-only summary)
    const s = room.settings;
    els('host-settings-wrap').innerHTML = you.isHost ? settingsFormHtml(s) : settingsSummaryHtml(s);
    if (you.isHost) wireSettingsForm(s);

    // actions
    const hunters = players.filter((p) => p.role === 'hunter').length;
    const prey = players.filter((p) => p.role === 'prey').length;
    if (you.isHost) {
      const canStart = hunters > 0 && prey > 0;
      els('lobby-actions').innerHTML = `
        <button class="btn btn-primary btn-block" id="btn-start" ${canStart ? '' : 'disabled'}>
          ${canStart ? 'Start the hunt' : 'Need 1+ hunter and 1+ prey'}
        </button>`;
      els('btn-start').onclick = () => send({ type: 'start' });
    } else {
      els('lobby-actions').innerHTML = `<div class="locked-note">Waiting on the host to start the hunt…</div>`;
    }
  }

  function settingsSummaryHtml(s) {
    return `
      <div class="section-title">How it's set up</div>
      <div class="locked-note">
        Once pinging starts: reveal every ${fmtMinSec(s.preyRevealSec)} (prey) / ${fmtMinSec(s.hunterRevealSec)} (hunters) ·
        no time limit — the host ends it manually
      </div>`;
  }

  function settingsFormHtml(s) {
    return `
      <div class="section-title">Hunt settings</div>
      <div class="settings-grid">
        <div class="field">
          <label>Prey ping every</label>
          <div class="stepper" data-stepper="preyRevealSec" data-step="30" data-min="15" data-max="3600">
            <button data-dir="-1">−</button><div class="val">${fmtMinSec(s.preyRevealSec)}</div><button data-dir="1">+</button>
          </div>
        </div>
        <div class="field">
          <label>Hunter ping every</label>
          <div class="stepper" data-stepper="hunterRevealSec" data-step="30" data-min="15" data-max="3600">
            <button data-dir="-1">−</button><div class="val">${fmtMinSec(s.hunterRevealSec)}</div><button data-dir="1">+</button>
          </div>
        </div>
        <div class="field full">
          <label>When a hunter logs a catch</label>
          <div class="segmented" data-segmented="onCatch">
            <button data-val="convert" class="${s.onCatch === 'convert' ? 'on' : ''}">Flips</button>
            <button data-val="swap" class="${s.onCatch === 'swap' ? 'on' : ''}">Swaps</button>
            <button data-val="eliminate" class="${s.onCatch === 'eliminate' ? 'on' : ''}">Out</button>
          </div>
        </div>
        <div class="field full">
          <div class="toggle-row">
            <div>
              <div class="label">Reveal everyone on a catch</div>
              <div class="sub">Logging a catch pings the whole map immediately, not just the usual timer</div>
            </div>
            <label class="switch">
              <input type="checkbox" id="toggle-revealOnCatch" ${s.revealOnCatch ? 'checked' : ''} />
              <span class="track"></span>
            </label>
          </div>
        </div>
      </div>
      <div class="locked-note">No time limit — pinging starts when you send the first ping in-game, and the hunt runs until you end it.</div>`;
  }

  function wireSettingsForm(s) {
    document.querySelectorAll('[data-stepper]').forEach((el) => {
      const key = el.dataset.stepper;
      const step = Number(el.dataset.step);
      const min = Number(el.dataset.min);
      const max = Number(el.dataset.max);
      el.querySelectorAll('button').forEach((btn) => {
        btn.onclick = () => {
          const dir = Number(btn.dataset.dir);
          const next = Math.max(min, Math.min(max, s[key] + dir * step));
          send({ type: 'settings', settings: { [key]: next } });
        };
      });
    });
    document.querySelectorAll('[data-segmented]').forEach((el) => {
      const key = el.dataset.segmented;
      el.querySelectorAll('button').forEach((btn) => {
        btn.onclick = () => send({ type: 'settings', settings: { [key]: btn.dataset.val } });
      });
    });
    const rc = els('toggle-revealOnCatch');
    if (rc) rc.onchange = () => send({ type: 'settings', settings: { revealOnCatch: rc.checked } });
  }

  function fmtMinSec(sec) {
    if (sec % 60 === 0) return `${sec / 60}m`;
    if (sec < 60) return `${sec}s`;
    return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  }
  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ----------------------------------------------------------------- game

  let map = null;
  let markers = new Map();   // playerId -> { marker, trail }
  let youMarker = null;
  let followedOnce = false;

  function ensureMap() {
    if (map) return;
    // zoomControl off: on mobile it collided with the HUD chips, and pinch
    // does the job — same call the Google Maps app makes on a phone.
    map = L.map('map', { zoomControl: false, attributionControl: true }).setView([20, 0], 3);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 20,
      subdomains: 'abcd',
      attribution: '&copy; OpenStreetMap &copy; CARTO',
    }).addTo(map);
  }

  function markerIcon(cls, label) {
    return L.divIcon({
      className: '',
      html: `<div class="mk ${cls}">
        <span class="ripple"></span>
        <span class="corner tl"></span><span class="corner tr"></span>
        <span class="corner bl"></span><span class="corner br"></span>
        <span class="core"></span>
        ${label ? `<span class="label">${escapeHtml(label)}</span>` : ''}
      </div>`,
      iconSize: [26, 26],
      iconAnchor: [13, 13],
    });
  }

  function renderGame(prevRevealAt) {
    ensureMap();
    const { room } = state;

    els('game-code').textContent = room.code;
    const badge = els('role-badge');
    badge.className = 'role-badge ' + you.role;
    els('role-badge-text').textContent = you.role.toUpperCase();
    const aliveHunters = room.players.filter((p) => p.role === 'hunter' && p.alive).length;
    const alivePrey = room.players.filter((p) => p.role === 'prey' && p.alive).length;
    els('alive-count').textContent = `${aliveHunters}H / ${alivePrey}P live`;

    renderTimers(room);
    renderLog(room);
    renderBottomBar(room);
    renderMarkers(room, prevRevealAt);

    if (room.status === 'over') renderResult(room);
    else removeOverlay();
  }

  function renderTimers(room) {
    const now = serverNow();
    const wrap = els('timers');
    if (room.status !== 'running') { wrap.innerHTML = ''; return; }

    if (!room.nextPreyReveal && !room.nextHunterReveal) {
      wrap.innerHTML = `
        <div class="timer-card wait">
          <div class="meta">
            <div class="lbl">Standing by</div>
            <div class="clk" style="font-size:13px;">Waiting for the first ping</div>
          </div>
        </div>`;
      return;
    }

    const preyMs = room.nextPreyReveal - now;
    const hunterMs = room.nextHunterReveal - now;
    wrap.innerHTML =
      timerCardHtml('prey', 'Prey ping in', preyMs, room.settings.preyRevealSec * 1000, preyMs < 0) +
      timerCardHtml('hunter', 'Hunter ping in', hunterMs, room.settings.hunterRevealSec * 1000, hunterMs < 0);
  }

  function timerCardHtml(kind, label, msLeft, msTotal, justPinged) {
    const clamped = Math.max(0, msLeft);
    const frac = msTotal ? clamped / msTotal : 0;
    const r = 12;
    const c = 2 * Math.PI * r;
    const offset = c * (1 - frac);
    return `
      <div class="timer-card ${kind} ${justPinged ? 'pinging' : ''}">
        <div class="ring">
          <svg width="30" height="30" viewBox="0 0 30 30">
            <circle class="bg" cx="15" cy="15" r="${r}" fill="none" stroke-width="3"/>
            <circle class="fg" cx="15" cy="15" r="${r}" fill="none" stroke-width="3"
              stroke-dasharray="${c}" stroke-dashoffset="${offset}"/>
          </svg>
        </div>
        <div class="meta">
          <div class="lbl">${label}</div>
          <div class="clk">${fmtClock(clamped)}</div>
        </div>
      </div>`;
  }

  function fmtClock(ms) {
    const s = Math.ceil(ms / 1000);
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, '0')}`;
  }

  function renderLog(room) {
    const body = els('log-body');
    body.innerHTML = room.log.map((l) => `
      <div class="log-line ${l.kind}"><span class="t">${new Date(l.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>${escapeHtml(l.msg)}</div>
    `).join('') || '<div class="log-line">Quiet so far.</div>';
  }
  els('log-toggle').onclick = () => {
    const d = els('log-drawer');
    d.classList.toggle('collapsed');
    els('log-caret').textContent = d.classList.contains('collapsed') ? '▲' : '▼';
  };

  function renderBottomBar(room) {
    const bar = els('bottom-bar');
    const awaitingPing = room.status === 'running' && !room.nextPreyReveal && !room.nextHunterReveal;
    const rows = [];

    if (you.isHost && awaitingPing) {
      rows.push(`
        <button class="tag-btn" id="btn-first-ping">
          Send first ping
          <span class="sub">reveals everyone now &amp; starts the timers</span>
        </button>`);
    }

    if (you.role === 'hunter' && you.alive) {
      rows.push(`
        <button class="tag-btn catch-btn" id="btn-catch" ${room.status !== 'running' ? 'disabled' : ''}>
          Log a catch
          <span class="sub">tap who you caught in person</span>
        </button>`);
    } else if (!you.alive) {
      rows.push(`<div class="waiting-note">You're out — still watching the map.</div>`);
    } else {
      rows.push(`<div class="waiting-note">Stay hidden. Your next ping is on the clock above.</div>`);
    }

    bar.innerHTML = rows.map((r) => `<div class="bar-row">${r}</div>`).join('');

    const pingBtn = els('btn-first-ping');
    if (pingBtn) pingBtn.onclick = () => send({ type: 'revealNow' });
    const catchBtn = els('btn-catch');
    if (catchBtn) catchBtn.onclick = () => openCatchPicker(room);

    if (you.isHost && room.status === 'running') {
      const lastRow = bar.lastElementChild || bar;
      const endBtn = document.createElement('button');
      endBtn.className = 'icon-round';
      endBtn.title = 'End hunt';
      endBtn.textContent = '■';
      endBtn.onclick = () => { if (confirm('End the hunt now?')) send({ type: 'endGame' }); };
      if (bar.firstElementChild) bar.firstElementChild.appendChild(endBtn);
      else bar.appendChild(endBtn);
    }
  }

  function openCatchPicker(room) {
    if (document.getElementById('catch-overlay')) return;
    const prey = room.players.filter((p) => p.role === 'prey' && p.alive);
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.id = 'catch-overlay';
    overlay.innerHTML = `
      <div class="overlay-card catch-card">
        <div class="eyebrow">Log a catch</div>
        <div class="catch-title">Who did you catch?</div>
        <div class="catch-list">
          ${prey.length ? prey.map((p) => `<button class="catch-row" data-pid="${p.id}">${escapeHtml(p.name)}</button>`).join('')
            : '<div class="locked-note">No prey left to catch.</div>'}
        </div>
        <button class="btn btn-ghost btn-block" id="btn-catch-cancel">Cancel</button>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelectorAll('[data-pid]').forEach((btn) => {
      btn.onclick = () => {
        send({ type: 'catch', playerId: btn.dataset.pid });
        if (navigator.vibrate) navigator.vibrate(40);
        overlay.remove();
      };
    });
    document.getElementById('btn-catch-cancel').onclick = () => overlay.remove();
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  }

  function renderMarkers(room, prevRevealAt) {
    const justPinged = room.lastReveal && room.lastReveal.at !== prevRevealAt;
    const seen = new Set();

    for (const p of room.players) {
      if (p.isYou) continue;
      if (!p.shown) continue;
      seen.add(p.id);
      const cls = p.role === 'hunter' ? 'hunter' : 'prey';
      let rec = markers.get(p.id);
      const latlng = [p.shown.lat, p.shown.lng];

      if (!rec) {
        const marker = L.marker(latlng, { icon: markerIcon(cls, p.name) }).addTo(map);
        const trail = L.polyline(p.prevShown ? [[p.prevShown.lat, p.prevShown.lng], latlng] : [latlng], {
          color: p.role === 'hunter' ? '#e8262f' : '#2f8fe6', weight: 2, opacity: 0.4, dashArray: '2,6',
        }).addTo(map);
        rec = { marker, trail, lastAt: p.shown.revealedAt };
        markers.set(p.id, rec);
      } else if (p.shown.revealedAt !== rec.lastAt) {
        rec.marker.setLatLng(latlng);
        rec.marker.setIcon(markerIcon(cls, p.name)); // fresh mount replays the lock-on animation
        if (p.prevShown) rec.trail.setLatLngs([[p.prevShown.lat, p.prevShown.lng], latlng]);
        rec.lastAt = p.shown.revealedAt;
      }
      if (!p.alive) rec.marker.getElement()?.style.setProperty('opacity', '0.4');
    }

    for (const [id, rec] of markers) {
      if (!seen.has(id)) { map.removeLayer(rec.marker); map.removeLayer(rec.trail); markers.delete(id); }
    }

    if (justPinged && navigator.vibrate) navigator.vibrate(15);
  }

  function updateYouMarker(lat, lng) {
    if (!map) return;
    if (!youMarker) {
      youMarker = L.marker([lat, lng], { icon: markerIcon('you', 'You'), zIndexOffset: 1000 }).addTo(map);
    } else {
      youMarker.setLatLng([lat, lng]);
    }
    if (!followedOnce) { map.setView([lat, lng], 16); followedOnce = true; }
  }

  function renderResult(room) {
    let overlay = document.getElementById('result-overlay');
    if (overlay) return; // already up
    const win = room.outcome === 'hunters' ? 'hunters' : room.outcome === 'prey' ? 'prey' : 'ended';
    overlay = document.createElement('div');
    overlay.className = `overlay result-overlay ${win}`;
    overlay.id = 'result-overlay';
    overlay.innerHTML = `
      <div class="overlay-card">
        <div class="eyebrow">Hunt over</div>
        <div class="headline">${win === 'hunters' ? 'Hunters win' : win === 'prey' ? 'Prey win' : 'Called'}</div>
        <div class="sub">${room.log[0] ? escapeHtml(room.log[0].msg) : ''}</div>
        ${you.isHost ? `<button class="btn btn-primary btn-block" id="btn-lobby-return">Back to lobby</button>` : `<div class="locked-note">Waiting for the host…</div>`}
      </div>`;
    document.body.appendChild(overlay);
    if (you.isHost) {
      document.getElementById('btn-lobby-return').onclick = () => send({ type: 'backToLobby' });
    }
  }
  function removeOverlay() {
    const overlay = document.getElementById('result-overlay');
    if (overlay) overlay.remove();
  }

  // ------------------------------------------------------------- geolocation

  let geoStarted = false;
  let lastSentAt = 0;
  function startGeo() {
    if (geoStarted || !navigator.geolocation) return;
    geoStarted = true;
    navigator.geolocation.watchPosition(
      (pos) => {
        els('gps-dot').className = 'dot-live';
        updateYouMarker(pos.coords.latitude, pos.coords.longitude);
        const now = Date.now();
        if (now - lastSentAt < 3000) return;
        lastSentAt = now;
        send({ type: 'loc', lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy });
      },
      (err) => {
        els('gps-dot').className = 'dot-stale';
        toast(err.code === 1 ? 'Location permission is off — turn it on to play.' : 'GPS signal lost.');
      },
      { enableHighAccuracy: true, maximumAge: 4000, timeout: 15000 }
    );
  }

  // Keeps the screen from auto-locking due to inactivity while the hunt is
  // open — that's the single biggest cause of GPS silently going stale,
  // since a locked screen stops location updates just like switching apps
  // does. This can't help if someone deliberately leaves the tab; browsers
  // don't allow websites to track location in the background at all.
  let wakeLock = null;
  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch { /* e.g. low-power mode — nothing to do, not critical */ }
  }
  document.addEventListener('visibilitychange', () => {
    const onGame = !screens.game.classList.contains('hidden');
    if (document.visibilityState === 'visible' && onGame) requestWakeLock();
  });

  // ------------------------------------------------------------------ tick

  setInterval(() => { if (state && state.room.status === 'running') renderTimers(state.room); }, 1000);

  // ---------------------------------------------------------------- render

  function render(prevStatus, prevRevealAt) {
    if (!state) return;
    const { room } = state;

    if (room.status === 'lobby') {
      showScreen('lobby');
      renderLobby();
    } else {
      showScreen('game');
      startGeo();
      requestWakeLock();
      renderGame(prevRevealAt);
    }
  }

  connect();
})();
