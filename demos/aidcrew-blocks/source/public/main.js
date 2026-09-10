import * as THREE from "three";

const canvas = document.getElementById("scene");
const stateEl = document.getElementById("state");
const overlay = document.getElementById("overlay");
const joinForm = document.getElementById("join-form");
const nickInput = document.getElementById("nickname");
const crosshair = document.getElementById("crosshair");
const hotbarEl = document.getElementById("hotbar");
const hintEl = document.getElementById("hint");
const toastEl = document.getElementById("toast");
const muteBtn = document.getElementById("mute-btn");

stateEl.textContent = "Building world…";

// --- renderer / scene ---
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

const scene = new THREE.Scene();
const SKY = 0x39c5cf;
scene.background = new THREE.Color(SKY);
scene.fog = new THREE.Fog(SKY, 45, 160);

const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.1, 400);

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

scene.add(new THREE.HemisphereLight(0xbdf3ff, 0x3a5a3a, 0.9));
const sun = new THREE.DirectionalLight(0xffe8b8, 1.6); // warm late-afternoon sun
sun.position.set(60, 50, 25);
scene.add(sun);

// --- voxel-style clouds: small opaque clusters of boxes, kept far outside the scenic orbit path ---
const clouds = new THREE.Group();
const cloudMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
const cloudBox = new THREE.BoxGeometry(1, 1, 1);
// clusters placed at radius 75-115 (orbit is 55) and height 44-58 (orbit is 34) so they never cross the camera
for (let i = 0; i < 14; i++) {
  const cluster = new THREE.Group();
  const ang = (i / 14) * Math.PI * 2 + Math.random() * 0.3;
  const r = 75 + Math.random() * 40;
  cluster.position.set(Math.cos(ang) * r, 44 + Math.random() * 14, Math.sin(ang) * r);
  const puffs = 3 + Math.floor(Math.random() * 3);
  for (let p = 0; p < puffs; p++) {
    const b = new THREE.Mesh(cloudBox, cloudMat);
    b.scale.set(2 + Math.random() * 2, 1 + Math.random(), 2 + Math.random() * 2);
    b.position.set((Math.random() - 0.5) * 5, Math.random() * 1.5, (Math.random() - 0.5) * 5);
    cluster.add(b);
  }
  clouds.add(cluster);
}
scene.add(clouds);

// --- seeded deterministic terrain (shared module, must match server) ---
import { generateTerrain, FRAGMENT_SPOTS } from "../shared/terrain.js";

const PALETTE = {
  grass: 0x6ab04c, stone: 0x8d8d8d, wood: 0x8a5a2b, sand: 0xd8c47a, dirt: 0x7a5230,
};
const BLOCKS = ["grass", "stone", "wood", "sand"];
const BLOCK_COLORS = Object.fromEntries(Object.entries(PALETTE).map(([k, v]) => ([k, "#" + v.toString(16).padStart(6, "0")])));

// hotbar UI
let selected = 0;
function buildHotbar() {
  hotbarEl.innerHTML = "";
  BLOCKS.forEach((name, i) => {
    const s = document.createElement("div");
    s.className = "slot" + (i === selected ? " active" : "");
    s.style.background = BLOCK_COLORS[name];
    s.textContent = String(i + 1);
    hotbarEl.appendChild(s);
  });
}
buildHotbar();

const { world, key } = generateTerrain();

const BEACON_POS = new THREE.Vector3(0, 3, 0);
const beacon = new THREE.Mesh(
  new THREE.CylinderGeometry(1.2, 1.6, 6, 12),
  new THREE.MeshStandardMaterial({ color: 0x2ec4b6, emissive: 0x116b63, emissiveIntensity: 0.6 })
);
beacon.position.set(BEACON_POS.x, BEACON_POS.y + 3, BEACON_POS.z);
scene.add(beacon);
// --- M8: Light the Beacon objective ---
const OBJECTIVE = FRAGMENT_SPOTS.length;
let collectedFragments = new Set(); // idx collected (client mirror of server truth)
let beaconLit = false;
const SKY_LIT = 0xffb37a;
const fragmentMeshes = [];
const fragmentGeoms = [];
for (const spot of FRAGMENT_SPOTS) {
  const m = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.45),
    new THREE.MeshStandardMaterial({ color: 0x9b5cff, emissive: 0x6a0dad, emissiveIntensity: 1.2 })
  );
  m.position.set(spot.x + 0.5, spot.y + 0.5, spot.z + 0.5);
  scene.add(m);
  fragmentMeshes.push(m);
  fragmentGeoms.push(new THREE.CylinderGeometry(0.7, 0.7, 2.2, 8, 1, true));
  const beam = new THREE.Mesh(fragmentGeoms[fragmentGeoms.length - 1],
    new THREE.MeshBasicMaterial({ color: 0x9b5cff, transparent: true, opacity: 0.18, side: THREE.DoubleSide }));
  beam.position.set(spot.x + 0.5, spot.y + 1.6, spot.z + 0.5);
  scene.add(beam);
  fragmentMeshes.push(beam); // hide beam together with core
  // beacon frame around the beacon post (visual landmark marker)
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(1.9, 0.12, 8, 24),
    new THREE.MeshStandardMaterial({ color: 0x9b5cff, emissive: 0x3d1a66, emissiveIntensity: 0.7 })
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.set(BEACON_POS.x, BEACON_POS.y + 1.2, BEACON_POS.z);
  scene.add(ring);
}
const objectiveHud = document.createElement("div");
objectiveHud.id = "objective";
objectiveHud.textContent = `Fragments 0/${OBJECTIVE}`;
objectiveHud.style.cssText = "position:fixed;top:10px;left:50%;transform:translateX(-50%);background:rgba(10,15,25,.7);color:#ffd27d;padding:6px 14px;border-radius:8px;font:600 14px system-ui;z-index:5;display:none";
document.body.appendChild(objectiveHud);
function setObjectiveHud() {
  objectiveHud.textContent = beaconLit ? "🔥 Beacon lit!" : `Fragments ${collectedFragments.size}/${OBJECTIVE}`;
  objectiveHud.style.display = joined ? "block" : "none";
}
let skyLerpT = 0;
function applyBeaconLitFX() {
  beaconLit = true;
  beacon.material.emissiveIntensity = 2.5;
  const pos = new THREE.Vector3(BEACON_POS.x, BEACON_POS.y + 6, BEACON_POS.z);
  spawnParticles(pos, 0xffd27d);
  spawnParticles(pos, 0xff7733);
  spawnParticles(pos, 0xffffff);
  setObjectiveHud();
}
function nearFragmentSpot() {
  // returns idx of uncollected fragment within pickup range, or -1
  for (let i = 0; i < FRAGMENT_SPOTS.length; i++) {
    if (collectedFragments.has(i)) continue;
    const s = FRAGMENT_SPOTS[i];
    if (player.pos.distanceTo(new THREE.Vector3(s.x + 0.5, s.y + 0.5, s.z + 0.5)) < 2.5) return i;
  }
  return -1;
}

