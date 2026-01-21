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
  selectionInfo: document.getElementById("selectionInfo"),
  buildPanel: document.getElementById("buildPanel"),
};

let state = null;

function resize() {
  const r = canvas.getBoundingClientRect();
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.floor(r.width * dpr);
  canvas.height = Math.floor(r.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", resize);
resize();

function newGame() {
  state = {
    turn: 1,
    resources: { wood: 0, stone: 0, meat: 0 },
  };
  el.menuOverlay.style.display = "none";
  draw();
}

function draw() {
  const r = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, r.width, r.height);

  // fundo verde simples (teste visual)
  ctx.fillStyle = "#2a3a2a";
  ctx.fillRect(0, 0, r.width, r.height);

  // texto de teste
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.font = "16px system-ui";
  ctx.fillText(`Jogo iniciado. Turno: ${state?.turn ?? "-"}`, 20, 30);

  // topbar
  el.resWood.textContent = Math.floor(state?.resources.wood ?? 0);
  el.resStone.textContent = Math.floor(state?.resources.stone ?? 0);
  el.resMeat.textContent = Math.floor(state?.resources.meat ?? 0);
}

el.btnNew.addEventListener("click", newGame);
el.btnMenu.addEventListener("click", () => { el.menuOverlay.style.display = "flex"; });
el.btnEndTurn.addEventListener("click", () => {
  if (!state) return;
  state.turn++;
  draw();
});

