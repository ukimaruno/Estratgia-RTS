/* Estratégia (Turnos) — MVP
   Marco 1:
   - Base/castelo + 6 slots
   - Construções por turno + produção por turno
   - Fog cinza e mapa verde
   - Zoom no scroll + pan arrastando com botão direito
*/

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");

const el = {
  menuOverlay: document.getElementById("menuOverlay"),
  btnNew: document.getElementById("btnNew"),
  btnMenu: document.getElementById("btnMenu"),
  btnEndTurn: document.getElementById("btnEndTurn"),
  resWood: document.getElementById("resWood"),
  resStone: document.getElementById("resStone"),
  resMeat: document.getElementById("resMeat"),
  turnNow: document.getElementById("turnNow"),
  selectionInfo: document.getElementById("selectionInfo"),
  buildPanel: document.getElementById("buildPanel"),
  log: document.getElementById("log"),
};

const CFG = {
  zoom: { min: 0.6, max: 2.2, step: 1.10 },
  fog: { baseVision: 260 }, // raio (mundo) visível no início
  base: { size: 26 },       // castelo (quadrado)
  slot: { size: 18, radius: 44 }, // slots ao redor do castelo
  startResources: { wood: 200, stone: 120, meat: 120 }, // suficiente p/ 1 fazenda + 1 serralheria + 1 pedreira
  buildings: {
    FARM:     { name: "Fazenda",     cost: { wood: 50, stone: 10, meat: 0 }, buildTurns: 1, prod: { meat: 30 }, icon: "🌾" },
    LUMBER:   { name: "Serralheria", cost: { wood: 60, stone: 0,  meat: 0 }, buildTurns: 1, prod: { wood: 25 }, icon: "🪵" },
    QUARRY:   { name: "Pedreira",    cost: { wood: 40, stone: 40, meat: 0 }, buildTurns: 1, prod: { stone: 20 }, icon: "🪨" },
    HOUSE:    { name: "Casa",        cost: { wood: 70, stone: 0,  meat: 0 }, buildTurns: 1, prod: null,         icon: "🏠" },
    BARRACKS: { name: "Quartel",     cost: { wood: 120, stone: 60, meat: 0 }, buildTurns: 2, prod: null,         icon: "🏹" },
  }
};

let state = null;

function log(msg, tone = "") {
  const p = document.createElement("div");
  p.className = `item ${tone}`;
  p.textContent = msg;
  el.log.prepend(p);
  while (el.log.childNodes.length > 40) el.log.removeChild(el.log.lastChild);
}