// --- M-polish: small landmark details at each fragment isle ---
function buildLandmarks() {
  const detailMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.9 });
  const woodMat = new THREE.MeshStandardMaterial({ color: 0x8a5a2b, roughness: 0.85 });
  FRAGMENT_SPOTS.forEach((s, i) => {
    if (i === 0) {
      // ruin: broken arch of two pillars + lintel
      const p1 = new THREE.Mesh(new THREE.BoxGeometry(0.6, 2.4, 0.6), detailMat);
      p1.position.set(s.x - 1.4, s.y - 1 + 1.2, s.z + 1.2);
      const p2 = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.6, 0.6), detailMat);
      p2.position.set(s.x + 1.4, s.y - 1 + 0.8, s.z + 1.2);
      const lintel = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.5, 0.7), detailMat);
      lintel.position.set(s.x, s.y - 1 + 2.6, s.z + 1.2);
      lintel.rotation.z = 0.08;
      scene.add(p1, p2, lintel);
    } else if (i === 1) {
      // satellite isle: antenna mast + dish
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 3, 6), woodMat);
      mast.position.set(s.x + 1.6, s.y - 1 + 1.5, s.z - 1.4);
      const dish = new THREE.Mesh(new THREE.SphereGeometry(0.7, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2.6), detailMat);
      dish.position.set(s.x + 1.6, s.y - 1 + 3.2, s.z - 1.4);
      dish.rotation.x = Math.PI / 1.5;
      scene.add(mast, dish);
    } else {
      // tree isle: small campfire of sticks + glowing ember
      const ember = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.25, 0),
        new THREE.MeshStandardMaterial({ color: 0xff7733, emissive: 0xff4400, emissiveIntensity: 1.5 })
      );
      ember.position.set(s.x - 1.6, s.y - 1 + 0.3, s.z + 1.5);
      scene.add(ember);
      for (let k = 0; k < 3; k++) {
        const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1, 5), woodMat);
        stick.position.set(s.x - 1.6, s.y - 1 + 0.4, s.z + 1.5);
        stick.rotation.set(0.9 * Math.cos(k * 2.1), k * 2.1, 0.9 * Math.sin(k * 2.1));
        scene.add(stick);
      }
    }
  });
}
buildLandmarks();

const beaconBase = new THREE.Mesh(
  new THREE.CylinderGeometry(2.2, 2.6, 1, 12),
  new THREE.MeshStandardMaterial({ color: 0x555a60 })
);
beaconBase.position.set(BEACON_POS.x, BEACON_POS.y + 0.5, BEACON_POS.z);
scene.add(beaconBase);

// --- instanced rendering ---
const geo = new THREE.BoxGeometry(1, 1, 1);
const typeMeshes = new Map();
function rebuild() {
  for (const m of typeMeshes.values()) { scene.remove(m); m.dispose(); }
  typeMeshes.clear();
  const perType = new Map();
  for (const [k, name] of world) {
    const [x, y, z] = k.split(",").map(Number);
    if (!perType.has(name)) perType.set(name, []);
    perType.get(name).push([x, y, z]);
  }
  for (const [name, list] of perType) {
    const mat = new THREE.MeshLambertMaterial({ color: PALETTE[name] });
    if (name === "grass") mat.color.set(0x6dbf55); // coherent grass tone under warm sun
    const inst = new THREE.InstancedMesh(geo, mat, list.length);
    const m4 = new THREE.Matrix4();
    list.forEach(([x, y, z], i) => {
      m4.makeTranslation(x + 0.5, y + 0.5, z + 0.5);
      inst.setMatrixAt(i, m4);
    });
    inst.instanceMatrix.needsUpdate = true;
    scene.add(inst);
    typeMeshes.set(name, inst);
  }
}
rebuild();
function applyEdit(action, x, y, z, block) {
  if (action === "place") world.set(key(x, y, z), block);
  else world.delete(key(x, y, z));
  rebuild();
}

// --- player state ---
const player = {
  pos: new THREE.Vector3(6, 12, 6),
  vel: new THREE.Vector3(),
  yaw: 0, pitch: 0,
  onGround: false,
  coyote: 0, jumpBuf: 0,
  W: 4.4, J: 8.5, G: 24,
};
const PLAYER_HW = 0.3, PLAYER_H = 1.7, EYE = 1.55;
const RESPAWN = new THREE.Vector3(6, 12, 6);

function spawnSafe() {
  // find a clear grass spawn near spawn island centre: top solid non-wood block with 3 blocks of open sky above
  let best = null;
  for (let x = 4; x <= 9; x++) for (let z = 4; z <= 9; z++) {
    for (let y = 20; y >= -10; y--) {
      if (!world.has(key(x, y, z))) continue;
      const mat = world.get(key(x, y, z));
      // skip tree canopy tops; require clear air above so we never spawn under/inside leaves
      const canopy = world.has(key(x, y + 1, z)) || world.has(key(x, y + 2, z)) || world.has(key(x, y + 3, z));
      if (!canopy && mat === "grass" && (!best || y + 1 > best.y)) {
        best = new THREE.Vector3(x + 0.5, y + 1, z + 0.5);
      }
      break;
    }
  }
  if (!best) best = RESPAWN.clone();
  return best;
}
player.pos.copy(spawnSafe());
// face the central beacon on first spawn (yaw from pos -> origin)
player.yaw = Math.atan2(player.pos.x, player.pos.z);
player.pitch = -0.15;

