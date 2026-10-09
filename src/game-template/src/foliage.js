/**
 * Foliage — harness-owned like `materials.js`, never a facet's file. Trees, bushes, logs.
 *
 * Why this exists: trees built as flat-shaded icosahedra with a moss texture read as grey
 * boulders on posts from every camera, and the judge says so round after round. A solid mesh can never
 * read as a canopy: leaves are thousands of small surfaces with air between them. Without
 * assets the answer is the same one every engine used before megascans — **alpha-tested
 * leaf cards**: a few dozen crossed planes, each carrying a baked cluster of leaf shapes with
 * transparent gaps, scattered through an ellipsoid. The silhouette breaks, light passes
 * through, the underside darkens, and it sways as a whole.
 *
 *   import { makeTree, makeBush, makeLogPile, swayTree } from "./foliage.js";
 *   const oak = makeTree({ height: 8, spread: 4, seed: 12 });   // tag "tree"
 *   scene.add(oak);                                              // in update(): swayTree(oak, t, wind)
 *
 * Everything is deterministic from the seed and needs no canvas (the leaf sprite is a
 * DataTexture), so it runs under the harness's evaluator as well as in the game.
 */
import * as THREE from "three";
import { makeRng, standardMaterial } from "./materials.js";

const TAU = Math.PI * 2;

/** Leaf tones: crown, mid, underside. Broadleaf greens by default; pass your own for autumn or pines. */
export const LEAF_PALETTES = {
  broadleaf: [0x93b25a, 0x62823d, 0x3c5629],
  olive: [0x9da062, 0x6c7343, 0x46502c],
  autumn: [0xc98a3a, 0x9c5a2a, 0x5a3418],
  pine: [0x4f6d45, 0x33492d, 0x1f2e1b],
  bush: [0x7f9d50, 0x527038, 0x354a24],
};

/**
 * Each kind of leaf: its default palette, how many leaves a card holds, and each leaf's radii
 * (`rx` across, `ry` along), drawn from the card's generator in that order.
 */
const LEAF_KINDS = {
  needle: { palette: "pine", count: 140, rx: (rng) => 0.012 + rng() * 0.01, ry: (rng) => 0.08 + rng() * 0.07 },
  bush: { palette: "bush", count: 64, rx: (rng) => 0.045 + rng() * 0.03, ry: (rng, rx) => rx * (0.5 + rng() * 0.35) },
  broadleaf: {
    palette: "broadleaf",
    count: 34,
    rx: (rng) => 0.07 + rng() * 0.05,
    ry: (rng, rx) => rx * (0.5 + rng() * 0.35),
  },
};

/** A kind the table does not know draws broadleaf. */
const leafKind = (kind) => (Object.hasOwn(LEAF_KINDS, kind) ? LEAF_KINDS[kind] : LEAF_KINDS.broadleaf);

/** Crown lighter, underside darker: a leaf's tone by its height on the card. */
function toneByHeight(colors, t) {
  if (t > 0.66) return colors[0];
  if (t > 0.33) return colors[1];
  return colors[2];
}

/** The card's leaves, each placed, turned, sized and tinted from the generator. */
function scatterLeaves(rng, shape, colors) {
  const leaves = [];
  for (let i = 0; i < shape.count; i++) {
    // Bunch toward the centre so the card edge is mostly air — that is what breaks the silhouette.
    const r = 0.46 * Math.sqrt(rng()) * (0.6 + 0.4 * rng());
    const a = rng() * TAU;
    const cx = 0.5 + Math.cos(a) * r;
    const cy = 0.5 + Math.sin(a) * r * 0.9;
    const rot = rng() * TAU;
    const rx = shape.rx(rng);
    const ry = shape.ry(rng, rx);
    // Crown lighter, underside darker: pick by height with noise, never one flat green.
    const t = Math.max(0, Math.min(1, cy + (rng() - 0.5) * 0.5));
    const base = toneByHeight(colors, t);
    const tint = base.clone().offsetHSL((rng() - 0.5) * 0.03, (rng() - 0.5) * 0.12, (rng() - 0.5) * 0.1);
    leaves.push({ cx, cy, cos: Math.cos(rot), sin: Math.sin(rot), rx, ry, color: tint, vein: rng() > 0.4 });
  }
  return leaves;
}

