// Deterministic seeded terrain — shared by client (public/main.js) and server (server.ts).
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const SEED = 1337;

// Generates the base terrain Map ("x,y,z" -> block name). Must stay byte-identical to the client's generation.
export function generateTerrain() {
  const world = new Map();
  const key = (x, y, z) => x + "," + y + "," + z;
  const rng = mulberry32(SEED);
  function island(cx, cy, cz, radius, height) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const d = Math.hypot(dx, dz);
        if (d > radius) continue;
        const h = Math.max(1, Math.round(height * (1 - d / radius) * (0.6 + rng() * 0.5)));
        for (let dy = 0; dy < h; dy++) {
          let mat = "stone";
          if (dy === h - 1) mat = rng() < 0.15 ? "sand" : "grass";
          else if (dy > h - 3) mat = "dirt";
          world.set(key(cx + dx, cy + dy, cz + dz), mat);
        }
        if (d < radius * 0.5 && rng() < 0.2) {
          world.set(key(cx + dx, cy - 1 - Math.floor(rng() * 2), cz + dz), "stone");
        }
        if (h >= 2 && rng() < 0.04 && d < radius * 0.6) {
          const tx = cx + dx, tz = cz + dz, ty = cy + h;
          const th = 3 + Math.floor(rng() * 2);
          for (let t = 0; t < th; t++) world.set(key(tx, ty + t, tz), "wood");
          world.set(key(tx, ty + th, tz), "wood");
          world.set(key(tx + 1, ty + th, tz), "wood");
          world.set(key(tx - 1, ty + th, tz), "wood");
          world.set(key(tx, ty + th, tz + 1), "wood");
          world.set(key(tx, ty + th, tz - 1), "wood");
        }
      }
    }
  }
  // beacon position must match seeded terrain (center column carved out)
  island(0, 0, 0, 11, 5);
  island(-22, 3, -14, 6, 4);
  island(20, 5, 10, 5, 3);
  island(14, -2, -18, 4, 3);
  for (let y = 0; y < 3; y++) {
    world.delete(key(0, y, 0)); world.delete(key(1, y, 0)); world.delete(key(-1, y, 0));
    world.delete(key(0, y, 1)); world.delete(key(0, y, -1));
  }
  // M8: three energy fragments at fixed landmarks near spawn (ruin / satellite / tree isles).
  const FRAGMENT_SPOTS = [
    { x: -22, y: 7, z: -14 },  // ruin isle
    { x: 20, y: 7, z: 10 },    // satellite isle
    { x: 14, y: 5, z: -18 },   // tree isle
  ];
  return { world, key, FRAGMENT_SPOTS };
}
export const FRAGMENT_SPOTS = generateTerrain().FRAGMENT_SPOTS;

export function isSolidAt(world, x, y, z) {
  return world.has(x + "," + y + "," + z);
}