// --- input ---
const keys = {};
addEventListener("keydown", (e) => {
  keys[e.code] = true;
  if (e.code === "Space") { player.jumpBuf = 0.15; e.preventDefault(); }
  if (e.code.startsWith("Digit")) {
    const n = Number(e.code.slice(5)) - 1;
    if (n >= 0 && n < BLOCKS.length) { selected = n; buildHotbar(); }
  }
  if (e.code === "KeyV" && ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "emote", kind: "wave" }));
  if (e.code === "KeyM") toggleMute();
  if (e.code === "KeyP" && joined) {
    // readout: current position + yaw/pitch (debug aid, keyboard-only players)
    stateEl.textContent = `pos ${player.pos.x.toFixed(1)},${player.pos.y.toFixed(1)},${player.pos.z.toFixed(1)} yaw ${player.yaw.toFixed(2)} pitch ${player.pitch.toFixed(2)} sel ${BLOCKS[selected]}`;
  }
  if (e.code === "KeyE" && joined) {
    const idx = nearFragmentSpot();
    if (idx >= 0 && ws && ws.readyState === 1) {
      // flush current position first so the server validates against where we actually are
      ws.send(JSON.stringify({ type: "state", x: player.pos.x, y: player.pos.y, z: player.pos.z, yaw: player.yaw, pitch: player.pitch }));
      ws.send(JSON.stringify({ type: "collect-fragment", idx }));
    }
  }
  if (e.code === "KeyF" && joined && !beaconLit && collectedFragments.size >= OBJECTIVE && ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "activate-beacon" }));
  }
});
addEventListener("keyup", (e) => { keys[e.code] = false; });

canvas.addEventListener("click", () => { if (joined) canvas.requestPointerLock(); });
document.addEventListener("pointerlockchange", () => {
  hintEl.classList.toggle("hidden", document.pointerLockElement === canvas);
});
document.addEventListener("mousemove", (e) => {
  if (document.pointerLockElement !== canvas) return;
  player.yaw -= e.movementX * 0.0022;
  player.pitch -= e.movementY * 0.0022;
  player.pitch = Math.max(-1.55, Math.min(1.55, player.pitch));
});

addEventListener("mousedown", (e) => {
  if (document.pointerLockElement !== canvas) return;
  if (e.button === 0) tryEdit("break");
  if (e.button === 2) tryEdit("place");
});
addEventListener("contextmenu", (e) => e.preventDefault());

// --- keyboard look/edit (no pointer lock needed): arrow keys look, B place, N break ---
addEventListener("keydown", (e) => {
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "KeyB", "KeyN"].includes(e.code)) {
    if (!joined) return;
    e.preventDefault();
    scenicIdleSince = performance.now();
    // build/edit keys must exit scenic first so raycast() runs from the live first-person camera
    if (e.code === "KeyB" || e.code === "KeyN") {
      if (scenicManual) { scenicManual = false; scenicBtn.textContent = "Scenic view"; }
      scenicIdleSince = performance.now();
      ensurePlayerCamera();
      if (e.repeat) return;
      tryEdit(e.code === "KeyB" ? "place" : "break");
      return;
    }
    if (scenicManual) return;
    if (e.code === "ArrowLeft") player.yaw += 0.06;
    if (e.code === "ArrowRight") player.yaw -= 0.06;
    if (e.code === "ArrowUp") player.pitch = Math.min(1.55, player.pitch + 0.05);
    if (e.code === "ArrowDown") player.pitch = Math.max(-1.55, player.pitch - 0.05);
  }
});

// --- M6: touch controls (pointer: coarse) + leave button ---
const isTouch = matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;

function leaveGame() {
  manualLeave = true;
  try { sendCheckpoint(); } catch {}
  if (ws && ws.readyState === 1) ws.close();
}
window.__leave = leaveGame;

const leaveBtn = document.createElement("button");
leaveBtn.id = "leave-btn";
leaveBtn.type = "button";
leaveBtn.textContent = "Leave";
leaveBtn.classList.add("hidden");
leaveBtn.addEventListener("click", leaveGame);
document.body.appendChild(leaveBtn);

if (isTouch) {
  const stick = document.createElement("div");
  stick.id = "touch-stick";
  const knob = document.createElement("div");
  knob.id = "touch-knob";
  stick.appendChild(knob);
  document.body.appendChild(stick);

  const btns = document.createElement("div");
  btns.id = "touch-btns";
  const mkBtn = (label, id) => {
    const b = document.createElement("button");
    b.id = id; b.type = "button"; b.textContent = label;
    btns.appendChild(b);
    return b;
  };
  const jumpBtn = mkBtn("⤒", "touch-jump");
  const breakBtn = mkBtn("⛏", "touch-break");
  const placeBtn = mkBtn("▣", "touch-place");

  let stickId = null, stickCX = 0, stickCY = 0;
  const R = 48;
  stick.addEventListener("touchstart", (e) => {
    const t = e.changedTouches[0];
    stickId = t.identifier;
    const r = stick.getBoundingClientRect();
    stickCX = r.left + r.width / 2; stickCY = r.top + r.height / 2;
    e.preventDefault();
  }, { passive: false });
  stick.addEventListener("touchmove", (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier !== stickId) continue;
      let dx = t.clientX - stickCX, dy = t.clientY - stickCY;
      const len = Math.hypot(dx, dy) || 1;
      if (len > R) { dx = dx / len * R; dy = dy / len * R; }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      const th = R * 0.35;
      keys.KeyW = dy < -th; keys.KeyS = dy > th;
      keys.KeyA = dx < -th; keys.KeyD = dx > th;
    }
    e.preventDefault();
  }, { passive: false });
  const stickEnd = (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier !== stickId) continue;
      stickId = null;
      knob.style.transform = "translate(0,0)";
      keys.KeyW = keys.KeyS = keys.KeyA = keys.KeyD = false;
    }
  };
  stick.addEventListener("touchend", stickEnd);
  stick.addEventListener("touchcancel", stickEnd);

  // look-drag on canvas
  let lookId = null, lx = 0, ly = 0;
  canvas.addEventListener("touchstart", (e) => {
    if (lookId !== null) return;
    const t = e.changedTouches[0];
    lookId = t.identifier; lx = t.clientX; ly = t.clientY;
  }, { passive: true });
  canvas.addEventListener("touchmove", (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier !== lookId) continue;
      const dx = t.clientX - lx, dy = t.clientY - ly;
      lx = t.clientX; ly = t.clientY;
      player.yaw -= dx * 0.005;
      player.pitch = Math.max(-1.55, Math.min(1.55, player.pitch - dy * 0.005));
    }
  }, { passive: true });
  canvas.addEventListener("touchend", () => { lookId = null; });
  canvas.addEventListener("touchcancel", () => { lookId = null; });

  jumpBtn.addEventListener("touchstart", (e) => { e.preventDefault(); player.jumpBuf = 0.15; }, { passive: false });
  breakBtn.addEventListener("touchstart", (e) => { e.preventDefault(); if (joined) tryEdit("break"); }, { passive: false });
  placeBtn.addEventListener("touchstart", (e) => { e.preventDefault(); if (joined) tryEdit("place"); }, { passive: false });
}

