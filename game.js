/* Estratégia (Turnos) — MVP
   Ajuste: mapa procedural (grafo de nós/caminhos) + fog expandindo por territórios dominados.
   Nota: como ainda não há tropas/batalha, monstro é derrotado via botão "Atacar (debug)" ao selecionar um nó de monstro.
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
  resPop: document.getElementById("resPop"),
  turnNow: document.getElementById("turnNow"),
  selectionInfo: document.getElementById("selectionInfo"),
  buildPanel: document.getElementById("buildPanel"),
  log: document.getElementById("log"),
};

const CFG = {
  zoom: { min: 0.6, max: 2.2, step: 1.10 },
  fog: {
    baseVision: 260,      // visão inicial (base)
    territoryVision: 230, // visão ao redor de cada território dominado
  },
  base: { size: 26 },
  slot: { size: 18, radius: 44 },
  startResources: { wood: 200, stone: 120, meat: 120 },
  buildings: {
    FARM:     { name: "Fazenda",     cost: { wood: 50, stone: 10, meat: 0 }, buildTurns: 1, prod: { meat: 30 }, icon: "🌾" },
    LUMBER:   { name: "Serralheria", cost: { wood: 60, stone: 0,  meat: 0 }, buildTurns: 1, prod: { wood: 25 }, icon: "🌲" },
    QUARRY:   { name: "Pedreira",    cost: { wood: 40, stone: 40, meat: 0 }, buildTurns: 1, prod: { stone: 20 }, icon: "🏔️" },
    HOUSE:    { name: "Casa",        cost: { wood: 70, stone: 0,  meat: 0 }, buildTurns: 1, prod: null,         icon: "🏠" },
    BARRACKS: { name: "Quartel",     cost: { wood: 120, stone: 60, meat: 0 }, buildTurns: 2, prod: null,         icon: "🏹" },
  },
  troops: {
    WARRIOR: { name: "Guerreiro", cost: { meat: 25 }, trainTurns: 1, icon: "🗡️", atk: 5, hp: 10 },
    ARCHER:  { name: "Arqueiro",  cost: { meat: 30 }, trainTurns: 1, icon: "🏹", atk: 4, hp: 8  },
  },
  procgen: {
    // “começo”: 1 caminho e 1 monstro perto o suficiente para aparecer na visão inicial
    firstDistanceMin: 170,
    firstDistanceMax: 240,

    // após derrotar: ramifica 1–3 novos monstros mais longe do centro
    branchMin: 1,
    branchMax: 3,
    stepDistanceMin: 170,
    stepDistanceMax: 240,

    minNodeSpacing: 120,      // evita nós colados
    outwardPush: 60,          // garante que novos nós fiquem, em média, mais longe do centro
    maxAttempts: 40,          // tentativas de achar posição válida
    angleJitter: 0.85,        // quanto a ramificação pode “abrir”
  }
};

let state = null;

/* ----------------- RNG com seed opcional (para testar) ----------------- */
function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function() {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}
function mulberry32(a) {
  return function() {
    let t = (a += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function makeRng() {
  const sp = new URLSearchParams(location.search);
  const seed = sp.get("seed");
  if (!seed) return Math.random;
  const h = xmur3(String(seed));
  return mulberry32(h());
}
const RNG = makeRng();
function rand(min, max) { return min + (max - min) * RNG(); }
function randi(min, maxInclusive) { return Math.floor(rand(min, maxInclusive + 1)); }

/* ----------------- UI / util ----------------- */
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

/* Camera */
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

/* Resources */
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

function countBuiltHouses() {
  let n = 0;
  for (const slot of state.base.slots) {
    const b = slot.building;
    if (b && b.built && b.type === "HOUSE") n++;
  }
  return n;
}

// NOVO: população máxima = 6 + 1 por Casa (global, por enquanto contando só a base)
const BASE_POP_CAP = 6;

function getPopulationCap() {
  return BASE_POP_CAP + countBuiltHouses();
}

// NOVO: população usada = total de tropas existentes (no quartel + nos nós)
function getPopulationUsed() {
  let used = 0;

  // tropas ainda “guardadas” em quartéis (base)
  for (const slot of state.base.slots) {
    const b = slot.building;
    if (!b || b.type !== "BARRACKS") continue;
    ensureTroopArray(b);
    for (const t of b.troops) {
      if (!t) continue;
      if (t.status === "dead") continue;
      used++;
    }
  }

  // tropas alocadas em nós (moving/ready)
  if (state.world?.nodes) {
    for (const node of state.world.nodes.values()) {
      if (!node || !Array.isArray(node.troopSlots)) continue;
      for (const t of node.troopSlots) {
        if (!t) continue;
        if (t.status === "dead") continue;
        used++;
      }
    }
  }

  return used;
}

// AJUSTE: slots de tropas NÃO aumentam com Casas (agora é fixo: 3)
function getTroopCapacity() {
  // Novo design: a Base (e futuramente sub-bases) têm 3 slots fixos de tropas.
  return NODE_TROOP_SLOTS_DEFAULT; // 3
}

function ensureTroopArray(barracksBuilding) {
  const cap = getTroopCapacity();
  if (!Array.isArray(barracksBuilding.troops)) barracksBuilding.troops = [];
  // garante tamanho e normaliza vazios para null
  for (let i = 0; i < cap; i++) {
    if (typeof barracksBuilding.troops[i] === "undefined") barracksBuilding.troops[i] = null;
  }
  barracksBuilding.troops.length = cap;
  return cap;
}

function trainTroopOnBarracks(slotIdx, troopType, troopSlotIndex) {
  const slot = state.base.slots[slotIdx];
  const b = slot?.building;
  if (!b || b.type !== "BARRACKS" || !b.built) return;

  const tdef = CFG.troops[troopType];
  if (!tdef) return;

  // Treino agora preenche os slots de tropas da BASE (não do quartel).
  const baseNode = nodeById(state.world.baseNodeId);
  if (!baseNode) return;
  ensureNodeTroopSlots(baseNode);

  if (troopSlotIndex < 0 || troopSlotIndex >= baseNode.troopSlots.length) return;

  if (baseNode.troopSlots[troopSlotIndex]) {
    log("Este slot de tropa já está ocupado na Base.", "warn");
    return;
  }

  // População (se existir no seu código; se não existir, ignora)
  const popCap = (typeof getPopulationCap === "function") ? getPopulationCap() : Infinity;
  const popUsed = (typeof getPopulationUsed === "function") ? getPopulationUsed() : 0;
  if (popUsed >= popCap) {
    log("População máxima atingida. Construa CASAS para aumentar!", "warn");
    return;
  }

  if (!canAfford(tdef.cost)) {
    log("Carne insuficiente para treinar esta tropa.", "warn");
    return;
  }

  pay(tdef.cost);

  baseNode.troopSlots[troopSlotIndex] = {
    type: troopType,
    status: "training",
    remainingTurns: tdef.trainTurns,
  };

  log(`Treino iniciado: ${tdef.name} (Slot ${troopSlotIndex + 1}) — conclui em ${tdef.trainTurns} turno(s).`, "good");
  state.ui.trainPick = null;
  updateHUD();
}

function enterMoveMode(fromNodeId) {
  const from = nodeById(fromNodeId);
  if (!from) return;

  ensureNodeTroopSlots(from);

  const selectedSlots = new Set();
  for (let i = 0; i < from.troopSlots.length; i++) {
    const t = from.troopSlots[i];
    if (t && t.status === "ready") selectedSlots.add(i);
  }

  state.ui.move = {
    active: true,
    fromNodeId,
    selectedSlots,
    order: null, // destino começa vazio
  };

  // Se estiver escolhendo treino, cancela (evita conflito de UI)
  state.ui.trainPick = null;

  log("Modo MOVER ativado. Clique em um nó no mapa para definir o destino.", "warn");
  pinMoveOriginSelection();   // ✅ novo
  updateHUD();
}

function pinMoveOriginSelection() {
  const m = state?.ui?.move;
  if (!m?.active || m.fromNodeId == null) return;

  // sempre limpa seleções que não são o "centro" da origem
  state.selection.slotIdx = null;
  state.selection.outpostSlot = null;

  if (m.fromNodeId === state.world.baseNodeId) {
    state.selection.baseSelected = true;
    state.selection.nodeId = null;
  } else {
    state.selection.baseSelected = false;
    state.selection.nodeId = m.fromNodeId;
  }
}

function exitMoveMode() {
  state.ui.move = { active: false, fromNodeId: null, selectedSlots: null, order: null };
  log("Modo MOVER desativado.", "");
  updateHUD();
}

function countCompletedBuildings(type) {
  let count = 0;
  for (const s of state.base.slots) {
    const b = s.building;
    if (b && b.type === type && b.built) count++;
  }
  return count;
}

function getBarracksSlotCapacity() {
  // Regra: Quartel começa com 3 slots + 1 por Casa concluída
  return 3 + countCompletedBuildings("HOUSE");
}


/* ----------------- Base Slots ----------------- */
function computeSlots() {
  const slots = [];
  const { x, y } = state.base.pos;
  const r = CFG.slot.radius;
  for (let i = 0; i < 6; i++) {
    const ang = (-Math.PI / 2) + (i * (Math.PI / 3));
    const sx = x + Math.cos(ang) * r;
    const sy = y + Math.sin(ang) * r;
    slots.push({ idx: i, x: sx, y: sy, building: null });
  }
  return slots;
}

/* ----------------- Procedural World (Graph) ----------------- */
function vecLen(x, y) { return Math.hypot(x, y); }
function norm(x, y) {
  const L = Math.hypot(x, y) || 1;
  return { x: x / L, y: y / L };
}

function worldInit() {
  state.world = {
    nextId: 1,
    nodes: new Map(), // id -> {id, kind, x, y, discovered, hp}
    edges: [],        // {a,b}
    baseNodeId: 0
  };
  // base node
  state.world.nodes.set(0, { id: 0, kind: "BASE", x: 0, y: 0, discovered: true, hp: 0 });
}

function nodeById(id) { return state.world.nodes.get(id); }

const NODE_TROOP_SLOTS_DEFAULT = 3;

// Garante estrutura de slots de tropas no nó (MONSTER/OWNED)
function ensureNodeTroopSlots(node) {
  if (!node) return null;

  // Agora: TODO nó (inclusive BASE) tem slots próprios.
  if (typeof node.troopSlotsCap !== "number") node.troopSlotsCap = NODE_TROOP_SLOTS_DEFAULT;

  if (!Array.isArray(node.troopSlots) || node.troopSlots.length !== node.troopSlotsCap) {
    node.troopSlots = new Array(node.troopSlotsCap).fill(null);
  } else {
    // normaliza undefined -> null
    for (let i = 0; i < node.troopSlotsCap; i++) {
      if (typeof node.troopSlots[i] === "undefined") node.troopSlots[i] = null;
    }
  }

  if (typeof node.incomingReserved !== "number") node.incomingReserved = 0; // compat (pode ficar 0)
  return node.troopSlots;
}

function getNodeTroopSummary(node) {
  ensureNodeTroopSlots(node);

  let ready = 0, moving = 0, minEta = null;
  for (const t of node.troopSlots) {
    if (!t) continue;
    if (t.status === "ready") ready++;
    if (t.status === "moving") {
      moving++;
      minEta = (minEta == null) ? t.eta : Math.min(minEta, t.eta);
    }
  }

  const cap = node.troopSlotsCap || 0;
  const occupied = ready + moving;
  const reserved = node.incomingReserved || 0;
  const free = Math.max(0, cap - occupied - reserved);

  return { cap, ready, moving, reserved, free, minEta };
}

function countReadyTroopsAtNode(nodeId) {
  if (!state || !state.world) return 0;
  const n = nodeById(nodeId);
  if (!n) return 0;
  return getNodeTroopSummary(n).ready;
}

function isFarFromAll(x, y, minDist) {
  const md2 = minDist * minDist;
  for (const n of state.world.nodes.values()) {
    const dx = x - n.x, dy = y - n.y;
    if (dx*dx + dy*dy < md2) return false;
  }
  return true;
}

function addNode(kind, x, y, discovered = true, hp = 10) {
  const id = state.world.nextId++;
  const node = { id, kind, x, y, discovered, hp };
  // --- Stats de monstro (para combate real) ---
  if (kind === "MONSTER") {
    node.maxHp = hp;
    // ataque simples, proporcional ao HP (você pode ajustar depois)
    node.atk = Math.max(3, Math.floor(node.maxHp / 4));
    node.packSize = clamp(Math.round(node.maxHp / 10), 1, 8);
  }

  // v2: padroniza slots de tropas em nós (troopSlots/troopSlotsCap)
  ensureNodeTroopSlots(node);

  state.world.nodes.set(id, node);
  return id;
}

function addEdge(a, b) {
  state.world.edges.push({ a, b });
}

function buildAdjacency() {
  const adj = new Map();
  for (const n of state.world.nodes.values()) adj.set(n.id, []);
  for (const e of state.world.edges) {
    if (adj.has(e.a)) adj.get(e.a).push(e.b);
    if (adj.has(e.b)) adj.get(e.b).push(e.a);
  }
  return adj;
}

function shortestPathBFS(startId, goalId) {
  if (startId === goalId) return [startId];

  const adj = buildAdjacency();
  const q = [startId];
  let qi = 0;

  const prev = new Map();
  prev.set(startId, null);

  while (qi < q.length) {
    const cur = q[qi++];
    const neigh = adj.get(cur) || [];
    for (const nx of neigh) {
      if (prev.has(nx)) continue;
      prev.set(nx, cur);
      if (nx === goalId) {
        // reconstruir path
        const path = [];
        let p = goalId;
        while (p != null) {
          path.push(p);
          p = prev.get(p);
        }
        path.reverse();
        return path;
      }
      q.push(nx);
    }
  }
  return null;
}

function setMoveDestination(destNodeId) {
  const m = state.ui.move;
  if (!m?.active || m.fromNodeId == null) return;

  if (!(m.selectedSlots instanceof Set) || m.selectedSlots.size === 0) {
    log("Selecione pelo menos 1 tropa (borda verde) antes de escolher o destino.", "warn");
    return;
  }

  const from = nodeById(m.fromNodeId);
  if (!from) return;
  ensureNodeTroopSlots(from);

  const picked = Array.from(m.selectedSlots)
    .filter(i => i >= 0 && i < from.troopSlots.length)
    .filter(i => from.troopSlots[i] && from.troopSlots[i].status === "ready");

  if (picked.length === 0) {
    log("Nenhuma tropa pronta selecionada para mover.", "warn");
    return;
  }

  const path = shortestPathBFS(m.fromNodeId, destNodeId);
  if (!path) {
    log("Destino não alcançável (sem caminho no grafo).", "warn");
    return;
  }

  m.order = {
    fromId: m.fromNodeId,
    toId: destNodeId,
    path,
    steps: Math.max(0, path.length - 1),
  };

  const dn = nodeById(destNodeId);
  log(`Destino definido: Nó ${destNodeId} (${dn?.kind || "?"}) — distância: ${m.order.steps} etapa(s).`, "good");
  pinMoveOriginSelection(); // mantém o HUB na origem, mesmo após escolher destino
  updateHUD();
}

function incomingToNodeSummary(nodeId) {
  const n = nodeById(nodeId);
  if (!n || n.kind === "BASE") return { count: 0, minEta: 0, maxEta: 0 };

  ensureNodeTroopSlots(n);

  let count = 0;
  let minEta = Infinity;
  let maxEta = 0;

  for (const t of n.troopSlots) {
    if (!t || t.status !== "moving") continue;
    count++;
    const eta = (typeof t.eta === "number") ? t.eta : 0;
    minEta = Math.min(minEta, eta);
    maxEta = Math.max(maxEta, eta);
  }

  if (count === 0) minEta = 0;
  return { count, minEta, maxEta };
}

function confirmMoveOrder() {
  const m = state.ui.move;
  if (!m?.active || m.fromNodeId == null) return;

  if (!(m.selectedSlots instanceof Set) || m.selectedSlots.size === 0) {
    log("Selecione pelo menos 1 tropa (borda verde) para mover.", "warn");
    return;
  }

  if (!m.order) {
    log("Defina um destino clicando em um nó no mapa.", "warn");
    return;
  }

  const from = nodeById(m.fromNodeId);
  if (!from) return;
  ensureNodeTroopSlots(from);

  const picked = Array.from(m.selectedSlots)
    .filter(i => i >= 0 && i < from.troopSlots.length)
    .filter(i => from.troopSlots[i] && from.troopSlots[i].status === "ready");

  if (picked.length === 0) {
    log("Nenhuma tropa pronta selecionada para mover.", "warn");
    return;
  }

  const path = shortestPathBFS(m.order.fromId, m.order.toId);
  if (!path) {
    log("Destino não alcançável (sem caminho).", "warn");
    return;
  }

  const steps = Math.max(0, path.length - 1);
  if (steps === 0) {
    log("As tropas já estão no destino.", "warn");
    return;
  }

  const dest = nodeById(m.order.toId);
  if (!dest) return;
  ensureNodeTroopSlots(dest);

  // slots livres no destino
  const freeIdxs = [];
  for (let i = 0; i < dest.troopSlots.length; i++) {
    if (!dest.troopSlots[i]) freeIdxs.push(i);
  }

  if (picked.length > freeIdxs.length) {
    const sum = getNodeTroopSummary(dest);
    log(`Sem slots suficientes no destino. Destino tem ${sum.cap} slots: ocupados=${sum.ready + sum.moving}, livres=${sum.free}.`, "warn");
    return;
  }

  // Regra nova: ao clicar CONFIRMAR, as tropas já “saem” da origem
  // e ocupam o destino como MOVING (ETA = steps).
  for (let k = 0; k < picked.length; k++) {
    const fromIdx = picked[k];
    const t = from.troopSlots[fromIdx];
    const toIdx = freeIdxs[k];

    dest.troopSlots[toIdx] = {
      type: t.type,
      status: "moving",
      eta: steps,
    };

    from.troopSlots[fromIdx] = null;
  }

  log(`Movimento iniciado: ${picked.length} tropa(s) saíram agora e chegarão em ${steps} dia(s) no Nó ${dest.id}.`, "good");

  exitMoveMode();
  updateHUD();
}

function spawnFirstMonster() {
  const dist = rand(CFG.procgen.firstDistanceMin, CFG.procgen.firstDistanceMax);
  const ang = rand(0, Math.PI * 2);
  const x = Math.cos(ang) * dist;
  const y = Math.sin(ang) * dist;

  const id = addNode("MONSTER", x, y, true, 12);
  addEdge(state.world.baseNodeId, id);
  log("Um caminho surgiu… há monstros adiante.", "warn");
}

function spawnBranchesFrom(parentId) {
  const parent = nodeById(parentId);
  const base = nodeById(state.world.baseNodeId);

  const bcount = randi(CFG.procgen.branchMin, CFG.procgen.branchMax);

  // vetor “para fora” (do centro para o pai)
  let out = { x: parent.x - base.x, y: parent.y - base.y };
  if (vecLen(out.x, out.y) < 0.001) {
    out = { x: rand(-1, 1), y: rand(-1, 1) };
  }
  out = norm(out.x, out.y);
  const baseAngle = Math.atan2(out.y, out.x);

  for (let i = 0; i < bcount; i++) {
    let placed = false;

    // espalha as ramificações (não todas no mesmo ângulo)
    const spread = (bcount === 1) ? 0 : (i - (bcount - 1) / 2) * 0.65;

    for (let attempt = 0; attempt < CFG.procgen.maxAttempts; attempt++) {
      const dist = rand(CFG.procgen.stepDistanceMin, CFG.procgen.stepDistanceMax);
      const jitter = rand(-CFG.procgen.angleJitter, CFG.procgen.angleJitter);
      const ang = baseAngle + spread + jitter;

      let x = parent.x + Math.cos(ang) * dist;
      let y = parent.y + Math.sin(ang) * dist;

      // empurra “para longe do centro” (garante progresso)
      const dParent = vecLen(parent.x - base.x, parent.y - base.y);
      const dNew = vecLen(x - base.x, y - base.y);
      if (dNew < dParent + CFG.procgen.outwardPush) {
        const push = (dParent + CFG.procgen.outwardPush) - dNew;
        x += out.x * push;
        y += out.y * push;
      }

      if (!isFarFromAll(x, y, CFG.procgen.minNodeSpacing)) continue;

      const nid = addNode("MONSTER", x, y, true, 12 + Math.floor(state.turn / 3));
      addEdge(parentId, nid);
      placed = true;
      break;
    }

    if (!placed) {
      // se falhar, ainda assim não quebra o jogo
      log("Falha ao gerar uma ramificação (sem espaço).", "warn");
    }
  }
}

function initOutpost(node) {
  if (!node || node.kind !== "OWNED") return;
  if (node.buildSlots) return; // já inicializado

  // 3 slots ao redor do quadrado (sub-base)
  const ring = CFG.slot.radius * 1.05; // ~46 (bom espaçamento)
  const anglesDeg = [-90, 30, 150];    // triângulo “pra cima” visualmente agradável

  node.buildSlots = anglesDeg.map((deg, i) => {
    const a = (deg * Math.PI) / 180;
    return {
      idx: i,
      x: node.x + Math.cos(a) * ring,
      y: node.y + Math.sin(a) * ring,
      building: null,
    };
  });
}

/* ----------------- Selection / Hit tests ----------------- */
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

function hitTestOutpostSlot(wx, wy) {
  const s = CFG.slot.size;

  for (const n of state.world.nodes.values()) {
    if (n.kind !== "OWNED") continue;
    if (!n.discovered) continue;
    if (!n.buildSlots) continue;

    for (const slot of n.buildSlots) {
      if (
        wx >= slot.x - s / 2 && wx <= slot.x + s / 2 &&
        wy >= slot.y - s / 2 && wy <= slot.y + s / 2
      ) {
        return { nodeId: n.id, idx: slot.idx };
      }
    }
  }
  return null;
}

function hitTestNode(wx, wy) {
  // prioridade: monstro/território (exceto base)
  const R = 26; // raio em coords mundo
  for (const n of state.world.nodes.values()) {
    if (n.id === state.world.baseNodeId) continue;
    if (!n.discovered) continue;
    const dx = wx - n.x, dy = wy - n.y;
    if (dx*dx + dy*dy <= R*R) return n;
  }
  return null;
}

function clearSelection() {
  state.selection.baseSelected = false;
  state.selection.slotIdx = null;
  state.selection.nodeId = null;
  state.selection.outpostSlot = null; // { nodeId, idx }
}

function setSelectionInfo() {
  const { slotIdx, nodeId, baseSelected } = state.selection;

  if (nodeId != null) {
    const n = nodeById(nodeId);
    el.selectionInfo.className = "card small";
    if (n.kind === "MONSTER") {
      el.selectionInfo.innerHTML = `<b>Monstros</b><div class="muted">Nó ${n.id} — HP ${n.hp}. Selecione e clique em <b>Atacar</b>.</div>`;
    } else if (n.kind === "OWNED") {
      el.selectionInfo.innerHTML =
         `<b>Território dominado</b>` +
         `<div class="muted">Nó ${n.id}. Clique no <b>centro</b> para ver tropas/MOVER. Clique nos <b>slots ao redor</b> para construir.</div>`;
    } else {
      el.selectionInfo.innerHTML = `<b>Nó</b><div class="muted">${n.kind}</div>`;
    }
    return;
  }

  if (slotIdx != null) {
    const slot = state.base.slots[slotIdx];
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

  if (baseSelected) {
    el.selectionInfo.className = "card small";
    el.selectionInfo.innerHTML = `<b>Base (Castelo)</b><div class="muted">Aqui ficam os <b>slots de tropas</b> e a ação <b>MOVER</b>. Para treinar tropas, clique no <b>Quartel</b> (quando construído).</div>`;
    return;
  }

  el.selectionInfo.className = "card small muted";
  el.selectionInfo.textContent = "Clique na base, em um slot, ou em um monstro (nó vermelho).";
}

function setBuildPanel() {
  // 1.5) Se selecionou um slot de SUB-BASE (território dominado)  ✅ (PRIORIDADE)
  if (state.selection.outpostSlot) {
    const n = nodeById(state.selection.outpostSlot.nodeId);
    const slot = n?.buildSlots?.[state.selection.outpostSlot.idx];

    if (!n || !slot) {
      el.buildPanel.className = "card small muted";
      el.buildPanel.textContent = "Seleção inválida de sub-base.";
      return;
    }

    // se já tem prédio
    if (slot.building) {
      const b = slot.building;
      const def = CFG.buildings[b.type];

      el.buildPanel.className = "card small";
      el.buildPanel.innerHTML = `
        <div class="muted">Sub-base — Slot <b>${slot.idx + 1}</b></div>
        <div style="height:10px"></div>
        <div><b>${def.icon} ${def.name}</b></div>
        <div style="height:6px"></div>
        <div class="muted">${
          b.built ? "Concluído ✅" : `Em construção… faltam <b>${b.remainingTurns}</b> turno(s).`
        }</div>
      `;
      return;
    }

    // slot vazio: mesmos botões da base (reusa tryBuild)
    const buttons = Object.keys(CFG.buildings)
      .map((type) => {
        const def = CFG.buildings[type];
        const costTxt = fmtCost(def.cost);
        const disabled = canAfford(def.cost) ? "" : "disabled";
        return `
          <button class="btn wide ${disabled ? "disabled" : ""}" data-build="${type}" ${disabled}>
            ${def.name} <span style="opacity:.7">(${costTxt})</span>
            <span style="opacity:.85; float:right">${def.buildTurns}T</span>
          </button>
        `;
      })
      .join("<div style='height:8px'></div>");

    el.buildPanel.className = "card small";
    el.buildPanel.innerHTML = `
      <div class="muted">Sub-base — Slot <b>${slot.idx + 1}</b> selecionado. Escolha uma construção:</div>
      <div style="height:10px"></div>
      ${buttons}
    `;
    return;
  }

  // 1) Se selecionou nó do mapa -> ações do nó (monstro) OU painel do território dominado ✅
  if (state.selection.nodeId != null) {
    const n = nodeById(state.selection.nodeId);
    if (!n) return;

    if (n.kind === "MONSTER") {
      const readyHere = countReadyTroopsAtNode(n.id);

      const incoming = incomingToNodeSummary(n.id);
      const etaLabel =
        incoming.count > 0
          ? (incoming.minEta === incoming.maxEta
              ? `${incoming.minEta}`
              : `${incoming.minEta}–${incoming.maxEta}`) + " dia(s)"
          : "";

      const incomingLine =
        incoming.count > 0
          ? `<div class="muted">Chegando: <b>${incoming.count}</b> tropa(s) — ETA: ${etaLabel}.</div>`
          : `<div class="muted">Chegando: <b>0</b> tropa(s).</div>`;

      el.buildPanel.className = "card small";

      if (readyHere <= 0) {
        el.buildPanel.innerHTML = `
          <div class="muted">Ações do nó (Monstros):</div>
          <div style="height:10px"></div>

          <div class="muted">Tropas prontas no território: <b>${readyHere}</b></div>
          <div style="height:6px"></div>
          ${incomingLine}

          <div style="height:10px"></div>
          <div class="muted">Você precisa ter tropas <b>prontas</b> no território para atacar.</div>
          <div class="muted">Use: Quartel → MOVER → escolha o destino → Confirmar → Passar Turno até chegar.</div>
        `;
        return;
      }

      el.buildPanel.innerHTML = `
        <div class="muted">Ações do nó (Monstros):</div>
        <div style="height:10px"></div>
        <button class="btn wide primary" data-action="attack">Atacar</button>
        <div style="height:10px"></div>

        <div class="muted">Tropas prontas no território: <b>${readyHere}</b></div>
        <div style="height:6px"></div>
        ${incomingLine}
      `;
      return;
    }

    // ✅ OWNED: painel de tropas + MOVER (igual Base)
    if (n.kind === "OWNED") {
      ensureNodeTroopSlots(n);

      // contagens
      let readyHere = 0;
      for (const t of n.troopSlots) if (t && t.status === "ready") readyHere++;

      const incoming = incomingToNodeSummary(n.id);
      const etaLabel =
        incoming.count > 0
          ? (incoming.minEta === incoming.maxEta
              ? `${incoming.minEta}`
              : `${incoming.minEta}–${incoming.maxEta}`) + " dia(s)"
          : "";
      const incomingLine =
        incoming.count > 0
          ? `<div class="muted">Chegando: <b>${incoming.count}</b> tropa(s) — ETA: ${etaLabel}.</div>`
          : `<div class="muted">Chegando: <b>0</b> tropa(s).</div>`;

      const m = state.ui.move;
      const isMoveHere = !!(m && m.active && m.fromNodeId === n.id);
      const selectedCount = isMoveHere && m.selectedSlots instanceof Set ? m.selectedSlots.size : 0;

      // lista de tropas do nó
      let rows = "";
      for (let i = 0; i < n.troopSlots.length; i++) {
        const t = n.troopSlots[i];
        const slotLabel = `Slot ${i + 1}`;

        if (!t) {
          rows += `<div class="muted" style="padding:10px;border:1px solid rgba(255,255,255,.12);border-radius:10px">${slotLabel}: vazio</div>`;
          continue;
        }

        const def = CFG.troops?.[t.type] || { icon: "⚔️", name: t.type };
        const label = `${def.icon} ${def.name}`;

        if (t.status === "training") {
          rows += `<div class="muted" style="padding:10px;border:1px solid rgba(255,255,255,.12);border-radius:10px">${slotLabel}: ${label} — treinando (${t.remainingTurns ?? "?"}T)</div>`;
          continue;
        }

        if (t.status === "moving") {
          rows += `<div class="muted" style="padding:10px;border:1px solid rgba(255,255,255,.12);border-radius:10px">${slotLabel}: ${label} — em deslocamento (ETA ${t.eta ?? "?"})</div>`;
          continue;
        }

        // ready
        if (isMoveHere) {
          const picked = m.selectedSlots.has(i);
          rows += `
            <button class="btn wide ${picked ? "primary" : ""}" data-move-toggle="${i}">
              ${slotLabel}: ${label} ${picked ? "✓" : ""}
            </button>
          `;
        } else {
          rows += `<div style="padding:10px;border:1px solid rgba(255,255,255,.12);border-radius:10px">${slotLabel}: ${label} ✅</div>`;
        }
      }

      let moveHeader = "";
      if (isMoveHere) {
        if (!m.order) {
          moveHeader = `
            <div class="muted"><b>MOVER</b> — selecionadas: <b>${selectedCount}</b></div>
            <div class="muted">Clique em um destino no mapa (outro território ou a Base).</div>
            <div style="height:10px"></div>
            <button class="btn wide" data-action="cancel-move">Cancelar</button>
          `;
        } else {
          moveHeader = `
            <div class="muted"><b>MOVER</b> — selecionadas: <b>${selectedCount}</b></div>
            <div class="muted">Origem: <b>${m.order.fromId}</b> → Destino: <b>${m.order.toId}</b> (ETA: ${m.order.steps})</div>
            <div style="height:10px"></div>
            <button class="btn wide primary" data-action="confirm-move">Confirmar</button>
            <div style="height:8px"></div>
            <button class="btn wide" data-action="cancel-move">Cancelar</button>
          `;
        }
      } else {
        const dis = readyHere > 0 ? "" : "disabled";
        moveHeader = `
          <div class="muted">Tropas prontas no território: <b>${readyHere}</b></div>
          <div style="height:8px"></div>
          <button class="btn wide ${dis ? "disabled" : ""}" data-action="move" ${dis}>MOVER</button>
        `;
      }

      el.buildPanel.className = "card small";
      el.buildPanel.innerHTML = `
        <b>Território dominado</b>
        <div class="muted">Nó ${n.id} • Slots de tropas: ${n.troopSlots.length}</div>
        <div style="height:10px"></div>
        ${moveHeader}
        <div style="height:10px"></div>
        ${incomingLine}
        <div style="height:12px"></div>
        ${rows}
        <div style="height:12px"></div>
        <div class="muted">Para construir aqui: clique em um <b>slot ao redor</b> do território no mapa.</div>
      `;
      return;
    }

    // fallback
    el.buildPanel.className = "card small muted";
    el.buildPanel.textContent = `Nó ${n.id}: ${n.kind}`;
    return;
  }

  // 2) Se slot selecionado -> construir OU (se quartel) gerenciar tropas
  const slotIdx = state.selection.slotIdx;
  if (slotIdx == null) {
    // Clique no castelo (centro) -> Painel de tropas + MOVER
    if (state.selection.baseSelected) {
      const baseNode = nodeById(state.world.baseNodeId);
      ensureNodeTroopSlots(baseNode);

      const m = state.ui.move;
      const isMoveHere = !!(m?.active && m.fromNodeId === baseNode.id);
      const selectedCount = (isMoveHere && m.selectedSlots instanceof Set) ? m.selectedSlots.size : 0;

      // slots
      const rows = [];
      for (let i = 0; i < baseNode.troopSlots.length; i++) {
        const troop = baseNode.troopSlots[i];

        if (!troop) {
          rows.push(`<div class="muted" style="padding:8px 10px; border:2px solid transparent; border-radius:10px; background: rgba(255,255,255,0.04);">Slot ${i + 1}: (vazio)</div>`);
          continue;
        }

        const tdef = CFG.troops[troop.type];

        if (troop.status === "training") {
          rows.push(`<div class="muted" style="padding:8px 10px; border:2px solid transparent; border-radius:10px; background: rgba(255,255,255,0.04);">Slot ${i + 1}: ${tdef.icon} ${tdef.name} — treinando (${troop.remainingTurns}T)</div>`);
          continue;
        }

        if (troop.status === "moving") {
          rows.push(`<div class="muted" style="padding:8px 10px; border:2px solid transparent; border-radius:10px; background: rgba(255,255,255,0.04);">Slot ${i + 1}: ${tdef.icon} ${tdef.name} — chegando em ${troop.eta} dia(s)</div>`);
          continue;
        }

        // pronta
        if (isMoveHere) {
          const sel = m.selectedSlots instanceof Set && m.selectedSlots.has(i);
          rows.push(`
            <button class="btn wide" data-move-toggle="${i}"
              style="border: 2px solid ${sel ? "green" : "transparent"}; background: rgba(255,255,255,0.06);">
              Slot ${i + 1}: ${tdef.icon} ${tdef.name} — pronta
            </button>
          `);
        } else {
          rows.push(`<div style="padding:8px 10px; border:1px solid rgba(255,255,255,.12); border-radius:10px;">Slot ${i + 1}: ${tdef.icon} ${tdef.name} — pronta</div>`);
        }
      }

      // botões de mover
      let moveUI = "";
      if (isMoveHere) {
        if (m.order) {
          const o = m.order;
          moveUI = `
            <div style="height:8px"></div>
            <div class="muted">Origem: <b>${o.fromId}</b> • Destino: <b>${o.toId}</b> • Distância: <b>${o.steps}</b> dia(s)</div>
            <div style="height:10px"></div>
            <button class="btn wide primary" data-action="confirm-move">CONFIRMAR MOVIMENTO</button>
            <div style="height:10px"></div>
            <button class="btn wide" data-action="cancel-move">Cancelar</button>
          `;
        } else {
          moveUI = `
            <div style="height:8px"></div>
            <div class="muted">Clique em um nó no mapa para definir o destino.</div>
            <div style="height:10px"></div>
            <button class="btn wide" data-action="cancel-move">Cancelar</button>
          `;
        }
      } else {
        const ready = getNodeTroopSummary(baseNode).ready;
        const dis = ready > 0 ? "" : "disabled";
        moveUI = `
          <div style="height:10px"></div>
          <button class="btn wide primary ${dis ? "disabled" : ""}" data-action="move" ${dis}>MOVER</button>
          <div style="height:8px"></div>
          <div class="muted">Tropas prontas: <b>${ready}</b> • Selecionadas (no mover): <b>${selectedCount}</b></div>
        `;
      }

      el.buildPanel.className = "card small";
      el.buildPanel.innerHTML = `
        <b>Base (Tropas)</b>
        <div class="muted">Slots de tropas: ${baseNode.troopSlots.length}</div>
        ${moveUI}
        <div style="height:12px"></div>
        ${rows.join("<div style='height:8px'></div>")}
      `;
      return;
    }

    // ✅ Se estiver em modo MOVER, o HUB NÃO pode sumir: mostra painel de movimento mesmo sem seleção
    if (state.ui.move?.active) {
      pinMoveOriginSelection();
      setBuildPanel(); // re-render já com a seleção fixada na origem
      return;
    }

    // Sem seleção relevante
    el.buildPanel.className = "card small muted";
    el.buildPanel.textContent = "Selecione um slot ao redor do castelo para construir.";
    return;
  }

  const slot = state.base.slots[slotIdx];
  const b = slot.building;

  // 2.1) Quartel
  if (b && b.type === "BARRACKS") {
    el.buildPanel.className = "card small";

    if (!b.built) {
      const def = CFG.buildings.BARRACKS;
      el.buildPanel.innerHTML = `
        <b>${def.name}</b>
        <div class="muted">Construindo... faltam ${b.remainingTurns} turno(s).</div>
      `;
      return;
    }

    // Quartel agora NÃO guarda tropas. Ele apenas habilita/mostra o treino
    // nos slots de tropas da BASE (os mesmos slots vistos ao clicar no castelo).
    const baseNode = nodeById(state.world.baseNodeId);
    ensureNodeTroopSlots(baseNode);

    const cap = baseNode.troopSlots.length;

    const popCap = (typeof getPopulationCap === "function") ? getPopulationCap() : null;
    const popUsed = (typeof getPopulationUsed === "function") ? getPopulationUsed() : null;
    const popTxt = (popCap != null && popUsed != null) ? ` • População: <b>${popUsed}</b>/<b>${popCap}</b>` : "";

    const rows = [];
    for (let i = 0; i < cap; i++) {
      const troop = baseNode.troopSlots[i];

      if (!troop) {
        rows.push(`<button class="btn wide" data-troop-pick="${i}">Slot ${i + 1}: (vazio) — clicar para treinar</button>`);
        continue;
      }

      const tdef = CFG.troops[troop.type];

      if (troop.status === "training") {
        rows.push(`<div class="muted" style="padding:8px 10px; border:2px solid transparent; border-radius:10px; background: rgba(255,255,255,0.04);">Slot ${i + 1}: ${tdef.icon} ${tdef.name} — treinando (${troop.remainingTurns}T)</div>`);
        continue;
      }

      if (troop.status === "moving") {
        rows.push(`<div class="muted" style="padding:8px 10px; border:2px solid transparent; border-radius:10px; background: rgba(255,255,255,0.04);">Slot ${i + 1}: ${tdef.icon} ${tdef.name} — chegando em ${troop.eta} dia(s)</div>`);
        continue;
      }

      rows.push(`<div style="padding:8px 10px; border:1px solid rgba(255,255,255,.12); border-radius:10px;">Slot ${i + 1}: ${tdef.icon} ${tdef.name} — pronta</div>`);
    }

    // treino
    const pick = state.ui.trainPick;
    let pickUI = "";

    if (pick != null && baseNode.troopSlots[pick] == null) {
      const w = CFG.troops.WARRIOR;
      const a = CFG.troops.ARCHER;

      const wDis = canAfford(w.cost) ? "" : "disabled";
      const aDis = canAfford(a.cost) ? "" : "disabled";

      pickUI = `
        <div style="height:12px"></div>
        <div class="muted">Treinar no Slot ${pick + 1}:</div>
        <div style="height:8px"></div>

        <button class="btn wide ${wDis ? "disabled" : ""}" data-train="WARRIOR" data-troop-slot="${pick}" ${wDis}>
          ${w.icon} ${w.name} <span style="opacity:.7">(-${w.cost.meat} Carne)</span> <span style="opacity:.85; float:right">${w.trainTurns}T</span>
        </button>
        <div style="height:8px"></div>
        <button class="btn wide ${aDis ? "disabled" : ""}" data-train="ARCHER" data-troop-slot="${pick}" ${aDis}>
          ${a.icon} ${a.name} <span style="opacity:.7">(-${a.cost.meat} Carne)</span> <span style="opacity:.85; float:right">${a.trainTurns}T</span>
        </button>

        <div style="height:10px"></div>
        <button class="btn wide" data-action="cancel-train-pick">Cancelar</button>
      `;
    }

    el.buildPanel.innerHTML = `
      <b>Quartel</b>
      <div class="muted">Treine tropas usando os slots da Base (3 slots fixos).${popTxt}</div>
      <div style="height:12px"></div>
      ${rows.join("<div style='height:8px'></div>")}
      ${pickUI}
    `;
    return;
  }

  // 2.2) Slot ocupado por outro prédio
  if (b) {
    el.buildPanel.className = "card small muted";
    el.buildPanel.textContent = "Este slot já está ocupado.";
    return;
  }

  // 2.3) Slot vazio -> construir
  const buttons = Object.entries(CFG.buildings).map(([type, def]) => {
    const c = def.cost;
    const costTxt = `${c.wood||0}M ${c.stone||0}P ${c.meat||0}C`;
    const disabled = canAfford(def.cost) ? "" : "disabled";
    return `
      <button class="btn wide ${disabled ? "disabled" : ""}" data-build="${type}" ${disabled}>
        ${def.name} <span style="opacity:.7">(${costTxt})</span>
        <span style="opacity:.85; float:right">${def.buildTurns}T</span>
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

  if (el.resPop) {
    el.resPop.textContent = `${getPopulationUsed()}/${getPopulationCap()}`;
  }

  // ✅ Blindagem: se estiver em modo MOVER e a seleção sumir, fixa de volta na ORIGEM
  const m = state.ui.move;
  const selEmpty =
    !state.selection.baseSelected &&
    state.selection.slotIdx == null &&
    state.selection.nodeId == null &&
    !state.selection.outpostSlot;

  if (m?.active && selEmpty) {
    if (m.fromNodeId === state.world.baseNodeId) {
      state.selection.baseSelected = true;
      state.selection.slotIdx = null;
      state.selection.nodeId = null;
      state.selection.outpostSlot = null;
    } else {
      state.selection.baseSelected = false;
      state.selection.slotIdx = null;
      state.selection.nodeId = m.fromNodeId;
      state.selection.outpostSlot = null;
    }
  }

  setSelectionInfo();
  setBuildPanel();
}

/* ----------------- Build action ----------------- */
function tryBuild(buildType) {
  const def = CFG.buildings[buildType];
  if (!def) return;

  // prioridade: sub-base (se selecionado), senão base
  let targetSlot = null;

  if (state.selection.outpostSlot) {
    const n = nodeById(state.selection.outpostSlot.nodeId);
    if (!n?.buildSlots) return;
    targetSlot = n.buildSlots[state.selection.outpostSlot.idx];
  } else {
    const slotIdx = state.selection.slotIdx;
    if (slotIdx == null) return;
    targetSlot = state.base.slots[slotIdx];
  }

  if (!targetSlot || targetSlot.building) return;

  if (!canAfford(def.cost)) {
    log("Recursos insuficientes para construir.", "warn");
    return;
  }

  pay(def.cost);

  targetSlot.building = {
    type: buildType,
    remainingTurns: def.buildTurns,
    built: false
  };

  log(`Construção iniciada: ${def.name} (conclui em ${def.buildTurns} turno(s)).`, "good");
  updateHUD();
}

/* ----------------- Turn processing ----------------- */
function endTurn() {
  if (!state) return;

  try {
    state.turn++;

    // helper: iterar slots da base + slots das sub-bases
    function forEachBuildSlot(fn) {
      for (const slot of state.base.slots) fn(slot);

      for (const n of state.world.nodes.values()) {
        if (n.kind !== "OWNED") continue;
        if (!n.buildSlots) continue;
        for (const slot of n.buildSlots) fn(slot);
      }
    }

    // 1) construções
    forEachBuildSlot((slot) => {
      const b = slot.building;
      if (!b || b.built) return;

      b.remainingTurns -= 1;

      if (b.remainingTurns <= 0) {
        b.built = true;
        b.remainingTurns = 0;

        const def = CFG.buildings[b.type];
        const name = def?.name || b.type || "Construção";
        log(`Construção concluída: ${name}.`, "good");
      }
    });

    // 2) produção (global)
    let addW = 0, addS = 0, addM = 0;

    forEachBuildSlot((slot) => {
      const b = slot.building;
      if (!b || !b.built) return;

      const def = CFG.buildings[b.type];
      if (!def || !def.prod) return;

      addW += (def.prod.wood || 0);
      addS += (def.prod.stone || 0);
      addM += (def.prod.meat || 0);
    });

    state.resources.wood += addW;
    state.resources.stone += addS;
    state.resources.meat += addM;

    if (addW || addS || addM) log(`Produção do turno: +${addW} Madeira, +${addS} Pedra, +${addM} Carne.`, "");
    else log("Sem produção (construa estruturas de recurso).", "warn");

    // 3) TREINO DE TROPAS (AGORA É NOS SLOTS DO NÓ, NÃO NO QUARTEL)
    function nodeHasBuiltBarracks(node) {
      // Base usa state.base.slots; sub-base usa node.buildSlots
      const slots = (node?.id === state.world.baseNodeId) ? state.base.slots : (node?.buildSlots || []);
      for (const s of slots) {
        const b = s?.building;
        if (b && b.type === "BARRACKS" && b.built) return true;
      }
      return false;
    }

    function tickTrainingInNode(node) {
      if (!node) return 0;
      if (!nodeHasBuiltBarracks(node)) return 0;

      ensureNodeTroopSlots(node);

      let finished = 0;

      for (let i = 0; i < node.troopSlots.length; i++) {
        const t = node.troopSlots[i];
        if (!t || t.status !== "training") continue;

        t.remainingTurns -= 1;

        if (t.remainingTurns <= 0) {
          t.status = "ready";
          t.remainingTurns = 0;
          finished++;
        }
      }

      return finished;
    }

    // Base
    const baseNode = nodeById(state.world.baseNodeId);
    const baseFinished = tickTrainingInNode(baseNode);
    if (baseFinished > 0) log(`Tropas prontas na Base: ${baseFinished}.`, "good");

    // Sub-bases (se/quando tiverem quartel e treino implementado nelas)
    for (const n of state.world.nodes.values()) {
      if (n.kind !== "OWNED") continue;
      const done = tickTrainingInNode(n);
      if (done > 0) log(`Tropas prontas no território ${n.id}: ${done}.`, "good");
    }

    // 4) progresso de tropas nos NÓS (em movimento)
    for (const n of state.world.nodes.values()) {
      ensureNodeTroopSlots(n);

      let arrived = 0;

      for (let s = 0; s < n.troopSlots.length; s++) {
        const t = n.troopSlots[s];
        if (!t || t.status !== "moving") continue;

        t.eta -= 1;
        if (t.eta <= 0) {
          t.status = "ready";
          t.eta = 0;
          arrived++;
        }
      }

      if (arrived > 0) {
        log(`Tropas chegaram ao Nó ${n.id}: ${arrived}.`, "good");
      }
    }
  } catch (err) {
    console.error(err);
    log(`Erro ao passar turno: ${err?.message || err}`, "warn");
  }

  // Atualiza UI mesmo se algo deu ruim no try
  try {
    updateHUD();
  } catch (err2) {
    console.error(err2);
  }
}

/* ----------------- Monster defeat (debug) ----------------- */
/* ----------------- Monster fight (MVP) ----------------- */

/* ----------------- Battle (Auto 2D) ----------------- */

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function buildBattleFromMonsterNode(n) {
  // pega tropas prontas no nó (slots)
  ensureNodeTroopSlots(n);

  const usedSlots = [];
  const allies = [];

  for (let i = 0; i < n.troopSlots.length; i++) {
    const t = n.troopSlots[i];
    if (!t || t.status !== "ready") continue;

    const def = CFG.troops?.[t.type] || { atk: 1, hp: 6, name: t.type };
    usedSlots.push(i);

    allies.push({
      slotIdx: i,
      type: t.type,
      name: def.name || t.type,
      atk: def.atk ?? 1,
      hp: def.hp ?? 6,
      maxHp: def.hp ?? 6,
      x: 0, y: 0,
      alive: true,
      color: troopColor(t.type),
    });
  }

  // sem tropas → não inicia
  if (allies.length === 0) return null;

  // garante stats do monstro
  if (typeof n.maxHp !== "number") n.maxHp = n.hp;
  if (typeof n.atk !== "number") n.atk = Math.max(3, Math.floor((n.maxHp || 10) / 4));

  // quantos “monstros quadrados” aparecem
  const pack = (typeof n.packSize === "number")
    ? n.packSize
    : clamp(Math.round((n.maxHp || 20) / 10), 1, 8);

  const enemies = [];
  const perHp = Math.ceil((n.maxHp || 20) / pack);
  const perAtk = Math.max(1, Math.floor((n.atk || 4) / pack));

  for (let i = 0; i < pack; i++) {
    enemies.push({
      idx: i,
      atk: perAtk,
      hp: perHp,
      maxHp: perHp,
      x: 0, y: 0,
      alive: true,
    });
  }

  return { allies, enemies, usedSlots };
}

function troopColor(type) {
  // cores simples por tipo (você pode alterar depois)
  if (type === "WARRIOR") return "#4aa3ff";
  if (type === "ARCHER")  return "#5dff8a";
  return "#ffd24a";
}

function beginBattleAgainstMonster(n) {
  // sai de mover se estiver ativo (evita estados estranhos)
  if (state.ui.move?.active) exitMoveMode();

  const data = buildBattleFromMonsterNode(n);
  if (!data) {
    log(`Você não tem tropas prontas no Nó ${n.id} para atacar.`, "warn");
    updateHUD();
    return;
  }

  // decide e roda a batalha (resultado será o estado final da simulação)
  const result = simulateInstantBattle(data.allies, data.enemies);

  // ativa modo batalha (animação vai “encenar” o resultado)
  const B = state.ui.battle;
  B.active = true;
  B.nodeId = n.id;
  B.allies = data.allies;
  B.enemies = data.enemies;
  B.usedSlots = data.usedSlots.slice();
  B.t = 0;
  B.stepAcc = 0;
  B.done = false;
  B.result = result;
  B.msg = "";
  B.events = result.events || [];
  B.eventIdx = 0;
  B.applied = false;
  B.showContinue = false;
  B.continueRect = null;
  // posiciona unidades (esquerda = aliados, direita = inimigos)
  layoutBattleUnits();

  // HUD não deve sumir: mantém seleção no nó
  state.selection.baseSelected = false;
  state.selection.slotIdx = null;
  state.selection.outpostSlot = null;
  state.selection.nodeId = n.id;
  updateHUD();
}

function layoutBattleUnits() {
  const B = state.ui.battle;

  // área “virtual” do canvas
  const w = canvas.width, h = canvas.height;
  const leftX = w * 0.25;
  const rightX = w * 0.75;

  // aliados em coluna
  const aN = B.allies.length;
  for (let i = 0; i < aN; i++) {
    const u = B.allies[i];
    u.x = leftX;
    u.y = h * 0.25 + (i + 1) * (h * 0.5 / (aN + 1));
  }

  // inimigos em coluna
  const eN = B.enemies.length;
  for (let i = 0; i < eN; i++) {
    const u = B.enemies[i];
    u.x = rightX;
    u.y = h * 0.25 + (i + 1) * (h * 0.5 / (eN + 1));
  }
}

function simulateInstantBattle(allies, enemies) {
  const A = allies.map(u => ({ ...u, hp: u.maxHp, alive: true }));
  const E = enemies.map(u => ({ ...u, hp: u.maxHp, alive: true }));

  const events = []; // ✅ replay

  function firstAliveIndex(arr) {
    for (let i = 0; i < arr.length; i++) if (arr[i].alive) return i;
    return -1;
  }
  function aliveCount(arr) { return arr.reduce((s,x)=>s+(x.alive?1:0),0); }

  while (aliveCount(A) > 0 && aliveCount(E) > 0) {
    // aliados atacam
    for (let ai = 0; ai < A.length; ai++) {
      const u = A[ai];
      if (!u.alive) continue;

      const ti = firstAliveIndex(E);
      if (ti === -1) break;

      const t = E[ti];
      const dmg = Math.max(1, u.atk);

      // aplica
      t.hp -= dmg;
      if (t.hp <= 0) { t.hp = 0; t.alive = false; }

      // registra evento
      events.push({ side: "A", attacker: ai, target: ti, dmg });
    }
    if (aliveCount(E) === 0) break;

    // inimigos atacam
    for (let ei = 0; ei < E.length; ei++) {
      const u = E[ei];
      if (!u.alive) continue;

      const ti = firstAliveIndex(A);
      if (ti === -1) break;

      const t = A[ti];
      const dmg = Math.max(1, u.atk);

      t.hp -= dmg;
      if (t.hp <= 0) { t.hp = 0; t.alive = false; }

      events.push({ side: "E", attacker: ei, target: ti, dmg });
    }
  }

  const win = aliveCount(A) > 0 && aliveCount(E) === 0;

  const survivors = A
    .filter(x => x.alive)
    .map(x => ({ slotIdx: x.slotIdx, type: x.type }));

  return { win, survivors, events };
}

function updateBattleAnim() {
  const B = state.ui.battle;
  if (!B.active || B.done) return;

  // avanço do tempo
  B.t += 1 / 60; // aproximado (loop é requestAnimationFrame)
  B.stepAcc += (1000 / 60);

  // a cada stepMs, aplicamos 1 “rodada visual” seguindo o RESULTADO pré-decidido
  while (B.stepAcc >= B.stepMs && !B.done) {
    B.stepAcc -= B.stepMs;
    battleVisualStep();
  }
}

function battleVisualStep() {
  const B = state.ui.battle;

  // acabou replay?
  if (B.eventIdx >= B.events.length) {
    // encerra visualmente (não sai ainda)
    finishBattleScreen();
    return;
  }

  const ev = B.events[B.eventIdx++];
  if (ev.side === "A") {
    const a = B.allies[ev.attacker];
    const t = B.enemies[ev.target];
    if (a?.alive && t?.alive) {
      // aplica dano VISUAL em passos menores (mais tempo)
      applyVisualDamage(t, ev.dmg);
      // pequeno “lunge” para dar sensação de impacto
      a._lunge = 1.0;
    }
  } else {
    const a = B.enemies[ev.attacker];
    const t = B.allies[ev.target];
    if (a?.alive && t?.alive) {
      applyVisualDamage(t, ev.dmg);
      a._lunge = 1.0;
    }
  }
}

function applyVisualDamage(target, dmg) {
  // tira HP aos poucos para ficar mais emocionante
  const chunks = Math.max(1, Math.min(4, dmg)); // 1 a 4 “micro-passos”
  target.hp -= dmg;
  if (target.hp <= 0) {
    target.hp = 0;
    target.alive = false;
    target._fade = 1.0; // para animar sumindo
  } else {
    target._hit = 1.0; // flash de dano
  }
}

function finishBattleScreen() {
  const B = state.ui.battle;

  // aplica o resultado no MUNDO uma única vez,
  // mas mantém a tela de batalha aberta até clicar CONTINUAR.
  if (!B.applied) {
    endBattleApplyResult();  // aplica vitória/derrota, mas NÃO deve desligar battle.active agora (ver passo 5)
    B.applied = true;
  }

  B.done = true;
  B.showContinue = true;
}

function endBattleApplyResult() {
  const B = state.ui.battle;
  if (B.applied) return; // ✅ evita aplicar 2x (novo comportamento)

  const nodeId = B.nodeId;
  const n = nodeById(nodeId);
  if (!n) {
    // fallback: só marca como aplicado e deixa a tela finalizar
    B.applied = true;
    updateHUD();
    return;
  }

  // remove TODAS as tropas usadas do nó…
  for (const idx of B.usedSlots) {
    n.troopSlots[idx] = null;
  }

  if (B.result?.win) {
    // …e adiciona de volta apenas sobreviventes (mantém status ready)
    for (const s of (B.result.survivors || [])) {
      const put = n.troopSlots.findIndex(x => !x);
      if (put === -1) break;
      n.troopSlots[put] = { type: s.type, status: "ready" };
    }

    // domina território
    n.kind = "OWNED";
    initOutpost(n);
    spawnBranchesFrom(n.id);

    log(`✅ Vitória! Você dominou o Nó ${n.id}.`, "good");
  } else {
    // derrota: monstros NÃO sofrem dano → reset hp
    if (typeof n.maxHp === "number") n.hp = n.maxHp;
    log(`❌ Derrota! Suas tropas foram derrotadas no Nó ${n.id}.`, "warn");
  }

  // ✅ importante: NÃO fecha a batalha aqui.
  // Quem fecha é o botão CONTINUAR (item 7)
  B.applied = true;

  // volta seleção para o nó (opcional, mas mantém consistência)
  state.selection.baseSelected = false;
  state.selection.slotIdx = null;
  state.selection.outpostSlot = null;
  state.selection.nodeId = n.id;

  updateHUD();
}

function drawBattleScene() {
  const B = state.ui.battle;

  // fundo
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#0d1117";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // título
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 18px system-ui, -apple-system, Segoe UI, Roboto, Arial";
  ctx.fillText("Batalha automática", 16, 28);

  // barras “HP total”
  const totalA = B.allies.reduce((s, u) => s + (u.alive ? u.hp : 0), 0);
  const maxA   = B.allies.reduce((s, u) => s + u.maxHp, 0);
  const totalE = B.enemies.reduce((s, u) => s + (u.alive ? u.hp : 0), 0);
  const maxE   = B.enemies.reduce((s, u) => s + u.maxHp, 0);

  drawHpBar(16, 44, 240, 12, totalA, maxA, "#4aa3ff", "Tropas");
  drawHpBar(canvas.width - 256, 44, 240, 12, totalE, maxE, "#ff5d5d", "Monstros");

  // linha do “encontro”
  ctx.strokeStyle = "rgba(255,255,255,.18)";
  ctx.beginPath();
  ctx.moveTo(canvas.width / 2, 80);
  ctx.lineTo(canvas.width / 2, canvas.height - 90);
  ctx.stroke();

  // desenha unidades (bolinhas = aliados)
  for (const u of B.allies) {
    if (!u.alive) continue;

    // movimento leve até o centro
    const tx = canvas.width * 0.48;
    u.x += (tx - u.x) * 0.06;

    // efeito simples de “impacto” (se existir _hit/_fade, não atrapalha)
    ctx.globalAlpha = u._fade ? Math.max(0, u._fade) : 1;

    ctx.fillStyle = u.color;
    ctx.beginPath();
    ctx.arc(u.x, u.y, 10, 0, Math.PI * 2);
    ctx.fill();

    // hp mini
    ctx.globalAlpha = 1;
    drawMiniHp(u.x - 12, u.y + 14, 24, 4, u.hp, u.maxHp, u.color);
  }

  // quadrados = inimigos
  for (const u of B.enemies) {
    if (!u.alive) continue;

    const tx = canvas.width * 0.52;
    u.x += (tx - u.x) * 0.06;

    ctx.globalAlpha = u._fade ? Math.max(0, u._fade) : 1;

    ctx.fillStyle = "#ff5d5d";
    ctx.fillRect(u.x - 10, u.y - 10, 20, 20);

    ctx.globalAlpha = 1;
    drawMiniHp(u.x - 12, u.y + 14, 24, 4, u.hp, u.maxHp, "#ff5d5d");
  }

  // rodapé: status ou fim + botão
  if (!B.done) {
    ctx.fillStyle = "rgba(255,255,255,.75)";
    ctx.font = "14px system-ui, -apple-system, Segoe UI, Roboto, Arial";
    ctx.fillText("A batalha está ocorrendo automaticamente...", 16, canvas.height - 26);

    // enquanto não terminou, não tem botão
    B.continueRect = null;
    return;
  }

  // terminou: VITÓRIA / DERROTA
  const win = !!B.result?.win;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 40px system-ui, -apple-system, Segoe UI, Roboto, Arial";
  ctx.fillText(win ? "VITÓRIA" : "DERROTA", canvas.width / 2, canvas.height / 2 - 70);

  // botão CONTINUAR (CENTRALIZADO)
  const bw = 220, bh = 54;
  const bx = (canvas.width - bw) / 2;
  const by = (canvas.height - bh) / 2 + 10;

  B.continueRect = { x: bx, y: by, w: bw, h: bh };

  ctx.fillStyle = "rgba(255,255,255,.12)";
  ctx.fillRect(bx, by, bw, bh);
  ctx.strokeStyle = "rgba(255,255,255,.28)";
  ctx.strokeRect(bx, by, bw, bh);

  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 18px system-ui, -apple-system, Segoe UI, Roboto, Arial";
  ctx.fillText("CONTINUAR", bx + bw / 2, by + bh / 2);

  // dica abaixo do botão
  ctx.fillStyle = "rgba(255,255,255,.65)";
  ctx.font = "12px system-ui, -apple-system, Segoe UI, Roboto, Arial";
  ctx.fillText("Clique para voltar ao mapa", canvas.width / 2, by + bh + 28);

  // restaura defaults para não afetar outros textos
  ctx.textAlign = "start";
  ctx.textBaseline = "alphabetic";
}

function drawHpBar(x, y, w, h, v, m, color, label) {
  ctx.fillStyle = "rgba(255,255,255,.12)";
  ctx.fillRect(x, y, w, h);
  const pct = (m <= 0) ? 0 : clamp(v/m, 0, 1);
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w * pct, h);

  ctx.fillStyle = "rgba(255,255,255,.85)";
  ctx.font = "12px system-ui, -apple-system, Segoe UI, Roboto, Arial";
  ctx.fillText(`${label}: ${Math.ceil(v)}/${Math.ceil(m)}`, x, y - 4);
}

function drawMiniHp(x, y, w, h, v, m, color) {
  ctx.fillStyle = "rgba(255,255,255,.18)";
  ctx.fillRect(x, y, w, h);
  const pct = (m <= 0) ? 0 : clamp(v/m, 0, 1);
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w * pct, h);
}

function attackSelectedMonsterDebug() {
  const id = state.selection.nodeId;
  if (id == null) return;

  const n = nodeById(id);
  if (!n || n.kind !== "MONSTER") return;

  // ✅ inicia batalha automática (resultado instantâneo + animação)
  beginBattleAgainstMonster(n);
}

/* ----------------- Input ----------------- */
canvas.addEventListener("contextmenu", (e) => e.preventDefault());

canvas.addEventListener("mousedown", (e) => {
  // ✅ Se está em batalha: só aceita clique no CONTINUAR quando terminado
  if (state?.ui?.battle?.active) {
    const B = state.ui.battle;

    if (B.done && B.continueRect) {
      const rect = canvas.getBoundingClientRect();
      const mx = (e.clientX - rect.left) * (canvas.width / rect.width);
      const my = (e.clientY - rect.top) * (canvas.height / rect.height);

      const r = B.continueRect;
      if (mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h) {
        // fecha batalha e volta pro mapa
        B.active = false;
        B.done = false;
        B.showContinue = false; // se você tiver esse flag
        B.continueRect = null;

        updateHUD();
      }
    }
    return;
  }

  const r = canvas.getBoundingClientRect();
  const sx = e.clientX - r.left;
  const sy = e.clientY - r.top;

  // pan (botão direito)
  if (e.button === 2) {
    state.input.rmbDown = true;
    state.input.lastMouse.x = sx;
    state.input.lastMouse.y = sy;
    return;
  }

  const w = screenToWorld(sx, sy);

  // 1) slot da BASE
  const slot = hitTestSlot(w.x, w.y);
  if (slot) {
    if (state.ui.move?.active) { setMoveDestination(state.world.baseNodeId); return; } // ✅ novo
    clearSelection();
    state.selection.baseSelected = true;
    state.selection.slotIdx = slot.idx;
    updateHUD();
    return;
  }

  // 2) clique no CASTELO (base)
  if (hitTestBase(w.x, w.y)) {
    if (state.ui.move?.active) { setMoveDestination(state.world.baseNodeId); return; } // ✅ novo
    clearSelection();
    state.selection.baseSelected = true;
    state.selection.slotIdx = null;
    updateHUD();
    return;
  }

  // 3) slot de SUB-BASE (território dominado)
  const os = hitTestOutpostSlot(w.x, w.y);
  if (os) {
    // se estiver em modo MOVER, clique em slot também define destino no nó dono da sub-base
    if (state.ui.move?.active) {
      setMoveDestination(os.nodeId);
      return;
    }

    clearSelection();
    state.selection.nodeId = os.nodeId;
    state.selection.outpostSlot = os;
    updateHUD();
    return;
  }

  // 4) nós (monstros/territórios)
  const node = hitTestNode(w.x, w.y);
  if (node) {
    if (state.ui.move?.active) {
      setMoveDestination(node.id);
      return;
    }

    clearSelection();
    state.selection.nodeId = node.id;
    updateHUD();
    return;
  }

  // Se estiver em modo MOVER, NÃO deixa o HUB sumir ao clicar em área inválida
  if (state.ui.move?.active) {
    log("Destino inválido. Clique em um nó/BASE válido para definir o destino, ou clique em Cancelar no HUB.", "warn");
    updateHUD();
    return;
  }

  clearSelection();
  updateHUD();
});

canvas.addEventListener("mousemove", (e) => {
  if ((state?.ui?.battle?.active)) return;
  if (!state.input.rmbDown) return;

  const r = canvas.getBoundingClientRect();
  const sx = e.clientX - r.left;
  const sy = e.clientY - r.top;

  const dx = sx - state.input.lastMouse.x;
  const dy = sy - state.input.lastMouse.y;

  state.camera.x -= dx / state.camera.zoom;
  state.camera.y -= dy / state.camera.zoom;

  state.input.lastMouse.x = sx;
  state.input.lastMouse.y = sy;
});

window.addEventListener("mouseup", (e) => {
  if (state?.ui?.battle?.active) return;
  if (e.button === 2) state.input.rmbDown = false;
});

// zoom
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

  state.camera.x += (before.x - after.x);
  state.camera.y += (before.y - after.y);

}, { passive: false });

/* Delegations */
el.buildPanel.addEventListener("click", (e) => {
  if (!state) return;

  // 0) toggle de seleção de tropas no modo mover (agora por NÓ, não por Quartel)
  const mv = e.target.closest("button[data-move-toggle]");
  if (mv) {
    const idx = Number(mv.getAttribute("data-move-toggle"));
    const m = state.ui.move;

    if (!m?.active || m.fromNodeId == null) return;

    const from = nodeById(m.fromNodeId);
    if (!from) return;
    ensureNodeTroopSlots(from);

    if (!(m.selectedSlots instanceof Set)) m.selectedSlots = new Set();

    if (idx < 0 || idx >= from.troopSlots.length) return;
    const t = from.troopSlots[idx];
    if (!t || t.status !== "ready") return;

    if (m.selectedSlots.has(idx)) m.selectedSlots.delete(idx);
    else m.selectedSlots.add(idx);

    updateHUD();
    return;
  }

  // 1) ações
  const act = e.target.closest("button[data-action]");
  if (act) {
    const a = act.getAttribute("data-action");

    if (a === "attack") attackSelectedMonsterDebug();

    if (a === "cancel-train-pick") {
      state.ui.trainPick = null;
      updateHUD();
    }

    if (a === "move") {
      // Base (castelo centro)
      if (state.selection.baseSelected && state.selection.slotIdx == null && state.selection.nodeId == null) {
        enterMoveMode(state.world.baseNodeId);
        return;
      }

      // Território dominado (centro do nó)
      if (state.selection.nodeId != null && !state.selection.outpostSlot) {
        const n = nodeById(state.selection.nodeId);
        if (n && n.kind === "OWNED") {
          enterMoveMode(n.id);
        }
      }
      return;
    }

    if (a === "confirm-move") {
      confirmMoveOrder();
    }

    if (a === "cancel-move") {
      exitMoveMode();
    }

    return;
  }

  // 2) abrir treino (fora do modo mover)
  const pick = e.target.closest("button[data-troop-pick]");
  if (pick) {
    if (state.ui.move?.active) return;
    state.ui.trainPick = Number(pick.getAttribute("data-troop-pick"));
    updateHUD();
    return;
  }

  // 3) treinar (fora do modo mover)
  const train = e.target.closest("button[data-train]");
  if (train) {
    if (state.ui.move?.active) return;
    const troopType = train.getAttribute("data-train");
    const troopSlotIndex = Number(train.getAttribute("data-troop-slot"));
    const barracksSlotIdx = state.selection.slotIdx;
    if (barracksSlotIdx != null) {
      trainTroopOnBarracks(barracksSlotIdx, troopType, troopSlotIndex);
    }
    return;
  }

  // 4) construir
  const btn = e.target.closest("button[data-build]");
  if (!btn) return;
  const type = btn.getAttribute("data-build");
  tryBuild(type);
});

/* Buttons */
el.btnNew.addEventListener("click", startNewGame);
el.btnMenu.addEventListener("click", () => { el.menuOverlay.style.display = "flex"; });
el.btnEndTurn.addEventListener("click", endTurn);

/* ----------------- New Game ----------------- */
function startNewGame() {
  state = {
    turn: 1,
    resources: { ...CFG.startResources },
    camera: { x: 0, y: 0, zoom: 1.0 },
    base: { pos: { x: 0, y: 0 }, slots: [] },
    selection: { baseSelected: false, slotIdx: null, nodeId: null, outpostSlot: null },
    input: { rmbDown: false, lastMouse: { x: 0, y: 0 } },
    world: null,
    ui: {
      trainPick: null,
      move: { active: false, fromNodeId: null, selectedSlots: null, order: null },

      // ✅ novo: modo batalha (overlay 2D)
      battle: {
         
         active: false,
         nodeId: null,
         allies: [],
         enemies: [],
         usedSlots: [],        // índices das troopSlots usadas no ataque
         t: 0,
         stepAcc: 0,
         stepMs: 140,          // velocidade “dos golpes”
         done: false,
         result: null,         // { win: true/false, survivors: [...] }
         msg: "",

         events: [],
         eventIdx: 0,
         applied: false,
         showContinue: false,
         continueRect: null,
      },
    },
  };

  state.base.slots = computeSlots();
  worldInit();
  spawnFirstMonster();

  el.menuOverlay.style.display = "none";
  el.log.innerHTML = "";
  log("Novo jogo iniciado (mapa procedural).", "good");
  log("Dica: clique no monstro (nó vermelho) e use Atacar para lutar e expandir.", "warn");
  updateHUD();
}

/* ----------------- Render ----------------- */
function drawBackground(rw, rh) {
  // GRAMA (fica sempre embaixo)
  ctx.fillStyle = "#66b96a"; // verde claro
  ctx.fillRect(0, 0, rw, rh);

  // textura leve (opcional, mas ajuda a não ficar “chapado”)
  ctx.globalAlpha = 0.10;
  for (let i = 0; i < 180; i++) {
    const x = (i * 97) % rw;
    const y = (i * 53) % rh;
    ctx.fillStyle = (i % 2 === 0) ? "#5aa85e" : "#73c976";
    ctx.fillRect(x, y, 16, 12);
  }
  ctx.globalAlpha = 1;
}

function drawFog(rw, rh) {
  if (!state || !state.world) return;

  // camada offscreen principal (fog)
  if (!drawFog._layer) {
    drawFog._layer = document.createElement("canvas");
    drawFog._ctx = drawFog._layer.getContext("2d");
  }
  const layer = drawFog._layer;
  const fctx = drawFog._ctx;

  // NOVO: máscara (união das áreas reveladas)
  if (!drawFog._mask) {
    drawFog._mask = document.createElement("canvas");
    drawFog._mctx = drawFog._mask.getContext("2d");
  }
  const mask = drawFog._mask;
  const mctx = drawFog._mctx;

  // DPR igual ao seu código
  const dpr = canvas.width / rw;

  // mantém layer no tamanho do canvas principal (pixels)
  if (layer.width !== canvas.width || layer.height !== canvas.height) {
    layer.width = canvas.width;
    layer.height = canvas.height;
  }

  // máscara em resolução reduzida (performance + borda mais limpa)
  const SCALE = 0.40; // 0.35..0.55 (ajuste se quiser)
  const mw = Math.max(1, Math.floor(canvas.width * SCALE));
  const mh = Math.max(1, Math.floor(canvas.height * SCALE));
  if (mask.width !== mw || mask.height !== mh) {
    mask.width = mw;
    mask.height = mh;
  }

  // ===== 1) Fontes de revelação (base + OWNED) =====
  const base = nodeById(state.world.baseNodeId);
  const sources = [];
  sources.push({ x: base.x, y: base.y, radius: CFG.fog.baseVision });

  for (const n of state.world.nodes.values()) {
    if (n.kind === "OWNED") {
      sources.push({ x: n.x, y: n.y, radius: CFG.fog.territoryVision });
    }
  }

  // ===== 2) Desenha a máscara como união BINÁRIA (sem gradiente) =====
  mctx.setTransform(dpr * SCALE, 0, 0, dpr * SCALE, 0, 0);
  mctx.clearRect(0, 0, rw, rh);
  mctx.globalCompositeOperation = "source-over";
  mctx.fillStyle = "rgba(0,0,0,1)";

  for (const s of sources) {
    const p = worldToScreen(s.x, s.y);
    const R = s.radius * state.camera.zoom;
    mctx.beginPath();
    mctx.arc(p.x, p.y, R, 0, Math.PI * 2);
    mctx.fill();
  }

  // ===== 3) Renderiza fog na layer =====
  fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  fctx.clearRect(0, 0, rw, rh);

  // pinta a névoa (cinza)
  fctx.globalCompositeOperation = "source-over";
  fctx.globalAlpha = 1;
  fctx.fillStyle = "rgba(170,170,170,0.80)";
  fctx.fillRect(0, 0, rw, rh);

  // fura UMA VEZ usando a máscara com blur (sem acumular em overlaps)
  fctx.save();
  fctx.globalCompositeOperation = "destination-out";
  fctx.imageSmoothingEnabled = true;

  const blurPx = Math.max(10, 18 * state.camera.zoom);
  fctx.filter = "blur(" + blurPx + "px)";
  fctx.drawImage(mask, 0, 0, mask.width, mask.height, 0, 0, rw, rh);
  fctx.filter = "none";

  fctx.restore();

  // ===== 4) Desenha fog por cima do mundo =====
  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.drawImage(layer, 0, 0, layer.width, layer.height, 0, 0, rw, rh);
  ctx.restore();
}

function drawWorld() {
  const r = canvas.getBoundingClientRect();
  const rw = r.width, rh = r.height;

  // GARANTE que o canvas vai desenhar normalmente (não “apagar”)
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;

  drawBackground(rw, rh);

  if (!state) return;

  // 1) caminhos
  ctx.lineCap = "round";
  ctx.strokeStyle = "rgba(140,105,70,0.85)";
  ctx.lineWidth = 10 * state.camera.zoom;

  for (const e of state.world.edges) {
    const a = nodeById(e.a);
    const b = nodeById(e.b);
    if (!a?.discovered || !b?.discovered) continue;
    const pa = worldToScreen(a.x, a.y);
    const pb = worldToScreen(b.x, b.y);
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  }

  // 2) nós
  for (const n of state.world.nodes.values()) {
    if (!n.discovered) continue;
    if (n.id === state.world.baseNodeId) continue;

    const p = worldToScreen(n.x, n.y);
    const isSel = (state.selection.nodeId === n.id) && !state.selection.outpostSlot;

    if (n.kind === "MONSTER") {
      const R = 16 * state.camera.zoom;
      ctx.beginPath();
      ctx.arc(p.x, p.y, R, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(220,70,70,0.90)";
      ctx.fill();
      ctx.lineWidth = isSel ? 4 : 2;
      ctx.strokeStyle = isSel ? "rgba(71,209,140,0.95)" : "rgba(255,255,255,0.35)";
      ctx.stroke();

      ctx.font = `${Math.max(11, 12 * state.camera.zoom)}px system-ui`;
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText("Monstro", p.x, p.y + R + 6);
    }

    if (n.kind === "OWNED") {
      const ts = 18 * state.camera.zoom;

      ctx.fillStyle = "rgba(190,190,190,0.88)";
      ctx.strokeStyle = isSel ? "rgba(71,209,140,0.95)" : "rgba(60,60,60,0.65)";
      ctx.lineWidth = isSel ? 4 : 2;
      ctx.fillRect(p.x - ts/2, p.y - ts/2, ts, ts);
      ctx.strokeRect(p.x - ts/2, p.y - ts/2, ts, ts);

      // label
      ctx.font = `${Math.max(11, 12 * state.camera.zoom)}px system-ui`;
      ctx.fillStyle = "rgba(30,30,30,0.85)";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText("Território", p.x, p.y + ts/2 + 6);

      // slots da sub-base (3)
      if (n.buildSlots) {
        const ss = CFG.slot.size * state.camera.zoom;

        for (const slot of n.buildSlots) {
          const sp = worldToScreen(slot.x, slot.y);
          const sel =
            state.selection.outpostSlot &&
            state.selection.outpostSlot.nodeId === n.id &&
            state.selection.outpostSlot.idx === slot.idx;

          ctx.fillStyle = "rgba(255,255,255,0.22)";
          ctx.strokeStyle = sel ? "rgba(71,209,140,0.95)" : "rgba(255,255,255,0.32)";
          ctx.lineWidth = sel ? 3 : 2;

          ctx.fillRect(sp.x - ss/2, sp.y - ss/2, ss, ss);
          ctx.strokeRect(sp.x - ss/2, sp.y - ss/2, ss, ss);

          if (slot.building) {
            const bld = slot.building;
            const def = CFG.buildings[bld.type];

            ctx.fillStyle = "rgba(0,0,0,0.35)";
            ctx.fillRect(sp.x - ss/2, sp.y - ss/2, ss, ss);

            ctx.font = `${Math.max(12, 14 * state.camera.zoom)}px system-ui`;
            ctx.fillStyle = "rgba(255,255,255,0.92)";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(def.icon, sp.x, sp.y);

            if (!bld.built) {
              ctx.font = `${Math.max(10, 11 * state.camera.zoom)}px system-ui`;
              ctx.fillStyle = "rgba(255,204,102,0.95)";
              ctx.fillText(`${bld.remainingTurns}T`, sp.x, sp.y + ss*0.38);
            }
          }
        }
      }
    }
  }

  // 3) base (castelo)
  const base = nodeById(state.world.baseNodeId) || state.base.pos;
  const castle = worldToScreen(base.x, base.y);
  const cs = CFG.base.size * state.camera.zoom;

  ctx.fillStyle = "rgba(190,190,190,0.90)";
  ctx.strokeStyle = state.selection.baseSelected ? "rgba(71,209,140,0.95)" : "rgba(60,60,60,0.7)";
  ctx.lineWidth = state.selection.baseSelected ? 4 : 2;
  ctx.fillRect(castle.x - cs/2, castle.y - cs/2, cs, cs);
  ctx.strokeRect(castle.x - cs/2, castle.y - cs/2, cs, cs);

  // detalhe “crenel”
  const cren = cs * 0.18;
  ctx.fillStyle = "rgba(120,120,120,0.65)";
  for (let i = -2; i <= 2; i++) {
    ctx.fillRect(
      castle.x + i*cren*1.2 - cren/2,
      castle.y - cs/2 - cren*0.6,
      cren,
      cren*0.8
    );
  }

  // 4) slots da base
  const ss = CFG.slot.size * state.camera.zoom;
  for (const slot of state.base.slots) {
    const p = worldToScreen(slot.x, slot.y);
    const isSelected = state.selection.slotIdx === slot.idx;
    const bld = slot.building;

    ctx.fillStyle = "rgba(255,255,255,0.22)";
    ctx.strokeStyle = isSelected ? "rgba(71,209,140,0.95)" : "rgba(255,255,255,0.32)";
    ctx.lineWidth = isSelected ? 3 : 2;

    ctx.fillRect(p.x - ss/2, p.y - ss/2, ss, ss);
    ctx.strokeRect(p.x - ss/2, p.y - ss/2, ss, ss);

    if (bld) {
      const def = CFG.buildings[bld.type];
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fillRect(p.x - ss/2, p.y - ss/2, ss, ss);

      ctx.font = `${Math.max(12, 14 * state.camera.zoom)}px system-ui`;
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(def.icon, p.x, p.y);

      if (!bld.built) {
        ctx.font = `${Math.max(10, 11 * state.camera.zoom)}px system-ui`;
        ctx.fillStyle = "rgba(255,204,102,0.95)";
        ctx.fillText(`${bld.remainingTurns}T`, p.x, p.y + ss*0.38);
      }
    }
  }

  // 5) fog por cima
  drawFog(rw, rh);
}

function loop() {
  requestAnimationFrame(loop);
  
  if (state?.ui?.battle?.active) {
     updateBattleAnim();
     drawBattleScene();
     return;
  }

  drawWorld();
}
loop();

/* Initial UI */
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
