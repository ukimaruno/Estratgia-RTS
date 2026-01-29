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
    WARRIOR: { name: "Guerreiro", cost: { meat: 25 }, trainTurns: 1, icon: "🗡️" },
    ARCHER:  { name: "Arqueiro",  cost: { meat: 30 }, trainTurns: 1, icon: "🏹" },
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
  updateHUD();
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
      el.selectionInfo.innerHTML = `<b>Monstros</b><div class="muted">Nó ${n.id} — HP ${n.hp}. Selecione e clique em <b>Atacar (debug)</b>.</div>`;
    } else if (n.kind === "OWNED") {
      el.selectionInfo.innerHTML = `<b>Território dominado</b><div class="muted">Nó ${n.id}. Em breve: construir fora da base.</div>`;
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
  // 1) Se selecionou monstro -> ações do nó
  if (state.selection.nodeId != null) {
    const n = nodeById(state.selection.nodeId);

    if (n.kind === "MONSTER") {
      const readyHere = countReadyTroopsAtNode(n.id);

      // (Opcional, mas recomendado) — feedback de tropas que já estão a caminho desse nó
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
        <button class="btn wide primary" data-action="attack">Atacar (debug)</button>
        <div style="height:10px"></div>

        <div class="muted">Tropas prontas no território: <b>${readyHere}</b></div>
        <div style="height:6px"></div>
        ${incomingLine}
      `;
      return;
    }

    // Território já dominado (por enquanto sem ações além de info)
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
    el.buildPanel.innerHTML = `
      <div class="muted">Território dominado.</div>
      <div style="height:10px"></div>
      <div class="muted">Tropas prontas no território: <b>${readyHere}</b></div>
      <div style="height:6px"></div>
      ${incomingLine}
      <div style="height:10px"></div>
      <div class="muted">Em breve: construir fora da base.</div>
    `;
    return;
  }
  // 1.5) Se selecionou um slot de SUB-BASE (território dominado)
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
        <div class="muted">${b.built ? "Concluído ✅" : `Em construção… faltam <b>${b.remainingTurns}</b> turno(s).`}</div>
      `;
      return;
    }

    // slot vazio: mesmos botões da base (reusa tryBuild)
    const buttons = Object.keys(CFG.buildings).map((type) => {
      const def = CFG.buildings[type];
      const costTxt = fmtCost(def.cost);
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
      <div class="muted">Sub-base — Slot <b>${slot.idx + 1}</b> selecionado. Escolha uma construção:</div>
      <div style="height:10px"></div>
      ${buttons}
    `;
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

  // NOVO
  if (el.resPop) {
    el.resPop.textContent = `${getPopulationUsed()}/${getPopulationCap()}`;
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
function attackSelectedMonsterDebug() {
  const id = state.selection.nodeId;
  if (id == null) return;
  const n = nodeById(id);
  if (!n || n.kind !== "MONSTER") return;

  // derrota imediata (debug)
  n.kind = "OWNED";
  initOutpost(n); // <-- cria os 3 slots da sub-base
  log(`Território dominado! Nó ${n.id} agora é seu.`, "good");

  // gera novos caminhos/monstros proceduralmente a partir daqui
  spawnBranchesFrom(n.id);
  updateHUD();
}

/* ----------------- Input ----------------- */
canvas.addEventListener("contextmenu", (e) => e.preventDefault());

canvas.addEventListener("mousedown", (e) => {
  if (!state) return;

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
    clearSelection();
    state.selection.baseSelected = true;
    state.selection.slotIdx = slot.idx;
    updateHUD();
    return;
  }

  // 2) clique no CASTELO (base)
  if (hitTestBase(w.x, w.y)) {
    clearSelection();
    state.selection.baseSelected = true;
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

  clearSelection();
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

  state.camera.x -= dx / state.camera.zoom;
  state.camera.y -= dy / state.camera.zoom;

  state.input.lastMouse.x = sx;
  state.input.lastMouse.y = sy;
});

window.addEventListener("mouseup", (e) => {
  if (!state) return;
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
      // Agora: MOVER fica na BASE central (e futuramente nas sub-bases).
      if (state.selection.baseSelected && state.selection.slotIdx == null && state.selection.nodeId == null) {
        enterMoveMode(state.world.baseNodeId);
      }
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
    },
  };

  state.base.slots = computeSlots();
  worldInit();
  spawnFirstMonster();

  el.menuOverlay.style.display = "none";
  el.log.innerHTML = "";
  log("Novo jogo iniciado (mapa procedural).", "good");
  log("Dica: clique no monstro (nó vermelho) e use Atacar (debug) para ver ramificações.", "warn");
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