// --- voxel raycast (targeted block + face normal) ---
function raycast() {
  const dir = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(player.pitch, player.yaw, 0, "YXZ"));
  const origin = camera.position.clone();
  let prev = null;
  for (let t = 0; t < 6; t += 0.02) {
    const p = origin.clone().addScaledVector(dir, t);
    const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
    if (world.has(key(bx, by, bz))) {
      return { hit: [bx, by, bz], prev };
    }
    prev = [bx, by, bz];
  }
  return null;
}

function tryEdit(action) {
  const rc = raycast();
  if (!rc) return;
  const [x, y, z] = action === "break" ? rc.hit : rc.prev;
  const msg = { type: "edit", action, x, y, z };
  if (action === "place") msg.block = BLOCKS[selected];
  // client prediction
  applyEdit(action, x, y, z, msg.block);
  playSound(action === "place" ? "place" : "break");
  spawnParticles(action === "break" ? new THREE.Vector3(x + .5, y + .5, z + .5) : new THREE.Vector3(x + .5, y + .5, z + .5), PALETTE[BLOCKS[selected]] ?? 0xffffff);
  ws.send(JSON.stringify(msg));
}

// --- collision (AABB vs voxels) ---
function collides(pos) {
  const x0 = Math.floor(pos.x - PLAYER_HW), x1 = Math.floor(pos.x + PLAYER_HW);
  const y0 = Math.floor(pos.y), y1 = Math.floor(pos.y + PLAYER_H - 0.01);
  const z0 = Math.floor(pos.z - PLAYER_HW), z1 = Math.floor(pos.z + PLAYER_HW);
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++)
    if (world.has(key(x, y, z))) return true;
  return false;
}

// --- placement outline + preview ---
const outline = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002)),
  new THREE.LineBasicMaterial({ color: 0x111111 })
);
outline.visible = false; scene.add(outline);
const preview = new THREE.Mesh(
  new THREE.BoxGeometry(1.001, 1.001, 1.001),
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false })
);
preview.visible = false; scene.add(preview);
const reasonEl = document.getElementById("reject-reason");

function validPlace(x, y, z) {
  if (world.has(key(x, y, z))) return "Block occupied";
  if (y < -20 || y > 40) return "Out of bounds";
  const near = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]].some(([a,b,c]) => world.has(key(x+a, y+b, z+c)));
  if (!near) return "Must touch a block";
  // inside player? true AABB overlap: block [x,x+1]... vs player [p±HW, p.y..p.y+H]
  const p = player.pos;
  const overlap =
    p.x - PLAYER_HW < x + 1 && x < p.x + PLAYER_HW &&
    p.y < y + 1 && y < p.y + PLAYER_H &&
    p.z - PLAYER_HW < z + 1 && z < p.z + PLAYER_HW;
  if (overlap) return "Inside you";
  return null;
}

// --- particles ---
const particles = [];
function spawnParticles(pos, color) {
  const g = new THREE.BufferGeometry();
  const n = 14;
  const positions = new Float32Array(n * 3);
  const vel = [];
  for (let i = 0; i < n; i++) {
    positions[i*3] = pos.x; positions[i*3+1] = pos.y; positions[i*3+2] = pos.z;
    vel.push(new THREE.Vector3((Math.random()-.5)*3, Math.random()*3, (Math.random()-.5)*3));
  }
  g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const pts = new THREE.Points(g, new THREE.PointsMaterial({ color, size: 0.15 }));
  scene.add(pts);
  particles.push({ pts, vel, life: 0.6 });
}
function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    if (p.life <= 0) { scene.remove(p.pts); particles.splice(i, 1); continue; }
    const arr = p.pts.geometry.attributes.position.array;
    p.vel.forEach((v, j) => {
      v.y -= 9 * dt;
      arr[j*3] += v.x * dt; arr[j*3+1] += v.y * dt; arr[j*3+2] += v.z * dt;
    });
    p.pts.geometry.attributes.position.needsUpdate = true;
  }
}

// --- audio (only after user gesture) ---
let audioCtx = null, muted = false;
function ensureAudio() {
  if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch {} }
  return audioCtx;
}
function playSound(kind) {
  if (muted) return;
  const ctx = ensureAudio(); if (!ctx) return;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = kind === "place" ? "square" : "triangle";
  o.frequency.setValueAtTime(kind === "place" ? 320 : 180, ctx.currentTime);
  o.frequency.exponentialRampToValueAtTime(kind === "place" ? 520 : 90, ctx.currentTime + 0.08);
  g.gain.setValueAtTime(0.12, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.1);
  o.connect(g); g.connect(ctx.destination);
  o.start(); o.stop(ctx.currentTime + 0.1);
}
function toggleMute() {
  muted = !muted;
  muteBtn.textContent = muted ? "🔇" : "🔊";
  muteBtn.classList.toggle("hidden", false);
}
muteBtn.addEventListener("click", toggleMute);

// --- network ---
let ws = null, joined = false, myName = null;
let resumeToken = localStorage.getItem("skyforge-token");
let checkpointTimer = null;

// reconnection state
let manualLeave = false;
let reconnectAttempt = 0;

joinForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const nickname = nickInput.value.trim() || "Guest";  stateEl.textContent = resumeToken ? "Resuming session…" : "Joining…";
  ensureAudio();
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => ws.send(JSON.stringify({ type: "join", nickname, token: resumeToken }));
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "joined") {
      joined = true;
      reconnectAttempt = 0;
      myName = msg.name;
      if (msg.token) {
        resumeToken = msg.token;
        localStorage.setItem("skyforge-token", msg.token);
      }
      // once we hold any identity, surface QR panel + recovery row
      if (resumeToken && myQrBtn) {
        myQrBtn.classList.remove("hidden");
        if (!myQrBtn.isConnected) document.getElementById("panel").insertBefore(myQrBtn, document.getElementById("recover-row"));
        window.__recoverRow.classList.remove("hidden");
      }
      // restore saved position/selection
      if (msg.resume && msg.pos && Number.isFinite(msg.pos.x)) {
        player.pos.set(msg.pos.x, msg.pos.y, msg.pos.z);
        player.yaw = msg.pos.yaw || 0;
        player.pitch = msg.pos.pitch || 0;
        player.vel.set(0, 0, 0);
      }
      if (Number.isInteger(msg.selected) && msg.selected >= 0 && msg.selected < BLOCKS.length) {
        selected = msg.selected; buildHotbar();
      }
      stateEl.textContent = msg.resume ? `Welcome back, ${msg.name}!` : `Welcome, ${msg.name}!`;
      overlay.classList.add("gone");
      crosshair.classList.remove("hidden");
      hotbarEl.classList.remove("hidden");
      hintEl.classList.remove("hidden");
      hintEl.textContent = "WASD move · Space jump · Mouse look · L-click break · R-click place · 1-4 blocks · Arrow keys look · B place · N break · V wave · M mute";
      muteBtn.classList.remove("hidden");
      document.getElementById("leave-btn")?.classList.remove("hidden");
      document.getElementById("scenic-btn")?.classList.remove("hidden");
      document.getElementById("respawn-btn")?.classList.remove("hidden");
      setTimeout(() => hintEl.classList.add("hidden"), 8000);
      // periodic position checkpoint (5s) + on unload
      clearInterval(checkpointTimer);
      checkpointTimer = setInterval(() => sendCheckpoint(), 5000);
      addEventListener("beforeunload", sendCheckpoint);
    } else if (msg.type === "init") {
      for (const e of msg.edits) {
        const k = key(e.x, e.y, e.z);
        if (e.block === null) world.delete(k); else world.set(k, e.block);
      }
      rebuild();
      // keep resumed position from "joined"; only fall back to spawn on a truly fresh session
      if (!msg.resume) player.pos.copy(spawnSafe());
      if (Array.isArray(msg.fragments)) {
        collectedFragments = new Set(msg.fragments.filter(Number.isInteger));
        for (let i = 0; i < FRAGMENT_SPOTS.length; i++) {
          const gone = collectedFragments.has(i);
          fragmentMeshes[i * 2].visible = !gone;
          fragmentMeshes[i * 2 + 1].visible = !gone;
        }
      }
      if (msg.beaconLit) applyBeaconLitFX();
      setObjectiveHud();
    } else if (msg.type === "edit-accepted") {
      applyEdit(msg.action, msg.x, msg.y, msg.z, msg.block);
    } else if (msg.type === "edit-rejected") {
      // revert local prediction on reject
      toastEl.textContent = "Rejected: " + msg.reason;
      toastEl.classList.remove("hidden");
      clearTimeout(toastEl._t); toastEl._t = setTimeout(() => toastEl.classList.add("hidden"), 2500);
      // cheap revert: re-fetch state from server init would be heavy; revert last edit
      revertLastEdit();
    } else if (msg.type === "presence") {
      setPresence(msg.players);
      document.getElementById("leave-btn")?.classList.remove("hidden");
      document.getElementById("touch-btns")?.classList.remove("hidden");
      document.getElementById("touch-stick")?.classList.remove("hidden");
    } else if (msg.type === "player-state") {
      const a = avatars.get(msg.name);
      if (a) {
        a.target.set(msg.x, msg.y, msg.z);
        a.yaw = msg.yaw;
      }
    } else if (msg.type === "emote") {
      const a = avatars.get(msg.name);
      if (a) a.waveT = 0;
    } else if (msg.type === "fragment-collected") {
      collectedFragments.add(msg.idx);
      fragmentMeshes[msg.idx * 2].visible = false;
      fragmentMeshes[msg.idx * 2 + 1].visible = false;
      spawnParticles(new THREE.Vector3(FRAGMENT_SPOTS[msg.idx].x + .5, FRAGMENT_SPOTS[msg.idx].y + .5, FRAGMENT_SPOTS[msg.idx].z + .5), 0x9b5cff);
      setObjectiveHud();
      toastEl.textContent = msg.name === myName
        ? `Fragment collected! ${msg.count}/${OBJECTIVE}`
        : `${msg.name} collected a fragment! ${msg.count}/${OBJECTIVE}`;
      toastEl.classList.remove("hidden");
      clearTimeout(toastEl._t); toastEl._t = setTimeout(() => toastEl.classList.add("hidden"), 3000);
    } else if (msg.type === "beacon-lit") {
      applyBeaconLitFX();
      toastEl.textContent = `🔥 ${msg.name} lit the beacon!`;
      toastEl.classList.remove("hidden");
      clearTimeout(toastEl._t); toastEl._t = setTimeout(() => toastEl.classList.add("hidden"), 5000);
    }
  };
  ws.onclose = () => {
    joined = false;
    clearInterval(checkpointTimer);
    if (manualLeave) {
      manualLeave = false;
      overlay.classList.remove("gone");
      document.getElementById("leave-btn")?.classList.add("hidden");
      document.getElementById("scenic-btn")?.classList.add("hidden");
      document.getElementById("respawn-btn")?.classList.add("hidden");
      scenicManual = false;
      scenicBtn.textContent = "Scenic view";
      document.getElementById("touch-btns")?.classList.add("hidden");
      document.getElementById("touch-stick")?.classList.add("hidden");
      stateEl.textContent = "Disconnected. Reconnect below.";
      joinForm.classList.remove("hidden");
      return;
    }
    // unexpected drop (server restart, network blip): auto-reconnect with backoff
    reconnectAttempt = Math.min(reconnectAttempt + 1, 5);
    const delay = Math.min(1000 * 2 ** (reconnectAttempt - 1), 10000);
    stateEl.textContent = "Disconnected. Reconnecting…";
    setTimeout(() => {
      if (!joined) joinForm.requestSubmit();
    }, delay);
  };
});

function sendCheckpoint() {
  if (ws && ws.readyState === 1 && joined) {
    ws.send(JSON.stringify({
      type: "checkpoint",
      x: player.pos.x, y: player.pos.y, z: player.pos.z,
      yaw: player.yaw, pitch: player.pitch, selected,
    }));
  }
}