/** The leaf on top at a point of the card, and how much its vein and rim darken it there; null over air. */
function leafAt(leaves, u, v) {
  // Last leaf on top: later leaves overlap earlier ones like leaves in front of leaves.
  for (let i = leaves.length - 1; i >= 0; i--) {
    const l = leaves[i];
    const dx = u - l.cx;
    const dy = v - l.cy;
    const lx = dx * l.cos + dy * l.sin;
    const ly = -dx * l.sin + dy * l.cos;
    const e = (lx * lx) / (l.rx * l.rx) + (ly * ly) / (l.ry * l.ry);
    if (!(e <= 1)) continue;
    // A midrib and a darker rim: the leaf has a surface, not a stamp.
    const veinDark = (l.vein && Math.abs(ly) < l.ry * 0.07 ? 0.18 : 0) + (e > 0.78 ? 0.12 : 0);
    return { leaf: l, veinDark };
  }
  return null;
}

/**
 * A cluster of leaf shapes rasterised into an RGBA DataTexture with transparent gaps —
 * the one thing that makes a card read as foliage instead of a green square.
 * `kind`: "broadleaf" (ovals with a stem), "needle" (thin slivers), "bush" (small dense ovals).
 */
export function leafSprite({ seed = 1, size = 256, kind = "broadleaf", palette = null } = {}) {
  const rng = makeRng(seed);
  const shape = leafKind(kind);
  const colors = (palette ?? LEAF_PALETTES[shape.palette]).map((c) => new THREE.Color(c));
  const leaves = scatterLeaves(rng, shape, colors);
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const hit = leafAt(leaves, u, v);
      const o = (y * size + x) * 4;
      if (!hit) {
        data[o + 3] = 0;
        continue;
      }
      const k = 1 - hit.veinDark;
      data[o] = Math.round(hit.leaf.color.r * 255 * k);
      data[o + 1] = Math.round(hit.leaf.color.g * 255 * k);
      data[o + 2] = Math.round(hit.leaf.color.b * 255 * k);
      data[o + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/** The card material: alpha-tested (no sorting problems), double-sided, vertex colours carry the crown/underside shade. */
export function foliageMaterial({
  sprite = null,
  seed = 1,
  kind = "broadleaf",
  palette = null,
  roughness = 0.92,
} = {}) {
  const map = sprite ?? leafSprite({ seed, kind, palette });
  const material = new THREE.MeshStandardMaterial({
    map,
    alphaTest: 0.5,
    side: THREE.DoubleSide,
    roughness,
    metalness: 0,
    vertexColors: true,
  });
  material.userData.foliage = kind;
  return material;
}

/**
 * A cloud of leaf cards inside an ellipsoid: `radius` across, `radius * squash` tall. Each
 * card is a square plane with a random orientation and a vertex shade that darkens toward
 * the bottom and the core (cheap ambient occlusion). Tag "canopy"; cards are tagged "foliage".
 */
export function makeCanopy({ radius = 2.2, cards = 28, seed = 1, material = null, squash = 0.8, tag = "canopy" } = {}) {
  const rng = makeRng(seed * 7 + 11);
  const leaf = material ?? foliageMaterial({ seed, kind: "broadleaf" });
  const group = new THREE.Group();
  group.userData.tag = tag;
  for (let i = 0; i < cards; i++) {
    // cbrt → uniform in the volume; the ×0.9 keeps card centres inside so edges feather out.
    const r = radius * Math.cbrt(rng()) * 0.9;
    const theta = rng() * TAU;
    const phi = Math.acos(2 * rng() - 1);
    const x = r * Math.sin(phi) * Math.cos(theta);
    const y = r * Math.cos(phi) * squash;
    const z = r * Math.sin(phi) * Math.sin(theta);
    const s = radius * (0.7 + rng() * 0.5);
    const geo = new THREE.PlaneGeometry(s, s);
    const shade = new Float32Array(4 * 3);
    const height = 0.5 + 0.5 * (y / (radius * squash)); // 0 bottom … 1 crown
    const depth = 1 - r / radius; // 0 rim … 1 core
    const k = 0.66 + 0.4 * height - 0.18 * depth + (rng() - 0.5) * 0.12;
    for (let v = 0; v < 4; v++) {
      const j = Math.max(0.4, Math.min(1.1, k + (v < 2 ? 0.06 : -0.06))); // top verts lighter
      shade[v * 3] = j;
      shade[v * 3 + 1] = j;
      shade[v * 3 + 2] = j;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(shade, 3));
    const card = new THREE.Mesh(geo, leaf);
    card.position.set(x, y, z);
    card.rotation.set(rng() * TAU, rng() * TAU, rng() * TAU);
    card.castShadow = true;
    card.userData.tag = "foliage";
    group.add(card);
  }
  return group;
}

/** Ring-by-ring jitter on a cylinder so a trunk is not a lathe part. */
function roughen(geometry, rng, amount) {
  const pos = geometry.attributes.position;
  const v = new THREE.Vector3();
  const rings = new Map();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const key = Math.round(v.y * 100);
    if (!rings.has(key)) rings.set(key, { dx: (rng() - 0.5) * amount, dz: (rng() - 0.5) * amount });
    const ring = rings.get(key);
    const rad = Math.hypot(v.x, v.z);
    if (rad > 1e-4) {
      const bump = 1 + (rng() - 0.5) * amount * 0.6;
      pos.setXYZ(i, v.x * bump + ring.dx, v.y, v.z * bump + ring.dz);
    }
  }
  pos.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * A tapered, slightly crooked trunk with a few limbs. Base at y = 0. Tag "trunk", limbs "branch".
 * Returns the group and the limb tips (`userData.tips`) so canopies can sit on branch ends.
 */
export function makeTrunk({ height = 5, radius = 0.28, seed = 1, material = null, limbs = 3, lean = 0.05 } = {}) {
  const rng = makeRng(seed * 13 + 5);
  const bark =
    material ??
    standardMaterial({
      kind: "wood",
      seed: 90 + seed,
      palette: [0x3b2f24, 0x5a4a3a, 0x746152],
      repeat: 2,
      roughness: 0.96,
      metalness: 0,
    });
  const group = new THREE.Group();
  group.userData.tag = "trunk";
  const geo = roughen(new THREE.CylinderGeometry(radius * 0.5, radius * 1.15, height, 9, 6, false), rng, radius * 0.35);
  geo.translate(0, height / 2, 0);
  const trunk = new THREE.Mesh(geo, bark);
  trunk.castShadow = true;
  trunk.receiveShadow = true;
  trunk.userData.tag = "trunk";
  trunk.rotation.z = (rng() - 0.5) * lean * 2;
  group.add(trunk);
  const tips = [];
  for (let i = 0; i < limbs; i++) {
    const at = height * (0.5 + 0.35 * (i / Math.max(1, limbs - 1))) + (rng() - 0.5) * height * 0.08;
    const len = height * (0.28 + rng() * 0.22);
    const a = (i / limbs) * TAU + rng() * 1.2;
    const pitch = 0.55 + rng() * 0.5; // radians up from horizontal
    const limbGeo = roughen(
      new THREE.CylinderGeometry(radius * 0.18, radius * 0.42, len, 7, 3, false),
      rng,
      radius * 0.2,
    );
    limbGeo.translate(0, len / 2, 0);
    const limb = new THREE.Mesh(limbGeo, bark);
    limb.position.set(Math.cos(a) * radius * 0.5, at, Math.sin(a) * radius * 0.5);
    limb.rotation.set(0, -a, 0);
    limb.rotateZ(-(Math.PI / 2 - pitch)); // tilt outward from the trunk axis
    limb.castShadow = true;
    limb.userData.tag = "branch";
    group.add(limb);
    const tip = new THREE.Vector3(0, len, 0).applyEuler(limb.rotation).add(limb.position);
    tips.push(tip);
  }
  group.userData.tips = tips;
  return group;
}

/**
 * One deciduous tree: trunk + a main crown + a lump on every limb tip. Tag "tree";
 * `userData.canopy` / `userData.trunk` / `userData.phase` are there for `swayTree`.
 * `kind` picks the leaf sprite: "broadleaf" | "needle" | "bush"; `palette` overrides the tones.
 */
export function makeTree({
  height = 7,
  spread = 3.2,
  seed = 1,
  kind = "broadleaf",
  palette = null,
  bark = null,
  leaf = null,
  cards = null,
  lean = 0.05,
} = {}) {
  const rng = makeRng(seed * 31 + 7);
  const tree = new THREE.Group();
  tree.userData.tag = "tree";
  const trunk = makeTrunk({
    height: height * 0.62,
    radius: 0.04 * height,
    seed,
    material: bark,
    limbs: 3 + Math.floor(rng() * 2),
    lean,
  });
  tree.add(trunk);
  const leafMat = leaf ?? foliageMaterial({ seed, kind, palette });
  const canopy = new THREE.Group();
  canopy.userData.tag = "canopy";
  const crownR = spread * 0.5;
  const nCards = cards ?? Math.round(22 + spread * 4);
  const main = makeCanopy({
    radius: crownR,
    cards: nCards,
    seed: seed + 1,
    material: leafMat,
    squash: 0.78,
    tag: "crown",
  });
  main.position.set((rng() - 0.5) * crownR * 0.2, height * 0.66, (rng() - 0.5) * crownR * 0.2);
  canopy.add(main);
  for (const [i, tip] of (trunk.userData.tips ?? []).entries()) {
    const lump = makeCanopy({
      radius: crownR * (0.45 + rng() * 0.25),
      cards: Math.round(nCards * 0.4),
      seed: seed + 10 + i,
      material: leafMat,
      squash: 0.85,
      tag: "crown",
    });
    lump.position.copy(tip).add(new THREE.Vector3(0, crownR * 0.15, 0));
    canopy.add(lump);
  }
  tree.add(canopy);
  tree.userData.canopy = canopy;
  tree.userData.trunk = trunk;
  tree.userData.phase = rng() * TAU;
  tree.userData.stiffness = 0.7 + rng() * 0.6;
  return tree;
}

/** A low dense bush: a squashed canopy sitting on the ground. Tag "bush". */
export function makeBush({ radius = 0.9, seed = 1, palette = null, leaf = null } = {}) {
  const material = leaf ?? foliageMaterial({ seed: seed + 50, kind: "bush", palette });
  const bush = makeCanopy({
    radius,
    cards: Math.round(22 + radius * 10),
    seed: seed + 3,
    material,
    squash: 0.7,
    tag: "bush",
  });
  bush.position.y = radius * 0.45;
  bush.userData.phase = makeRng(seed)() * TAU;
  return bush;
}

/**
 * A felled log lying along local x: a tapered, roughened cylinder with pale cut ends, sunk a
 * little into the ground (nothing lies *on* grass). Tag "log".
 */
export function makeLog({ length = 2.4, radius = 0.22, seed = 1, bark = null } = {}) {
  const rng = makeRng(seed * 17 + 3);
  const barkMat =
    bark ??
    standardMaterial({
      kind: "wood",
      seed: 120 + seed,
      palette: [0x3b2f24, 0x5a4a3a, 0x746152],
      repeat: 2,
      roughness: 0.96,
      metalness: 0,
    });
  const cut = new THREE.MeshStandardMaterial({ color: 0xb9a37a, roughness: 0.9, metalness: 0 });
  const group = new THREE.Group();
  group.userData.tag = "log";
  const geo = roughen(new THREE.CylinderGeometry(radius * 0.85, radius, length, 9, 4, false), rng, radius * 0.25);
  const body = new THREE.Mesh(geo, barkMat);
  body.rotation.z = Math.PI / 2;
  body.castShadow = true;
  body.receiveShadow = true;
  body.userData.tag = "log-body";
  group.add(body);
  for (const side of [-1, 1]) {
    const end = new THREE.Mesh(new THREE.CircleGeometry(radius * (side < 0 ? 0.98 : 0.83), 9), cut);
    end.position.x = (side * length) / 2 + side * 0.002;
    end.rotation.y = side < 0 ? -Math.PI / 2 : Math.PI / 2;
    end.userData.tag = "log-end";
    group.add(end);
  }
  group.position.y = radius * 0.8;
  group.rotation.y = (rng() - 0.5) * 0.3;
  return group;
}

/** A pyramid of logs by a wall or a door. Tag "log-pile". */
export function makeLogPile({ count = 6, length = 1.6, radius = 0.16, seed = 1, bark = null } = {}) {
  const rng = makeRng(seed * 23 + 1);
  const pile = new THREE.Group();
  pile.userData.tag = "log-pile";
  let placed = 0;
  let row = 0;
  let perRow = Math.ceil(count / 2);
  while (placed < count) {
    for (let i = 0; i < perRow && placed < count; i++) {
      const log = makeLog({ length: length * (0.9 + rng() * 0.2), radius, seed: seed + placed, bark });
      log.position.set(
        (rng() - 0.5) * 0.12,
        radius * 0.85 + row * radius * 1.85,
        (i - (perRow - 1) / 2) * radius * 2.35 + (rng() - 0.5) * 0.06,
      );
      log.rotation.y = (rng() - 0.5) * 0.14;
      log.rotation.x = (rng() - 0.5) * 0.06;
      pile.add(log);
      placed++;
    }
    row++;
    perRow = Math.max(1, perRow - 1);
  }
  return pile;
}

/**
 * Sway a tree from ONE shared wind: the whole tree leans a little, the canopy leans more and
 * flutters. `wind`: { dir: [x, z], strength: 0–1 } — read it once per frame and pass it in.
 */
export function swayTree(tree, t, { dir = [1, 0], strength = 0.5 } = {}) {
  const phase = tree.userData.phase ?? 0;
  const stiff = tree.userData.stiffness ?? 1;
  const lean = ((0.012 + 0.03 * strength) * (Math.sin(t * 1.6 + phase) * 0.6 + 0.4)) / stiff;
  tree.rotation.z = -lean * dir[0];
  tree.rotation.x = lean * dir[1];
  const canopy = tree.userData.canopy;
  if (canopy) {
    const flutter = 0.01 * strength * Math.sin(t * 5.3 + phase * 2);
    canopy.rotation.z = -(lean * 2.2 + flutter) * dir[0];
    canopy.rotation.x = (lean * 2.2 + flutter) * dir[1];
    canopy.position.y = Math.sin(t * 2.9 + phase) * 0.02 * strength;
  }
}
