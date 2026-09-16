(() => {
  const lobbyEl = document.getElementById('lobby');
  const gameEl = document.getElementById('game');
  const roomListEl = document.getElementById('roomList');
  const nameInput = document.getElementById('nameInput');
  const lobbyError = document.getElementById('lobbyError');
  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  const hudRoom = document.getElementById('hudRoom');
  const hudHealthFill = document.getElementById('hudHealthFill');
  const hudHealthText = document.getElementById('hudHealthText');
  const hudStats = document.getElementById('hudStats');
  const leaveBtn = document.getElementById('leaveBtn');
  const spectateBanner = document.getElementById('spectateBanner');
  const deathBanner = document.getElementById('deathBanner');
  const settingsBtn = document.getElementById('settingsBtn');
  const settingsPanel = document.getElementById('settingsPanel');
  const closeSettings = document.getElementById('closeSettings');
  const controlModeGroup = document.getElementById('controlModeGroup');
  const joystickSizeInput = document.getElementById('joystickSize');
  const touchControls = document.getElementById('touchControls');
  const moveStick = document.getElementById('moveStick');
  const aimStick = document.getElementById('aimStick');

  // ---------- SETTINGS ----------
  const isTouchDevice = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
  const settings = {
    controlMode: localStorage.getItem('zinkk2_controlMode') || 'auto',
    joystickSize: parseInt(localStorage.getItem('zinkk2_joystickSize') || '110', 10),
  };

  function usingTouchControls() {
    if (settings.controlMode === 'mobile') return true;
    if (settings.controlMode === 'pc') return false;
    return isTouchDevice; // auto
  }

  function applySettings() {
    document.documentElement.style.setProperty('--stick-size', settings.joystickSize + 'px');
    touchControls.classList.toggle('hidden', !usingTouchControls());
    [...controlModeGroup.children].forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === settings.controlMode);
    });
    joystickSizeInput.value = settings.joystickSize;
  }

  controlModeGroup.addEventListener('click', e => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    settings.controlMode = btn.dataset.mode;
    localStorage.setItem('zinkk2_controlMode', settings.controlMode);
    applySettings();
  });
  joystickSizeInput.addEventListener('input', () => {
    settings.joystickSize = parseInt(joystickSizeInput.value, 10);
    localStorage.setItem('zinkk2_joystickSize', settings.joystickSize);
    applySettings();
  });
  settingsBtn.addEventListener('click', () => settingsPanel.classList.toggle('hidden'));
  closeSettings.addEventListener('click', () => settingsPanel.classList.add('hidden'));
  applySettings();

  let ws = null;
  let selfId = null;
  let isSpectator = false;
  let latestState = null;
  let roomsCache = [];

  function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);

    ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);

      if (msg.type === 'lobby') {
        roomsCache = msg.rooms;
        renderLobby();
      }

      if (msg.type === 'joined') {
        selfId = msg.selfId || null;
        isSpectator = !!msg.spectate;
        hudRoom.textContent = msg.roomName;
        spectateBanner.classList.toggle('hidden', !isSpectator);
        showGame();
      }

      if (msg.type === 'state') {
        latestState = msg;
        updateHud();
      }

      if (msg.type === 'error') {
        lobbyError.textContent = msg.message;
      }
    });

    ws.addEventListener('close', () => {
      lobbyError.textContent = 'Disconnected. Reconnecting…';
      setTimeout(connect, 1500);
    });
  }
  connect();

  // ---------- LOBBY ----------
  function renderLobby() {
    roomListEl.innerHTML = '';
    roomsCache.forEach(r => {
      const row = document.createElement('div');
      row.className = 'room-row';

      const info = document.createElement('div');
      info.innerHTML = `<div class="room-row-name">${r.name}</div>
        <div class="room-row-count">${r.players}/${r.max} players · ${r.spectators} watching</div>`;

      const actions = document.createElement('div');
      actions.className = 'room-row-actions';

      const joinBtn = document.createElement('button');
      joinBtn.className = 'btn btn-join';
      joinBtn.textContent = 'Join';
      joinBtn.disabled = r.players >= r.max;
      joinBtn.onclick = () => joinRoom(r.id, false);

      const specBtn = document.createElement('button');
      specBtn.className = 'btn btn-spectate';
      specBtn.textContent = 'Spectate';
      specBtn.onclick = () => joinRoom(r.id, true);

      actions.appendChild(joinBtn);
      actions.appendChild(specBtn);
      row.appendChild(info);
      row.appendChild(actions);
      roomListEl.appendChild(row);
    });
  }

  function joinRoom(roomId, spectate) {
    lobbyError.textContent = '';
    const name = nameInput.value.trim().slice(0, 14);
    ws.send(JSON.stringify({ type: 'join', roomId, spectate, name }));
  }

  function showGame() {
    lobbyEl.classList.add('hidden');
    gameEl.classList.remove('hidden');
    requestAnimationFrame(loop);
  }

  leaveBtn.addEventListener('click', () => {
    ws.send(JSON.stringify({ type: 'leave' }));
    gameEl.classList.add('hidden');
    lobbyEl.classList.remove('hidden');
    latestState = null;
    selfId = null;
    isSpectator = false;
  });

  // ---------- KEYBOARD / MOUSE INPUT (PC) ----------
  const keys = { up: false, down: false, left: false, right: false };
  let mouseShooting = false;
  let mouseX = 0, mouseY = 0;
  let lastAim = 0;

  window.addEventListener('keydown', e => setKey(e.code, true));
  window.addEventListener('keyup', e => setKey(e.code, false));
  function setKey(code, val) {
    if (code === 'KeyW' || code === 'ArrowUp') keys.up = val;
    if (code === 'KeyS' || code === 'ArrowDown') keys.down = val;
    if (code === 'KeyA' || code === 'ArrowLeft') keys.left = val;
    if (code === 'KeyD' || code === 'ArrowRight') keys.right = val;
    if (code === 'Space') mouseShooting = val;
  }
  canvas.addEventListener('mousemove', e => { mouseX = e.clientX; mouseY = e.clientY; });
  canvas.addEventListener('mousedown', () => { mouseShooting = true; });
  canvas.addEventListener('mouseup', () => { mouseShooting = false; });

  // ---------- TOUCH JOYSTICKS (MOBILE) ----------
  function makeStick(baseEl) {
    const handle = baseEl.querySelector('.stick-handle');
    const state = { active: false, dx: 0, dy: 0, pointerId: null };

    function updateFromEvent(e) {
      const rect = baseEl.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const radius = rect.width / 2;
      let dx = (e.clientX - cx) / radius;
      let dy = (e.clientY - cy) / radius;
      const len = Math.hypot(dx, dy);
      if (len > 1) { dx /= len; dy /= len; }
      state.dx = dx; state.dy = dy;
      handle.style.transform = `translate(calc(-50% + ${dx * radius * 0.6}px), calc(-50% + ${dy * radius * 0.6}px))`;
    }

    baseEl.addEventListener('pointerdown', e => {
      state.active = true;
      state.pointerId = e.pointerId;
      baseEl.classList.add('active');
      baseEl.setPointerCapture(e.pointerId);
      updateFromEvent(e);
    });
    baseEl.addEventListener('pointermove', e => {
      if (!state.active || e.pointerId !== state.pointerId) return;
      updateFromEvent(e);
    });
    function release(e) {
      if (e.pointerId !== state.pointerId) return;
      state.active = false;
      state.dx = 0; state.dy = 0;
      baseEl.classList.remove('active');
      handle.style.transform = 'translate(-50%, -50%)';
    }
    baseEl.addEventListener('pointerup', release);
    baseEl.addEventListener('pointercancel', release);

    return state;
  }

  const moveStickState = makeStick(moveStick);
  const aimStickState = makeStick(aimStick);

  function sendInput() {
    if (!ws || ws.readyState !== WebSocket.OPEN || isSpectator || !selfId) return;

    let moveX, moveY, aim, shooting;

    if (usingTouchControls()) {
      moveX = moveStickState.dx;
      moveY = moveStickState.dy;
      const aimMag = Math.hypot(aimStickState.dx, aimStickState.dy);
      if (aimMag > 0.15) lastAim = Math.atan2(aimStickState.dy, aimStickState.dx);
      aim = lastAim;
      shooting = aimStickState.active && aimMag > 0.15;
    } else {
      moveX = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
      moveY = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
      const self = getSelfPlayer();
      aim = lastAim;
      if (self) {
        const screen = worldToScreen(self.x, self.y);
        aim = Math.atan2(mouseY - screen.y, mouseX - screen.x);
        lastAim = aim;
      }
      shooting = mouseShooting;
    }

    ws.send(JSON.stringify({ type: 'input', moveX, moveY, aim, shooting }));
  }
  setInterval(sendInput, 1000 / 30);

  // ---------- RENDER ----------
  function getSelfPlayer() {
    if (!latestState) return null;
    return latestState.players.find(p => p.id === selfId) || null;
  }

  let camX = 0, camY = 0;
  function worldToScreen(x, y) {
    return { x: x - camX + canvas.width / 2, y: y - camY + canvas.height / 2 };
  }

  function updateHud() {
    if (isSpectator) return;
    const self = getSelfPlayer();
    if (!self) return;
    const pct = Math.max(0, self.health);
    hudHealthFill.style.width = pct + '%';
    hudHealthText.textContent = Math.round(pct);
    hudStats.textContent = `Kills ${self.kills} · Deaths ${self.deaths}`;
    deathBanner.classList.toggle('hidden', self.alive);
  }

  function drawGrid() {
    const spacing = 60;
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    const offX = -camX % spacing;
    const offY = -camY % spacing;
    for (let x = offX; x < canvas.width; x += spacing) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
    }
    for (let y = offY; y < canvas.height; y += spacing) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
    }
  }

  function drawArenaBounds() {
    if (!latestState) return;
    const topLeft = worldToScreen(0, 0);
    ctx.strokeStyle = 'rgba(255,176,32,0.4)';
    ctx.lineWidth = 3;
    ctx.strokeRect(topLeft.x, topLeft.y, latestState.arena, latestState.arena);
  }

  function drawTank(p, size) {
    const screen = worldToScreen(p.x, p.y);
    if (!p.alive) return;
    const color = p.id === selfId ? '#e6432f' : '#9297a1';

    ctx.save();
    ctx.translate(screen.x, screen.y);

    // barrel
    ctx.rotate(p.angle);
    ctx.fillStyle = '#40444c';
    ctx.fillRect(0, -6, size * 0.75, 12);
    ctx.rotate(-p.angle);

    // body (square)
    ctx.fillStyle = color;
    ctx.fillRect(-size / 2, -size / 2, size, size);
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 2;
    ctx.strokeRect(-size / 2, -size / 2, size, size);
    ctx.restore();

    // health bar
    const barW = size * 1.1;
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fillRect(screen.x - barW / 2, screen.y - size / 2 - 14, barW, 6);
    ctx.fillStyle = p.id === selfId ? '#e6432f' : '#5fbf6f';
    ctx.fillRect(screen.x - barW / 2, screen.y - size / 2 - 14, barW * (p.health / 100), 6);

    // name
    ctx.fillStyle = '#eceff2';
    ctx.font = '12px Oswald, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(p.name, screen.x, screen.y - size / 2 - 20);
  }

  function drawBullets() {
    if (!latestState) return;
    ctx.fillStyle = '#ffb020';
    latestState.bullets.forEach(b => {
      const s = worldToScreen(b.x, b.y);
      ctx.beginPath();
      ctx.arc(s.x, s.y, 6, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  function loop() {
    if (gameEl.classList.contains('hidden')) return;
    ctx.fillStyle = '#14171c';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (latestState) {
      const self = getSelfPlayer();
      if (self) {
        camX = self.x; camY = self.y;
      } else if (latestState.players.length) {
        // spectator follows first alive player
        const target = latestState.players.find(p => p.alive) || latestState.players[0];
        camX = target.x; camY = target.y;
      } else {
        camX = latestState.arena / 2; camY = latestState.arena / 2;
      }

      drawGrid();
      drawArenaBounds();
      drawBullets();
      latestState.players.forEach(p => drawTank(p, latestState.tankSize));
    }

    requestAnimationFrame(loop);
  }
})();