// --- remote avatars ---
const avatars = new Map(); // name -> { group, target, yaw, nameSprite, waveT }
function setPresence(players) {
  const names = new Set(players.map(p => p.name));
  // remove gone
  for (const [name, a] of avatars) {
    if (!names.has(name) || name === myName) {
      scene.remove(a.group);
      avatars.delete(name);
    }
  }
  for (const p of players) {
    if (p.name === myName) continue;
    if (!avatars.has(p.name)) {
      const g = new THREE.Group();
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(0.6, 1.3, 0.4),
        new THREE.MeshLambertMaterial({ color: new THREE.Color(p.color) })
      );
      body.position.y = 0.9;
      g.add(body);
      const head = new THREE.Mesh(
        new THREE.BoxGeometry(0.5, 0.5, 0.5),
        new THREE.MeshLambertMaterial({ color: new THREE.Color(p.color).multiplyScalar(0.8) })
      );
      head.position.y = 1.85;
      g.add(head);
      // name tag
      const cv = document.createElement("canvas");
      cv.width = 256; cv.height = 64;
      const ctx2 = cv.getContext("2d");
      ctx2.fillStyle = "rgba(8,30,40,0.75)"; ctx2.fillRect(0, 0, 256, 64);
      ctx2.font = "bold 36px system-ui"; ctx2.fillStyle = p.color; ctx2.textAlign = "center";
      ctx2.fillText(p.name, 128, 44);
      const tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), transparent: true }));
      tag.scale.set(1.6, 0.4, 1);
      tag.position.y = 2.6;
      g.add(tag);
      scene.add(g);
      avatars.set(p.name, { group: g, target: new THREE.Vector3(), yaw: 0, waveT: -1 });
    }
  }
}
function updateAvatars(dt) {
  for (const a of avatars.values()) {
    a.group.position.lerp(a.target, Math.min(1, dt * 10));
    a.group.rotation.y = a.yaw;
    if (a.waveT >= 0) {
      a.waveT += dt;
      const body = a.group.children[0];
      body.rotation.z = Math.sin(a.waveT * 10) * 0.3;
      if (a.waveT > 1.2) { body.rotation.z = 0; a.waveT = -1; }
    }
  }
}


let lastEdit = null;
function revertLastEdit() {
  if (!lastEdit) return;
  applyEdit(lastEdit.action === "place" ? "break" : "place", lastEdit.x, lastEdit.y, lastEdit.z, lastEdit.block);
}

// wrap tryEdit to record lastEdit
const _tryEdit = tryEdit;
tryEdit = function (action) {
  const rc = raycast();
  if (!rc) {
    window.__noteEditAction(action, "—", "no target in range");
    return;
  }
  const [x, y, z] = action === "break" ? rc.hit : rc.prev;
  if (action === "place") {
    const why = validPlace(x, y, z);
    if (why) {
      window.__noteEditAction(action, `${x},${y},${z}`, why);
      toastEl.textContent = "Rejected: " + why;
      toastEl.classList.remove("hidden");
      clearTimeout(toastEl._t); toastEl._t = setTimeout(() => toastEl.classList.add("hidden"), 2500);
      return;
    }
  }
  lastEdit = { action, x, y, z, block: action === "place" ? BLOCKS[selected] : null };
  window.__noteEditAction(action, `${x},${y},${z}`, null);
  _tryEdit(action);
};

// --- physics ---
let stateTimer = 0;
let scenicYaw = 0;
let scenicIdleSince = performance.now();
let scenicManual = false; // user-facing scenic toggle
const SCENIC_AFTER_IDLE = 20000; // ms without input before scenic orbit resumes
const scenicBtn = document.createElement("button");
scenicBtn.id = "scenic-btn";
scenicBtn.textContent = "Scenic view";
scenicBtn.className = "hidden";
scenicBtn.style.cssText = "position:fixed;bottom:14px;right:14px;z-index:6;background:#223;color:#ffd27d;border:1px solid #556;border-radius:8px;padding:6px 12px;font:600 13px system-ui;cursor:pointer";
scenicBtn.addEventListener("click", () => { scenicManual = !scenicManual; scenicBtn.textContent = scenicManual ? "Exit scenic" : "Scenic view"; if (!scenicManual) scenicIdleSince = performance.now(); });
document.body.appendChild(scenicBtn);

// Respawn control: always reachable while joined — returns to a safe spawn and checkpoints it
const respawnBtn = document.createElement("button");
respawnBtn.id = "respawn-btn";
respawnBtn.textContent = "Respawn";
respawnBtn.className = "hidden";
respawnBtn.style.cssText = "position:fixed;bottom:14px;right:120px;z-index:6;background:#223;color:#9fdcff;border:1px solid #556;border-radius:8px;padding:6px 12px;font:600 13px system-ui;cursor:pointer";
respawnBtn.addEventListener("click", () => {
  if (!joined) return;
  if (scenicManual) { scenicManual = false; scenicBtn.textContent = "Scenic view"; }
  scenicIdleSince = performance.now();
  player.pos.copy(spawnSafe());
  player.vel.set(0, 0, 0);
  player.pitch = -0.15;
  player.yaw = Math.atan2(player.pos.x, player.pos.z); // face the beacon
  sendCheckpoint();
  toastEl.textContent = "Respawned at the beacon island.";
  toastEl.classList.remove("hidden");
  clearTimeout(toastEl._t); toastEl._t = setTimeout(() => toastEl.classList.add("hidden"), 2500);
});
document.body.appendChild(respawnBtn);