function resize() {
  const r = canvas.getBoundingClientRect();
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.floor(r.width * dpr);
  canvas.height = Math.floor(r.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", resize);
resize();

/* Camera transforms */
function screenToWorld(sx, sy) {
  const r = canvas.getBoundingClientRect();
  const cx = r.width / 2;
  const cy = r.height / 2;
  const x = (sx - cx) / state.camera.zoom + state.camera.x;
  const y = (sy - cy) / state.camera.zoom + state.camera.y;
  return { x, y };
}
function worldToScreen(wx, wy) {
  const r = canvas.getBoundingClientRect();
  const cx = r.width / 2;
  const cy = r.height / 2;
  const x = (wx - state.camera.x) * state.camera.zoom + cx;
  const y = (wy - state.camera.y) * state.camera.zoom + cy;
  return { x, y };
}

function canAfford(cost) {
  return state.resources.wood >= (cost.wood || 0) &&
         state.resources.stone >= (cost.stone || 0) &&
         state.resources.meat >= (cost.meat || 0);
}
function pay(cost) {
  state.resources.wood -= (cost.wood || 0);
  state.resources.stone -= (cost.stone || 0);
  state.resources.meat -= (cost.meat || 0);
}

/* Slots around base */
function computeSlots() {
  const slots = [];
  const { x, y } = state.base.pos;
  const r = CFG.slot.radius;

  // 6 slots em volta (hex-like)
  for (let i = 0; i < 6; i++) {
    const ang = (-Math.PI / 2) + (i * (Math.PI / 3));
    const sx = x + Math.cos(ang) * r;
    const sy = y + Math.sin(ang) * r;
    slots.push({
      idx: i,
      x: sx,
      y: sy,
      building: null, // {type, remainingTurns, built:boolean}
    });
  }
  return slots;
}

/* Selection helpers */
function hitTestBase(wx, wy) {
  const s = CFG.base.size;
  const bx = state.base.pos.x;
  const by = state.base.pos.y;
  return (wx >= bx - s/2 && wx <= bx + s/2 && wy >= by - s/2 && wy <= by + s/2);
}
function hitTestSlot(wx, wy) {
  const s = CFG.slot.size;
  for (const slot of state.base.slots) {
    if (wx >= slot.x - s/2 && wx <= slot.x + s/2 && wy >= slot.y - s/2 && wy <= slot.y + s/2) {
      return slot;
    }
  }
  return null;
}

function setSelectionInfo() {
  if (!state.selection.baseSelected && state.selection.slotIdx == null) {
    el.selectionInfo.className = "card small muted";
    el.selectionInfo.textContent = "Clique na base para ver os 6 slots.";
    return;
  }

  if (state.selection.slotIdx != null) {
    const slot = state.base.slots[state.selection.slotIdx];
    const b = slot.building;
    el.selectionInfo.className = "card small";
    if (!b) {
      el.selectionInfo.innerHTML = `<b>Slot ${slot.idx + 1}</b><div class="muted">Vazio. Escolha uma construção no painel.</div>`;
    } else {
      const def = CFG.buildings[b.type];
      const status = b.built ? "Construído" : `Construindo (faltam ${b.remainingTurns} turno(s))`;
      el.selectionInfo.innerHTML = `<b>${def.name}</b><div class="muted">${status}</div>`;
    }
    return;
  }

  el.selectionInfo.className = "card small";
  el.selectionInfo.innerHTML = `<b>Base (Castelo)</b><div class="muted">Selecione um slot para construir.</div>`;
}

function setBuildPanel() {
  // Painel de construção: só funciona quando um slot estiver selecionado
  const slotIdx = state.selection.slotIdx;
  if (slotIdx == null) {
    el.buildPanel.className = "card small muted";
    el.buildPanel.textContent = "Selecione um slot ao redor do castelo para construir.";
    return;
  }

  const slot = state.base.slots[slotIdx];
  if (slot.building) {
    el.buildPanel.className = "card small muted";
    el.buildPanel.textContent = "Este slot já está ocupado.";
    return;
  }

  const buttons = Object.entries(CFG.buildings).map(([type, def]) => {
    const c = def.cost;
    const costTxt = `${c.wood||0}M ${c.stone||0}P ${c.meat||0}C`;
    const disabled = canAfford(def.cost) ? "" : "disabled";
    return `
      <button class="btn wide ${disabled ? "disabled" : ""}" data-build="${type}" ${disabled}>
        ${def.name} <span style="opacity:.7">(${costTxt})</span> <span style="opacity:.85; float:right">${def.buildTurns}T</span>
      </button>
    `;
  }).join("<div style='height:8px'></div>");

  el.buildPanel.className = "card small";
  el.buildPanel.innerHTML = `
    <div class="muted">Slot <b>${slot.idx + 1}</b> selecionado. Escolha uma construção:</div>
    <div style="height:10px"></div>
    ${buttons}
  `;
}

function updateHUD() {
  el.resWood.textContent = Math.floor(state.resources.wood).toString();
  el.resStone.textContent = Math.floor(state.resources.stone).toString();
  el.resMeat.textContent = Math.floor(state.resources.meat).toString();
  el.turnNow.textContent = state.turn.toString();

  setSelectionInfo();
  setBuildPanel();
}

function startNewGame() {
  state = {
    turn: 1,
    resources: { ...CFG.startResources },
    camera: { x: 0, y: 0, zoom: 1.0 },
    base: {
      pos: { x: 0, y: 0 },
      slots: [],
    },
    // por enquanto, só deixamos “zona de monstros” desenhada (visível) para o próximo marco
    monsterZone: { x: 180, y: 0, visible: true },
    selection: { baseSelected: false, slotIdx: null },
    input: { rmbDown: false, lastMouse: { x:0, y:0 } },
  };

  state.base.slots = computeSlots();

  el.menuOverlay.style.display = "none";
  el.log.innerHTML = "";
  log("Novo jogo iniciado. Construa Fazenda, Serralheria e Pedreira.", "good");
  updateHUD();
}

/* Build action */
function tryBuild(buildType) {
  const slotIdx = state.selection.slotIdx;
  if (slotIdx == null) return;

  const slot = state.base.slots[slotIdx];
  if (slot.building) return;

  const def = CFG.buildings[buildType];
  if (!def) return;

  if (!canAfford(def.cost)) {
    log("Recursos insuficientes para construir.", "warn");
    return;
  }

  pay(def.cost);
  slot.building = {
    type: buildType,
    remainingTurns: def.buildTurns,
    built: false,
  };

  log(`Construção iniciada: ${def.name} (conclui em ${def.buildTurns} turno(s)).`, "good");
  updateHUD();
}

/* Turn processing */
function endTurn() {
  if (!state) return;

  // 1) avançar o turno
  state.turn++;

  // 2) processar construções: reduzir turnos restantes e concluir quando chegar a 0
  for (const slot of state.base.slots) {
    const b = slot.building;
    if (!b) continue;
    if (b.built) continue;

    b.remainingTurns -= 1;
    if (b.remainingTurns <= 0) {
      b.built = true;
      b.remainingTurns = 0;
      const def = CFG.buildings[b.type];
      log(`Construção concluída: ${def.name}.`, "good");
    }
  }

  // 3) produção por turno (somente prédios construídos)
  let addW = 0, addS = 0, addM = 0;
  for (const slot of state.base.slots) {
    const b = slot.building;
    if (!b || !b.built) continue;
    const def = CFG.buildings[b.type];
    if (!def.prod) continue;
    addW += (def.prod.wood || 0);
    addS += (def.prod.stone || 0);
    addM += (def.prod.meat || 0);
  }
  state.resources.wood += addW;
  state.resources.stone += addS;
  state.resources.meat += addM;

  if (addW || addS || addM) {
    log(`Produção do turno: +${addW} Madeira, +${addS} Pedra, +${addM} Carne.`, "");
  } else {
    log("Sem produção (construa estruturas de recurso).", "warn");
  }

  updateHUD();
}

/* Input */
canvas.addEventListener("contextmenu", (e) => e.preventDefault());

canvas.addEventListener("mousedown", (e) => {
  if (!state) return;
  const r = canvas.getBoundingClientRect();
  const sx = e.clientX - r.left;
  const sy = e.clientY - r.top;

  if (e.button === 2) {
    state.input.rmbDown = true;
    state.input.lastMouse.x = sx;
    state.input.lastMouse.y = sy;
    return;
  }

  // Left click selection
  const w = screenToWorld(sx, sy);
  const slot = hitTestSlot(w.x, w.y);
  if (slot) {
    state.selection.baseSelected = true;
    state.selection.slotIdx = slot.idx;
    updateHUD();
    return;
  }

  if (hitTestBase(w.x, w.y)) {
    state.selection.baseSelected = true;
    state.selection.slotIdx = null;
    updateHUD();
    return;
  }

  // click empty clears slot selection
  state.selection.slotIdx = null;
  state.selection.baseSelected = false;
  updateHUD();
});

canvas.addEventListener("mousemove", (e) => {
  if (!state) return;
  if (!state.input.rmbDown) return;

  const r = canvas.getBoundingClientRect();
  const sx = e.clientX - r.left;
  const sy = e.clientY - r.top;

  const dx = sx - state.input.lastMouse.x;
  const dy = sy - state.input.lastMouse.y;

  // pan camera (inverso do mouse), ajustado pelo zoom
  state.camera.x -= dx / state.camera.zoom;
  state.camera.y -= dy / state.camera.zoom;

  state.input.lastMouse.x = sx;
  state.input.lastMouse.y = sy;
});

window.addEventListener("mouseup", (e) => {
  if (!state) return;
  if (e.button === 2) state.input.rmbDown = false;
});

// Zoom on wheel, zoom towards cursor
canvas.addEventListener("wheel", (e) => {
  if (!state) return;
  e.preventDefault();

  const r = canvas.getBoundingClientRect();
  const sx = e.clientX - r.left;
  const sy = e.clientY - r.top;

  const before = screenToWorld(sx, sy);

  const dir = (e.deltaY > 0) ? -1 : 1;
  const factor = dir > 0 ? CFG.zoom.step : (1 / CFG.zoom.step);

  const next = Math.max(CFG.zoom.min, Math.min(CFG.zoom.max, state.camera.zoom * factor));
  state.camera.zoom = next;

  const after = screenToWorld(sx, sy);

  // manter o ponto sob o cursor “preso” durante o zoom
  state.camera.x += (before.x - after.x);
  state.camera.y += (before.y - after.y);

}, { passive: false });

/* Build panel click delegation */
el.buildPanel.addEventListener("click", (e) => {
  if (!state) return;
  const btn = e.target.closest("button[data-build]");
  if (!btn) return;
  const type = btn.getAttribute("data-build");
  tryBuild(type);
});

/* Buttons */
el.btnNew.addEventListener("click", startNewGame);
el.btnMenu.addEventListener("click", () => { el.menuOverlay.style.display = "flex"; });
el.btnEndTurn.addEventListener("click", endTurn);

/* Render */
function draw() {
  const r = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, r.width, r.height);

  // fundo verde (campo)
  ctx.fillStyle = "#2a3a2a";
  ctx.fillRect(0, 0, r.width, r.height);

  // efeito leve (variação) para dar “vida”
  ctx.globalAlpha = 0.12;
  for (let i = 0; i < 120; i++) {
    const x = (i * 97) % r.width;
    const y = (i * 53) % r.height;
    ctx.fillStyle = (i % 2 === 0) ? "#213321" : "#2f422f";
    ctx.fillRect(x, y, 14, 10);
  }
  ctx.globalAlpha = 1;

  if (!state) return;

  // desenhar “zona de visão” e fog cinza fora dela
  const vision = CFG.fog.baseVision;
  const base = state.base.pos;

  // fog overlay (cinza) fora do alcance — simples e eficiente
  ctx.save();
  ctx.fillStyle = "rgba(120,120,120,0.55)";
  ctx.fillRect(0, 0, r.width, r.height);

  // “recorta” a área visível como um círculo
  ctx.globalCompositeOperation = "destination-out";
  const bs = worldToScreen(base.x, base.y);
  ctx.beginPath();
  ctx.arc(bs.x, bs.y, vision * state.camera.zoom, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // caminho para zona de monstros (terra)
  const mz = state.monsterZone;
  const a = worldToScreen(base.x, base.y);
  const b = worldToScreen(mz.x, mz.y);
  ctx.lineWidth = 10 * state.camera.zoom;
  ctx.strokeStyle = "rgba(140,105,70,0.85)";
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();

  // base/castelo (quadradinho cinza medieval)
  const castle = worldToScreen(base.x, base.y);
  const cs = CFG.base.size * state.camera.zoom;

  ctx.fillStyle = "rgba(190,190,190,0.90)";
  ctx.strokeStyle = "rgba(60,60,60,0.8)";
  ctx.lineWidth = 2;

  ctx.fillRect(castle.x - cs/2, castle.y - cs/2, cs, cs);
  ctx.strokeRect(castle.x - cs/2, castle.y - cs/2, cs, cs);

  // “crenelas” no topo (detalhe medieval)
  ctx.fillStyle = "rgba(160,160,160,0.95)";
  const cren = Math.max(4, 6 * state.camera.zoom);
  for (let i = -2; i <= 2; i++) {
    ctx.fillRect(castle.x + i*cren*1.2 - cren/2, castle.y - cs/2 - cren*0.6, cren, cren*0.8);
  }

  // slots (6) ao redor do castelo
  const ss = CFG.slot.size * state.camera.zoom;
  for (const slot of state.base.slots) {
    const p = worldToScreen(slot.x, slot.y);

    const isSelected = state.selection.slotIdx === slot.idx;
    const bld = slot.building;

    // base slot visual
    ctx.fillStyle = "rgba(255,255,255,0.22)";
    ctx.strokeStyle = isSelected ? "rgba(71,209,140,0.95)" : "rgba(255,255,255,0.32)";
    ctx.lineWidth = isSelected ? 3 : 2;

    ctx.fillRect(p.x - ss/2, p.y - ss/2, ss, ss);
    ctx.strokeRect(p.x - ss/2, p.y - ss/2, ss, ss);

    // building icon/status
    if (bld) {
      const def = CFG.buildings[bld.type];
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fillRect(p.x - ss/2, p.y - ss/2, ss, ss);

      ctx.font = `${Math.max(12, 14 * state.camera.zoom)}px system-ui`;
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(def.icon, p.x, p.y);

      // se estiver construindo, desenha “1T/2T”
      if (!bld.built) {
        ctx.font = `${Math.max(10, 11 * state.camera.zoom)}px system-ui`;
        ctx.fillStyle = "rgba(255,204,102,0.95)";
        ctx.fillText(`${bld.remainingTurns}T`, p.x, p.y + ss*0.38);
      }
    }
  }

  // zona de monstros (placeholder visual p/ próximo marco)
  const mzp = worldToScreen(mz.x, mz.y);
  const ms = 22 * state.camera.zoom;
  ctx.fillStyle = "rgba(160,60,60,0.85)";
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(mzp.x, mzp.y, ms, 0, Math.PI*2);
  ctx.fill();
  ctx.stroke();

  ctx.font = `${Math.max(11, 12 * state.camera.zoom)}px system-ui`;
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText("Monstros", mzp.x, mzp.y + ms + 6);
}

function loop() {
  requestAnimationFrame(loop);
  draw();
}
loop();

/* Initial UI state */
updateInitialUI();
function updateInitialUI() {
  el.menuOverlay.style.display = "flex";
  el.resWood.textContent = "0";
  el.resStone.textContent = "0";
  el.resMeat.textContent = "0";
  el.turnNow.textContent = "1";
  el.selectionInfo.className = "card small muted";
  el.selectionInfo.textContent = "Clique em 'Novo Jogo' para iniciar.";
  el.buildPanel.className = "card small muted";
  el.buildPanel.textContent = "Selecione um slot para construir.";
}