function scenicOrbit(dt) {
  // orbit the whole island cluster, not the player, so all islands + beacon fit in frame
  scenicYaw += dt * 0.12;
  camera.position.set(Math.sin(scenicYaw) * 55, 34, Math.cos(scenicYaw) * 55);
  camera.lookAt(0, 4, 0);
  stateEl.textContent = "Scenic view — press a movement key to resume";
  beacon.material.emissiveIntensity = 0.5 + Math.sin(performance.now() / 500) * 0.25;
}
// restore the first-person camera from player state (called before any targeting/edit
// and whenever control returns from scenic, so raycast() never reads a stale orbit camera)
function ensurePlayerCamera() {
  camera.position.set(player.pos.x, player.pos.y + EYE, player.pos.z);
  camera.rotation.set(player.pitch, player.yaw, 0, "YXZ");
}
function step(dt) {
  if (!joined) {
    // pre-join scenic orbit
    const t = performance.now() / 1000;
    camera.position.set(Math.sin(t * 0.08) * 34, 24 + Math.sin(t * 0.15) * 3, Math.cos(t * 0.08) * 34);
    camera.lookAt(0, 6, 0);
    beacon.material.emissiveIntensity = 0.5 + Math.sin(t * 2) * 0.25;
    return;
  }
  // idle scenic orbit after long inactivity or manual toggle, yields to any input
  const idle = performance.now() - scenicIdleSince;
  const anyInput = keys.KeyW || keys.KeyA || keys.KeyS || keys.KeyD || player.jumpBuf > 0 || document.pointerLockElement === canvas;
  if (anyInput) {
    scenicIdleSince = performance.now();
    if (scenicManual) { scenicManual = false; scenicBtn.textContent = "Scenic view"; }
  }
  if (scenicManual || idle > SCENIC_AFTER_IDLE) {
    scenicOrbit(dt);
    return;
  }
  ensurePlayerCamera();
  const fwd = new THREE.Vector3(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
  const right = new THREE.Vector3(fwd.z * -1, 0, fwd.x);
  const wish = new THREE.Vector3();
  if (keys.KeyW) wish.add(fwd);
  if (keys.KeyS) wish.sub(fwd);
  if (keys.KeyD) wish.add(right);
  if (keys.KeyA) wish.sub(right);
  if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(player.W);

  player.vel.x = wish.x;
  player.vel.z = wish.z;
  player.vel.y -= player.G * dt;

  player.coyote = player.onGround ? 0.12 : Math.max(0, player.coyote - dt);
  player.jumpBuf = Math.max(0, player.jumpBuf - dt);
  if (player.jumpBuf > 0 && (player.onGround || player.coyote > 0)) {
    player.vel.y = player.J; player.jumpBuf = 0; player.coyote = 0; player.onGround = false;
  }

  // integrate with per-axis collision
  const move = (axis, delta) => {
    const old = player.pos[axis];
    player.pos[axis] += delta;
    if (collides(player.pos)) {
      player.pos[axis] = old;
      if (axis === "y") { player.vel.y = 0; if (delta < 0) player.onGround = true; }
      else player.vel[axis] = 0;
    } else if (axis === "y" && delta < 0) player.onGround = false;
  };
  player.onGround = false;
  move("x", player.vel.x * dt);
  move("z", player.vel.z * dt);
  move("y", player.vel.y * dt);

  if (player.pos.y < -20) {
    player.pos.copy(spawnSafe());
    player.vel.set(0, 0, 0);
    toastEl.textContent = "Recovered from the void — respawned.";
    toastEl.classList.remove("hidden");
    clearTimeout(toastEl._t); toastEl._t = setTimeout(() => toastEl.classList.add("hidden"), 2500);
  }

  camera.position.set(player.pos.x, player.pos.y + EYE, player.pos.z);
  camera.rotation.set(player.pitch, player.yaw, 0, "YXZ");
  if (stateEl.textContent.startsWith("Scenic view")) stateEl.textContent = "";

  // broadcast own state ~10/s
  stateTimer += dt;
  if (stateTimer > 0.1) {
    stateTimer = 0;
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "state", x: player.pos.x, y: player.pos.y, z: player.pos.z, yaw: player.yaw, pitch: player.pitch }));
    }
  }

  // targeting visuals — the single source of truth shared with tryEdit()
  const rc = raycast();
  updateBuildAssist(rc);
  if (rc) {
    outline.visible = true;
    outline.position.set(rc.hit[0] + .5, rc.hit[1] + .5, rc.hit[2] + .5);
    const [px, py, pz] = rc.prev;
    const why = validPlace(px, py, pz);
    preview.visible = true;
    preview.position.set(px + .5, py + .5, pz + .5);
    preview.material.color.set(why ? 0xff4444 : 0x66ff99);
    preview.material.opacity = 0.35;
    reasonEl.textContent = why ? ("✕ " + why) : "";
  } else {
    outline.visible = false; preview.visible = false; reasonEl.textContent = "";
  }

  beacon.material.emissiveIntensity = 0.5 + Math.sin(performance.now() / 500) * 0.25;
}

const clock = new THREE.Clock();

// --- build-assist panel (read-only): derived from the same raycast/validPlace path as normal controls ---
const baPanel = document.getElementById("build-assist");
const baJoined = document.getElementById("ba-joined");
const baTarget = document.getElementById("ba-target");
const baCell = document.getElementById("ba-cell");
const baMaterial = document.getElementById("ba-material");
const baStatus = document.getElementById("ba-status");
window.__buildAssist = () => ({
  joined: baJoined.textContent,
  target: baTarget.textContent,
  cell: baCell.textContent,
  material: baMaterial.textContent,
  status: baStatus.textContent,
});
let lastActionInfo = "—";
window.__noteEditAction = (action, cell, reason) => {
  lastActionInfo = reason ? `${action} ${cell} → ✕ ${reason}` : `${action} ${cell} → confirmed`;
};
function updateBuildAssist(rc) {
  if (!joined) { baPanel.classList.add("hidden"); return; }
  baPanel.classList.remove("hidden");
  baJoined.textContent = `joined: yes (${myName})`;
  baTarget.textContent = rc ? `target: ${rc.hit[0]},${rc.hit[1]},${rc.hit[2]}` : "target: none in range";
  baCell.textContent = rc ? `place cell: ${rc.prev[0]},${rc.prev[1]},${rc.prev[2]}` : "place cell: —";
  baMaterial.textContent = `material: ${BLOCKS[selected]}`;
  baStatus.textContent = `status: ${lastActionInfo}`;
}
function animate() {
  const dt = Math.min(clock.getDelta(), 0.05);
  step(dt);
  updateParticles(dt);
  updateAvatars(dt);
  // objective visuals: fragment bob/spin, sky lerp when beacon lit
  for (let i = 0; i < FRAGMENT_SPOTS.length; i++) {
    if (collectedFragments.has(i)) continue;
    fragmentMeshes[i * 2].rotation.y += dt * 1.5;
    fragmentMeshes[i * 2].position.y = FRAGMENT_SPOTS[i].y + 0.5 + Math.sin(performance.now() / 400 + i) * 0.15;
  }
  const targetT = beaconLit ? 1 : 0;
  skyLerpT += (targetT - skyLerpT) * Math.min(1, dt * 0.8);
  // cloud drift (tangential around the world centre; wrap beyond 115)
  clouds.children.forEach((c, i) => {
    const ang = Math.atan2(c.position.z, c.position.x);
    const r = Math.hypot(c.position.x, c.position.z);
    const na = ang + dt * (0.004 + (i % 3) * 0.002);
    c.position.x = Math.cos(na) * r;
    c.position.z = Math.sin(na) * r;
  });
  if (skyLerpT > 0.001) {
    scene.background.setHex(0x39c5cf).lerp(new THREE.Color(SKY_LIT), skyLerpT);
    scene.fog.color.copy(scene.background);
    // celebratory pulse rings from the beacon
    if (!animate._pulse || performance.now() - animate._pulse > 900) {
      animate._pulse = performance.now();
      spawnParticles(new THREE.Vector3(BEACON_POS.x + (Math.random() - .5) * 3, BEACON_POS.y + 6 + Math.random() * 3, BEACON_POS.z + (Math.random() - .5) * 3), 0xffd27d);
    }
  }
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}
animate();

stateEl.textContent = "Choose a nickname to join.";
joinForm.classList.remove("hidden");
nickInput.focus();
// show recovery UI once we have an identity too

// --- M5: QR recovery + public join QR ---
const qrModal = document.getElementById("qr-modal");
const qrCanvas = document.getElementById("qr-canvas");
const qrTitle = document.getElementById("qr-title");
const qrWarn = document.getElementById("qr-warn");
const qrMsg = document.getElementById("qr-msg");
function initQrUI() {
const publicQrBtn = document.getElementById("public-qr-btn");
const recoverRow = document.getElementById("recover-row");
const myQrBtn = document.createElement("button");
myQrBtn.id = "my-qr-btn";
myQrBtn.type = "button";
myQrBtn.textContent = "My recovery QR";
myQrBtn.style.cssText = "margin-top:10px;background:#223;color:#ffd27d;border:1px solid #556;";
myQrBtn.classList.add("hidden");
window.myQrBtn = myQrBtn;
window.__recoverRow = recoverRow;
publicQrBtn.classList.remove("hidden");

function drawQR(canvas, text, size = 220) {
  QRCode.toCanvas(canvas, text, { width: size, margin: 1 }, (err) => { if (err) console.error(err); });
}

function openQrModal({ title, text, warn }) {
  qrTitle.textContent = title;
  qrWarn.textContent = warn;
  qrMsg.textContent = "";
  qrCanvas.width = 220; qrCanvas.height = 220;
  QRCode.toCanvas(qrCanvas, text, { width: 220, margin: 1 }, (err) => {
    if (err) { qrMsg.textContent = "QR render failed: " + err.message; return; }
    qrCanvas.dataset.payload = text;
    qrModal.classList.remove("hidden");
  });
}
function closeQrModal() { qrModal.classList.add("hidden"); }

document.getElementById("qr-close").addEventListener("click", closeQrModal);
qrModal.addEventListener("click", (e) => { if (e.target === qrModal) closeQrModal(); });

document.getElementById("qr-download").addEventListener("click", () => {
  const a = document.createElement("a");
  a.download = "skyforge-recovery.png";
  a.href = qrCanvas.toDataURL("image/png");
  a.click();
});

// private QR: encodes origin URL with the token in a private fragment (#r=...),
// so scanning opens the game and pre-fills recovery; the fragment never reaches the server
myQrBtn?.addEventListener("click", () => {
  if (!resumeToken) { qrMsg && (qrMsg.textContent = "No identity yet."); return; }
  openQrModal({
    title: "Your recovery QR",
    text: `${location.origin}/#r=${resumeToken}`,
    warn: "⚠ Anyone with this image can play as you. Don't share it. Regenerating invalidates it permanently.",
  });
});

document.getElementById("qr-revoke").addEventListener("click", async () => {
if (!resumeToken) return;
const r = await fetch("/revoke", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: resumeToken }) });
const j = await r.json();
if (!j.ok || !j.token) { qrMsg.textContent = j.error || "Rotation failed"; return; }
// server atomically rotated: old credential is dead, fresh token bound to the SAME player
resumeToken = j.token;
localStorage.setItem("skyforge-token", j.token);
closeQrModal();
toastEl.textContent = "Recovery QR regenerated — the old one no longer works.";
toastEl.classList.remove("hidden");
clearTimeout(toastEl._t); toastEl._t = setTimeout(() => toastEl.classList.add("hidden"), 3500);
});

// public join QR: only the game URL — scanning joins as the scanner's own player
publicQrBtn.addEventListener("click", () => {
  openQrModal({
    title: "Join QR (public)",
    text: location.origin,
    warn: "Safe to share — it only opens the game as the scanner's own player.",
  });
});

// recovery via scanned/private QR: #r=<token> in the URL is captured into the recovery
// input and the fragment is stripped immediately (before any exchange/fetch)
(function captureHashCredential() {
  const m = location.hash.match(/^#r=([a-f0-9]{64})$/);
  if (!m) return;
  history.replaceState(null, "", location.pathname + location.search);
  const input = document.getElementById("credential");
  if (input) input.value = m[1];
})();

// recovery flow: exchange pasted credential for a session in THIS browser
document.getElementById("recover-btn").addEventListener("click", async () => {
  const cred = document.getElementById("credential").value.trim();
  const btn = document.getElementById("recover-btn");
  if (!/^[a-f0-9]{64}$/.test(cred)) { stateEl.textContent = "Recovery: credential looks malformed."; return; }
  btn.disabled = true;
  const info = await fetch("/recover-info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ credential: cred }) }).then(r => r.json()).catch(() => null);
  if (!info?.ok) { stateEl.textContent = "Recovery failed: " + (info?.error ?? "server error"); btn.disabled = false; return; }
  if (!confirm(`Recover as "${info.nickname}"? This consumes the credential and binds this browser to that player.`)) { btn.disabled = false; return; }
  const rec = await fetch("/recover", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ credential: cred }) }).then(r => r.json()).catch(() => null);
  btn.disabled = false;
  if (!rec?.ok) { stateEl.textContent = "Recovery failed: " + (rec?.error ?? "server error"); return; }
  localStorage.setItem("skyforge-token", rec.token);
  resumeToken = rec.token;
  nickInput.value = rec.nickname;
  document.getElementById("credential").value = ""; // strip credential from the page
  joinForm.requestSubmit(); // rejoin with new token -> same pid, pos, color
});
}
initQrUI();
