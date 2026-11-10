# Room templates

Four complete server-authoritative games to start from. Each passes `npx genex-authority-dev
validate` as written; the fourth uses server physics ([physics.md](physics.md)), which needs a
validator with the physics core.

1. **A top-down arena**: an instant shot along the aim (hitscan, lag-compensated).
2. **A bolt arena**: bolts players can see and dodge, bouncing off the walls (projectiles, see
   [projectiles.md](projectiles.md)). It reuses the first template's client setup.
3. **A car arena**: two against two with the `vehicle` preset in a walled arena, and one ball
   (a projectile the module re-launches, see [presets.md](presets.md)).
4. **A physics car arena**: the car arena with a real physics ball and four crate stacks the server
   simulates (see [physics.md](physics.md)). It reuses the third template's world and client.

## Template 1: a top-down arena

Players move with the `topdown` preset and fire an instant shot along their aim, judged against
where the shooter saw its targets. Three hits take a player down; they respawn elsewhere and the
shooter scores.

### The room module

```js
// server/room.js: runs on Genex's servers (and the local authority server), never in a browser.

/** The fire button's bit in input.buttons; the client sends the same bit. */
const FIRE = 1;
/** Half the arena's side, world units: the preset keeps every body inside it. */
const ARENA = 20;
/** Movement speed, units per second. */
const SPEED = 6;
/** A player's hit radius, units. */
const RADIUS = 0.6;
/** How far a shot reaches, units. */
const RANGE = 30;
/** Ticks between two shots of one player: 5 shots a second at 30 Hz. */
const COOLDOWN_TICKS = 6;
/** Hits that take a player down. */
const MAX_HP = 3;

/** Marks the room module, as defineRoom from @genex-ai/multiplayer/authority/module does. */
const defineRoom = (room) => room;

/** Back to full health at a seeded spot; the epoch bump makes every client snap there. */
function respawn(ctx, id) {
  const body = ctx.entities.get(id);
  const angle = ctx.random() * Math.PI * 2;
  ctx.entities.update(id, {
    x: Math.fround(Math.cos(angle) * ARENA * 0.6),
    y: Math.fround(Math.sin(angle) * ARENA * 0.6),
    hp: MAX_HP,
    epoch: body ? body.epoch + 1 : 0,
  });
}

/** One shot along the shooter's aim; the third hit scores and respawns the target. */
function fire(ctx, playerId) {
  const me = ctx.entities.ownedBy(playerId);
  if (!me) return;
  const hit = ctx.rewind.hitscan(
    { x: me.x, y: me.y, z: 0 },
    { x: Math.cos(me.yaw), y: Math.sin(me.yaw), z: 0 },
    { range: RANGE, radius: RADIUS, kinds: ["player"] },
  );
  if (!hit) {
    ctx.emit("shot", { shooter: playerId, hit: null, dist: RANGE });
    return;
  }
  const target = ctx.entities.get(hit.id);
  ctx.emit("shot", { shooter: playerId, hit: target.owner, dist: Math.fround(hit.dist) });
  if (target.hp > 1) {
    ctx.entities.update(target.id, { hp: target.hp - 1 });
    return;
  }
  const score = (ctx.state.score[playerId] ?? 0) + 1;
  ctx.state.score[playerId] = score;
  ctx.entities.update(me.id, { data: { score } });
  ctx.emit("kill", { by: playerId, victim: target.owner });
  respawn(ctx, target.id);
}

export default defineRoom({
  contract: 1,
  config: {
    tickHz: 30,
    maxPlayers: 8,
    preset: { name: "topdown", params: { speed: SPEED, arena: ARENA } },
    lagComp: { buttons: FIRE },
  },
  init() {
    return { cooldown: {}, score: {} };
  },
  onJoin(ctx, player) {
    const id = ctx.entities.spawn({ kind: "player", owner: player.id, hp: MAX_HP, data: { score: 0 } });
    respawn(ctx, id);
    ctx.state.cooldown[player.id] = 0;
    ctx.state.score[player.id] = 0;
  },
  onLeave(ctx, player) {
    const body = ctx.entities.ownedBy(player.id);
    if (body) ctx.entities.remove(body.id);
    delete ctx.state.cooldown[player.id];
    delete ctx.state.score[player.id];
  },
  onInput(ctx, playerId, input) {
    // The preset has already moved and turned this player's body by this input.
    if ((input.buttons & FIRE) === 0 || ctx.state.cooldown[playerId] > 0) return;
    fire(ctx, playerId);
    ctx.state.cooldown[playerId] = COOLDOWN_TICKS;
  },
  step(ctx) {
    for (const id of Object.keys(ctx.state.cooldown)) {
      ctx.state.cooldown[id] = Math.max(0, ctx.state.cooldown[id] - 1);
    }
  },
});
```

package.json:

```json
{ "genex": { "authority": { "module": "server/room.js", "maxPlayers": 8 } } }
```

Grow from here: pickups are entities the module spawns and removes; shots players can see and
dodge are projectiles (template 2); rounds and a scoreboard are `ctx.state` plus events. Anything
the module writes to an entity reaches every client; anything in `ctx.state` stays on the server.

### The client, with three.js

```ts
// src/arena.ts: joins the room, sends input, draws what the server says.
import * as THREE from "three";
import { connectAuthority, type AuthorityEntityView } from "@genex-ai/multiplayer/authority";
import { getAuthorityUrls, getColyseusAuth, waitForPlayer } from "@genex-ai/embed-sdk";
import { GENEX } from "./genex.config";

/** The fire button: the same bit as FIRE in server/room.js. */
const FIRE = 1;
/** The arena's half side, as ARENA in server/room.js. */
const ARENA = 20;

/** A refused join's code (JoinError) in the player's words. */
const REFUSED: Record<number, string> = {
  402: "Online play isn't available for this game right now.",
  424: "This game's server isn't ready yet.",
  426: "This game needs an update to play online.",
  429: "The game's servers are busy right now. Try again later.",
  503: "No game server is free right now. Try again in a moment.",
};

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
document.body.append(renderer.domElement);
const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 2));
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 200);
camera.position.set(0, 34, 0);
camera.up.set(0, 0, -1); // the top of the screen is the server's -y
camera.lookAt(0, 0, 0);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(ARENA * 2, ARENA * 2), new THREE.MeshStandardMaterial({ color: 0x2a3340 }));
floor.rotation.x = -Math.PI / 2;
scene.add(floor);
const hud = document.createElement("div");
hud.style.cssText = "position:fixed;left:12px;top:12px;color:#fff;font:14px system-ui";
document.body.append(hud);

const keys = new Set<string>();
addEventListener("keydown", (e) => keys.add(e.code));
addEventListener("keyup", (e) => keys.delete(e.code));
const pointer = new THREE.Vector2();
let firing = false;
addEventListener("pointermove", (e) => pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1));
renderer.domElement.addEventListener("pointerdown", () => (firing = true));
addEventListener("pointerup", () => (firing = false));
const raycaster = new THREE.Raycaster();
const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const aim = new THREE.Vector3();

await waitForPlayer();
const session = await connectAuthority({
  urls: getAuthorityUrls(),
  room: GENEX.slug,
  auth: () => getColyseusAuth(),
}).catch((err: { code?: number }) => {
  hud.textContent = REFUSED[err.code ?? 0] ?? "Couldn't join the game.";
  throw err;
});
session.on("disconnect", (code) => {
  hud.textContent = code === 4500 ? "The game was stopped." : "Disconnected from the game.";
});
session.on("kill", () => (hud.textContent = `score ${JSON.parse(session.me()?.data || "{}").score ?? 0}`));

/** A body: a capsule with a nose along +x, so its aim shows. */
function makeBody(mine: boolean): THREE.Group {
  const body = new THREE.Group();
  body.add(new THREE.Mesh(new THREE.CapsuleGeometry(0.5, 0.6), new THREE.MeshStandardMaterial({ color: mine ? 0x4cc3ff : 0xff6b5b })));
  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.2, 0.2), new THREE.MeshStandardMaterial({ color: 0xffffff }));
  nose.position.x = 0.6;
  body.add(nose);
  return body;
}

const bodies = new Map<string, THREE.Group>();
function draw(entities: Map<string, AuthorityEntityView>): void {
  for (const [id, e] of entities) {
    let body = bodies.get(id);
    if (!body) {
      body = makeBody(e.owner === session.id);
      scene.add(body);
      bodies.set(id, body);
    }
    body.position.set(e.x, 0.8, e.y); // the server's y is three's z
    body.rotation.y = -e.yaw;
  }
  for (const [id, body] of bodies) {
    if (entities.has(id)) continue;
    scene.remove(body);
    bodies.delete(id);
  }
}

function loop(now: number): void {
  const me = session.me();
  session.input.moveX = (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0);
  session.input.moveY = (keys.has("KeyS") ? 1 : 0) - (keys.has("KeyW") ? 1 : 0);
  raycaster.setFromCamera(pointer, camera);
  if (me && raycaster.ray.intersectPlane(ground, aim)) session.input.yaw = Math.atan2(aim.z - me.y, aim.x - me.x);
  session.input.buttons = firing ? FIRE : 0;
  session.frame(now);
  draw(session.entities());
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
```

What it shows, and what to keep when you change it:

- **Input is all the client decides.** It writes the stick, the aim and the fire bit into
  `session.input`; `session.frame(now)` sends them at the room's tick rate.
- **The player's own body is predicted** by the session with the room's `topdown` preset; it moves
  the instant a key is down. Every other body is drawn about 100 ms in the past.
- **Hits, health and score come only from the server**: the `shot` and `kill` events and each
  entity's `hp` and `data`. A tracer drawn on `shot` lines up with what the server judged.
- **A respawn snaps** because the module bumps `epoch`; nothing in the client needs to know.
- **A refused join is said in the player's words** and never retried in a loop.

A game whose identity setup is not done yet loads `$genex-threejs-embed-auth` first: `initEmbed` runs
before anything here.

## Template 2: a bolt arena (projectiles)

Players move with the same `topdown` preset and fire bolts: projectiles that fly at 16 units a
second, bounce off the arena's walls twice and are judged by a sweep along their path every tick, so
a bolt never passes through a body between two ticks. Three hits take a player down. The shooter's
client draws its bolt the frame it fires; everyone else sees it where the server has it now. Read
[projectiles.md](projectiles.md) for the rules behind each line.

### The room module

```js
// server/room.js (bolt arena): runs on Genex's servers (and the local authority server), never in a browser.

/** The fire button's bit in input.buttons; the client sends the same bit. */
const FIRE = 1;
/** Half the arena's side, world units: the preset keeps bodies inside it, and bolts bounce off it. */
const ARENA = 20;
/** Movement speed, units per second. */
const SPEED = 6;
/** A bolt's speed along the aim, units per second. The client predicts with the same number. */
const BOLT_SPEED = 16;
/** A body's radius plus a bolt's: how near a bolt's path must pass a body's centre to hit it. */
const HIT_RADIUS = 0.8;
/** Walls a bolt bounces off; the next wall removes it. */
const MAX_BOUNCES = 2;
/** A bolt still flying this many ticks after it was fired is removed (3 s at 30 Hz). */
const MAX_AGE_TICKS = 90;
/** Ticks between two shots of one player: at most 6 bolts each in the air, so hits per tick stay
 *  well under the 64 events a tick may send. */
const COOLDOWN_TICKS = 15;
/** Hits that take a player down. */
const MAX_HP = 3;

/** Marks the room module, as defineRoom from @genex-ai/multiplayer/authority/module does. */
const defineRoom = (room) => room;

/** Back to full health at a seeded spot; the epoch bump makes every client snap there. */
function respawn(ctx, id) {
  const body = ctx.entities.get(id);
  const angle = ctx.random() * Math.PI * 2;
  ctx.entities.update(id, {
    x: Math.fround(Math.cos(angle) * ARENA * 0.6),
    y: Math.fround(Math.sin(angle) * ARENA * 0.6),
    hp: MAX_HP,
    epoch: body ? body.epoch + 1 : 0,
  });
}

/** Fires a bolt from the shooter's body along its aim. Launched while handling the input, it gets
 *  the id the shooter's client predicted it under (`<seat>.<seq>.0`). */
function fire(ctx, playerId) {
  const me = ctx.entities.ownedBy(playerId);
  if (!me) return false;
  const id = ctx.projectiles.launch({
    kind: "bolt",
    x: me.x,
    y: me.y,
    z: 0,
    vx: Math.cos(me.yaw) * BOLT_SPEED,
    vy: Math.sin(me.yaw) * BOLT_SPEED,
    vz: 0,
  });
  // A bounce re-launches the bolt from step, which clears its src: who fired it is kept here.
  ctx.state.bolts.push({ id, shooter: playerId, born: ctx.tick, bounces: 0 });
  return true;
}

/** The nearest body this bolt's path crossed since the last tick, other than its shooter's own. */
function victimOf(ctx, bolt) {
  for (const hit of ctx.projectiles.sweep(bolt.id, { kinds: ["player"], radius: HIT_RADIUS })) {
    const body = ctx.entities.get(hit.id);
    if (body && body.owner !== bolt.shooter) return body;
  }
  return null;
}

/** One hit: a point of damage, and on the last one a respawn and a point for the shooter. */
function strike(ctx, bolt, body) {
  const down = body.hp <= 1;
  if (down) {
    respawn(ctx, body.id);
    // The shooter may have left; its bolts fly on, but nobody scores.
    if (ctx.state.score[bolt.shooter] !== undefined) {
      const score = ctx.state.score[bolt.shooter] + 1;
      ctx.state.score[bolt.shooter] = score;
      const shooter = ctx.entities.ownedBy(bolt.shooter);
      if (shooter) ctx.entities.update(shooter.id, { data: { score } });
    }
  } else {
    ctx.entities.update(body.id, { hp: body.hp - 1 });
  }
  ctx.emit("hit", { bolt: bolt.id, shooter: bolt.shooter, victim: body.owner, down });
}

/** A bolt past a wall flies on from its mirror image inside, that velocity reversed: a re-launch
 *  under the same id, which every client draws from the new launch. */
function bounce(ctx, bolt, at) {
  const outX = Math.abs(at.x) > ARENA;
  const outY = Math.abs(at.y) > ARENA;
  ctx.projectiles.launch({
    id: bolt.id,
    kind: "bolt",
    x: outX ? Math.sign(at.x) * 2 * ARENA - at.x : at.x,
    y: outY ? Math.sign(at.y) * 2 * ARENA - at.y : at.y,
    z: 0,
    vx: outX ? -at.vx : at.vx,
    vy: outY ? -at.vy : at.vy,
    vz: 0,
  });
  bolt.bounces += 1;
}

/** Judges one bolt this tick; false once it is gone. The server never removes one by itself. */
function fly(ctx, bolt) {
  if (!ctx.entities.get(bolt.id)) return false;
  const body = victimOf(ctx, bolt);
  if (body) {
    strike(ctx, bolt, body);
    ctx.entities.remove(bolt.id);
    return false;
  }
  const at = ctx.projectiles.at(bolt.id);
  const inside = Math.abs(at.x) <= ARENA && Math.abs(at.y) <= ARENA;
  if (ctx.tick - bolt.born >= MAX_AGE_TICKS || (!inside && bolt.bounces >= MAX_BOUNCES)) {
    ctx.entities.remove(bolt.id);
    return false;
  }
  if (!inside) bounce(ctx, bolt, at);
  return true;
}

export default defineRoom({
  contract: 1,
  config: {
    tickHz: 30,
    maxPlayers: 8,
    preset: { name: "topdown", params: { speed: SPEED, arena: ARENA } },
  },
  init() {
    // bolts: the bolts in the air, in launch order (the order step judges them in).
    return { cooldown: {}, score: {}, bolts: [] };
  },
  onJoin(ctx, player) {
    const id = ctx.entities.spawn({ kind: "player", owner: player.id, hp: MAX_HP, data: { score: 0 } });
    respawn(ctx, id);
    ctx.state.cooldown[player.id] = 0;
    ctx.state.score[player.id] = 0;
  },
  onLeave(ctx, player) {
    const body = ctx.entities.ownedBy(player.id);
    if (body) ctx.entities.remove(body.id);
    delete ctx.state.cooldown[player.id];
    delete ctx.state.score[player.id];
  },
  onInput(ctx, playerId, input) {
    // The preset has already moved and turned this player's body by this input.
    if ((input.buttons & FIRE) === 0 || ctx.state.cooldown[playerId] > 0) return;
    if (fire(ctx, playerId)) ctx.state.cooldown[playerId] = COOLDOWN_TICKS;
  },
  step(ctx) {
    ctx.state.bolts = ctx.state.bolts.filter((bolt) => fly(ctx, bolt));
    for (const id of Object.keys(ctx.state.cooldown)) {
      ctx.state.cooldown[id] = Math.max(0, ctx.state.cooldown[id] - 1);
    }
  },
});
```

package.json:

```json
{ "genex": { "authority": { "module": "server/room.js", "maxPlayers": 8 } } }
```

There is no `lagComp`: projectiles are judged where the bodies are on the server now, and the
bounce reverses one velocity component from the bolt's mirror image inside the wall.

### The client, with three.js

Start from template 1's client, in the same file: keep its imports, everything above `makeBody`
(the renderer, camera, floor, HUD, keys, pointer, `FIRE`, `REFUSED` and the join) and `makeBody`
itself, drop its `kill` handler, and replace its `bodies`, `draw` and `loop` with this:

```ts
// src/arena.ts, template 2: bolts drawn from their flight; your own predicted the frame you fire.
/** The bolt's speed: BOLT_SPEED in server/room.js. */
const BOLT_SPEED = 16;
/** Inputs between two shots: the module's COOLDOWN_TICKS (15) plus slack for jitter, so the server
 *  never refuses a bolt this client already drew. */
const FIRE_EVERY_INPUTS = 18;
/** How high bolts fly above the floor; the server launches them at z = 0. */
const BOLT_HEIGHT = 0.8;

const boltGeometry = new THREE.SphereGeometry(0.2);
const mineMaterial = new THREE.MeshBasicMaterial({ color: 0x9be7ff });
const theirsMaterial = new THREE.MeshBasicMaterial({ color: 0xffb347 });

/** Every drawn entity by id. A predicted bolt keeps its id when the server's confirms it, so one
 *  mesh flies from the click to the hit. */
const meshes = new Map<string, THREE.Object3D>();
function draw(entities: Map<string, AuthorityEntityView>): void {
  for (const [id, e] of entities) {
    const bolt = e.t0 > 0; // a projectile
    let mesh = meshes.get(id);
    if (!mesh) {
      mesh = bolt ? new THREE.Mesh(boltGeometry, e.src === session.id ? mineMaterial : theirsMaterial) : makeBody(e.owner === session.id);
      scene.add(mesh);
      meshes.set(id, mesh);
    }
    if (bolt) {
      mesh.position.set(e.x, BOLT_HEIGHT + e.z, e.y); // where its flight is now: never smooth it
    } else {
      mesh.position.set(e.x, 0.8, e.y); // the server's y is three's z
      mesh.rotation.y = -e.yaw;
    }
  }
  for (const [id, mesh] of meshes) {
    if (entities.has(id)) continue; // gone: a hit, a wall after the last bounce, or a refused shot
    scene.remove(mesh);
    meshes.delete(id);
  }
}

session.on("hit", (data) => {
  const hit = data as { shooter: string; victim: string; down: boolean };
  if (hit.victim === session.id) hud.textContent = hit.down ? "You're down" : "You're hit";
  else if (hit.shooter === session.id) hud.textContent = hit.down ? "Down!" : "Hit!";
});

/** A fire input is staged and not sent yet, and inputsSent when the last one went. */
let armed = false;
let lastShot = -Infinity;

function loop(now: number): void {
  const me = session.me();
  session.input.moveX = (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0);
  session.input.moveY = (keys.has("KeyS") ? 1 : 0) - (keys.has("KeyW") ? 1 : 0);
  raycaster.setFromCamera(pointer, camera);
  // float32, as the server stores it, so the prediction flies along the module's own aim
  if (me && raycaster.ray.intersectPlane(ground, aim)) session.input.yaw = Math.fround(Math.atan2(aim.z - me.y, aim.x - me.x));
  if (me && firing && !armed && session.telemetry.inputsSent - lastShot >= FIRE_EVERY_INPUTS) {
    const yaw = session.input.yaw;
    session.input.buttons = FIRE;
    // The module's launch for this input, predicted before the frame() that sends it.
    session.predictProjectile({ kind: "bolt", x: me.x, y: me.y, z: 0, vx: Math.cos(yaw) * BOLT_SPEED, vy: Math.sin(yaw) * BOLT_SPEED, vz: 0 });
    armed = true;
  }
  const sent = session.frame(now);
  if (armed && sent > 0) {
    session.input.buttons = 0; // only the input the prediction was made for fires
    armed = false;
    lastShot = session.telemetry.inputsSent;
  }
  draw(session.entities());
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
```

What it shows, on top of template 1:

- **One prediction per shot, made while the firing input is staged.** `predictProjectile` runs
  before the `frame()` that sends the fire bit, with the module's own start point, speed and aim;
  the button is cleared once that input is sent, so no other input fires.
- **The client never moves a bolt.** Every bolt's `x`, `y`, `z` comes from `session.entities()`,
  already where its flight is this frame: your own from the click, everyone else's at the server's
  present. A bounce is a re-launch, so a bolt turns at the wall on every screen without any client
  code.
- **The cooldown is mirrored with slack.** The client waits a few inputs longer than the module's
  cooldown. A shot the server refuses anyway, or one that hits point blank before any state patch
  carries it, simply leaves `session.entities()`; the `hit` event is what says something was hit.
- **Hits, health and score still come only from the server**: the `hit` event, `hp` and `data`.

## Template 3: a car arena (`vehicle`, and a ball)

Up to four cars, two a team, drive with the `vehicle` preset in a walled arena with a ceiling and
a goal mouth painted on each end wall, and play one ball. Boost refills slowly; a kickoff gives every
car a third of a tank. The ball is one server projectile the module re-launches whenever its flight
changes: off a car at their first contact in the tick, off the floor, walls and ceiling with
restitution, and every few ticks while it rolls, with rolling friction. A ball that touches an end
wall inside its goal mouth scores, and a kickoff puts the ball and every car back. The rules behind
each line are in [presets.md](presets.md) ("Running a ball").

### The world, shared by both sides

```ts
// src/car-world.ts: imported by server/room.js AND by the client, so both step through one world.

/** The arena (z up, units about a centimetre): half its length to the end walls, half its width,
 *  and the ceiling's height. */
export const X = 3072;
export const Y = 2048;
export const CEILING = 1536;
/** Wall thickness: more than the ball's diameter, so a ball never passes through one in a tick. */
export const WALL = 256;
/** Each goal mouth, painted on an end wall: half its width, and its height. */
export const GOAL_W = 640;
export const GOAL_H = 512;
/** The car's hull (the preset's radius and height) and the ball's radius. */
export const CAR_R = 50;
export const CAR_H = 36;
export const BALL_R = 92;

/** The collision world: boxes [minX, minY, minZ, maxX, maxY, maxZ]. Every value an integer, so a
 *  float32. The module exports it and the client hands it to its session: one world, one hash. */
export const WORLD = {
  boxes: [
    [-X - WALL, -Y - WALL, -64, X + WALL, Y + WALL, 0], // 0: the floor
    [-X - WALL, -Y - WALL, CEILING, X + WALL, Y + WALL, CEILING + WALL], // 1: the ceiling
    [-X, -Y - WALL, 0, X, -Y, CEILING], // 2, 3: the side walls
    [-X, Y, 0, X, Y + WALL, CEILING],
    [X, -Y - WALL, 0, X + WALL, Y + WALL, CEILING], // 4, 5: the end walls, a goal painted on each
    [-X - WALL, -Y - WALL, 0, -X, Y + WALL, CEILING],
  ],
  ramps: [],
};
```

### The room module

```js
// server/room.js (car arena): runs on Genex's servers (and the local authority server), never in a browser.
import { BALL_R, CAR_H, CAR_R, GOAL_H, GOAL_W, WORLD, X } from "../src/car-world";

/** Spawn slots, two a team, and the heading each team faces: blue attacks +x, orange attacks -x
 *  (-float32(pi): the wire's own value for a heading of pi). */
const SLOTS = { blue: [[-1536, -512], [-1536, 512]], orange: [[1536, 512], [1536, -512]] };
const HEADING = { blue: 0, orange: -Math.fround(Math.PI) };
/** Fuel at a kickoff, and what a car gains every REFILL_TICKS ticks (a full tank in 10 s at 60 Hz). */
const KICKOFF_FUEL = Math.fround(0.34);
const REFILL = Math.fround(0.05);
const REFILL_TICKS = 30;

/** The ball: its gravity; restitution off the world, and the tangential speed a real impact
 *  (faster than IMPACT into the surface) keeps; restitution off a car, the share of the car's speed
 *  a hit adds, and the least speed a hit leaves it with, MIN_HIT_K times the car's own speed into
 *  it and at most MIN_HIT (a parked car adds nothing). */
const BALL_G = 650;
const WORLD_E = 0.6;
const WORLD_KEEP = 0.85;
const IMPACT = 120;
const CAR_E = 0.3;
const HIT_SHARE = 0.25;
const MIN_HIT = 300;
const MIN_HIT_K = 2;
/** A car driving into the ball at least this fast along the contact normal touches it. */
const TOUCH_DRIVE = 50;
/** The car-ball sweep: samples over the tick, then halvings of the sample that first touches. */
const SAMPLES = 8;
const HALVINGS = 8;
/** Under the ball's radius per tick at 60 Hz (92 * 60), so it never passes through a wall. */
const BALL_MAX = 4800;
/** While rolling: every ROLL_TICKS ticks its speed s becomes
 *  max(0, s * (1 - ROLL_K * ROLL_TICKS * dt) - ROLL_DECEL * ROLL_TICKS * dt), at rest below STOP_SPEED. */
const ROLL_TICKS = 6;
const ROLL_K = 0.25;
const ROLL_DECEL = 150;
const STOP_SPEED = 10;
/** Clearance a contact pushes the ball out to; how near the floor its bottom is to roll on it. */
const SKIN = 0.5;
const SUPPORT = 1;

/** Marks the room module, as defineRoom from @genex-ai/multiplayer/authority/module does. */
const defineRoom = (room) => room;

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** The ball at p against the box [x0, y0, z0, x1, y1, z1]: null, or the contact's outward normal n
 *  and how far p must move along it to clear the box by SKIN. The normal is from the box's closest
 *  point; from inside, the face p is least deep behind. */
function sphereBox(p, x0, y0, z0, x1, y1, z1) {
  const cx = Math.min(Math.max(p[0], x0), x1);
  const cy = Math.min(Math.max(p[1], y0), y1);
  const cz = Math.min(Math.max(p[2], z0), z1);
  const d = [p[0] - cx, p[1] - cy, p[2] - cz];
  const d2 = dot(d, d);
  if (d2 >= BALL_R * BALL_R) return null;
  if (d2 > 0) {
    const len = Math.sqrt(d2);
    return { n: [d[0] / len, d[1] / len, d[2] / len], push: BALL_R - len + SKIN };
  }
  const faces = [
    [p[0] - x0, -1, 0, 0], [x1 - p[0], 1, 0, 0],
    [p[1] - y0, 0, -1, 0], [y1 - p[1], 0, 1, 0],
    [p[2] - z0, 0, 0, -1], [z1 - p[2], 0, 0, 1],
  ];
  let best = faces[0];
  for (const face of faces) if (face[0] < best[0]) best = face;
  return { n: [best[1], best[2], best[3]], push: best[0] + BALL_R + SKIN };
}

/** Off the world: moving into the surface, the normal speed reflects times WORLD_E, and a real
 *  impact keeps WORLD_KEEP of the tangential speed (a slow contact, a ball sliding, keeps all of it). */
function bounceWorld(v, n) {
  const vn = dot(v, n);
  if (!(vn < 0)) return;
  const keep = -vn > IMPACT ? WORLD_KEEP : 1;
  for (let i = 0; i < 3; i++) v[i] = (v[i] - vn * n[i]) * keep - WORLD_E * vn * n[i];
}

/** The ball's first contact with `car` during this tick, or null. The ball goes from b0 (its flight
 *  a tick ago) to b1 (now) and the car from where step last saw it to where it is now: relative to
 *  the car that is one segment, sampled from its start and then halved down to the first touch. */
function carContact(ctx, car, b0, b1) {
  const was = ctx.state.carWas[car.id];
  const from = was !== undefined && was[3] === car.epoch ? was : [car.x, car.y, car.z];
  const r0 = [b0[0] - from[0], b0[1] - from[1], b0[2] - from[2]];
  const r1 = [b1[0] - car.x, b1[1] - car.y, b1[2] - car.z];
  const at = (t) => [r0[0] + (r1[0] - r0[0]) * t, r0[1] + (r1[1] - r0[1]) * t, r0[2] + (r1[2] - r0[2]) * t];
  const test = (r) => sphereBox(r, -CAR_R, -CAR_R, 0, CAR_R, CAR_R, CAR_H);
  let contact = test(r0);
  if (contact !== null) return { s: 0, rel: r0, contact };
  let k = 1;
  for (; k <= SAMPLES && contact === null; k++) contact = test(at(k / SAMPLES));
  if (contact === null) return null;
  let lo = (k - 2) / SAMPLES;
  let hi = (k - 1) / SAMPLES;
  for (let i = 0; i < HALVINGS; i++) {
    const mid = (lo + hi) / 2;
    const c = test(at(mid));
    if (c === null) lo = mid;
    else {
      hi = mid;
      contact = c;
    }
  }
  return { s: hi, rel: at(hi), contact };
}

/** A car back on its slot, at rest, facing the other goal, with KICKOFF_FUEL; spin 0 and mstate 0
 *  start a fresh life, and the epoch bump (unless it is a new car) makes every client snap. */
function toSlot(ctx, car, bump) {
  const team = ctx.state.team[car.owner];
  const [x, y] = SLOTS[team][ctx.state.slot[car.owner]];
  ctx.entities.update(car.id, {
    x, y, z: 0, vx: 0, vy: 0, vz: 0, yaw: HEADING[team], spin: 0, mstate: 0, fuel: KICKOFF_FUEL,
    epoch: bump ? car.epoch + 1 : car.epoch,
  });
}

/** The ball, launched (or re-launched) from p with velocity v; a rolling ball has no gravity. Its
 *  data is the score, so every client can show it. */
function launchBall(ctx, p, v, rolling) {
  ctx.projectiles.launch({
    id: "ball", kind: "ball", x: p[0], y: p[1], z: p[2], vx: v[0], vy: v[1], vz: v[2], g: rolling ? 0 : BALL_G,
    data: ctx.state.score,
  });
}

function kickoff(ctx, cars, bump) {
  launchBall(ctx, [0, 0, BALL_R], [0, 0, 0], true);
  for (const car of cars) toSlot(ctx, car, bump);
  ctx.state.lastTouch = "";
}

/** A hit: the car is far heavier, so the relative normal speed reflects times CAR_E, plus a share of
 *  the car's own speed into the ball, and at least the minimum hit away from the car. */
function hitBall(ctx, car, v, n) {
  const vc = [car.vx, car.vy, car.vz];
  const closing = (v[0] - vc[0]) * n[0] + (v[1] - vc[1]) * n[1] + (v[2] - vc[2]) * n[2];
  if (!(closing < 0)) return;
  const drive = Math.max(0, dot(vc, n));
  const push = -(1 + CAR_E) * closing + HIT_SHARE * drive;
  for (let i = 0; i < 3; i++) v[i] += n[i] * push;
  const least = Math.min(MIN_HIT, MIN_HIT_K * drive);
  const away = (v[0] - vc[0]) * n[0] + (v[1] - vc[1]) * n[1] + (v[2] - vc[2]) * n[2];
  if (away < least) for (let i = 0; i < 3; i++) v[i] += n[i] * (least - away);
  if (drive > TOUCH_DRIVE) {
    ctx.state.lastTouch = car.owner;
    ctx.emit("touch", { seat: car.owner, team: ctx.state.team[car.owner] ?? "" });
  }
}

/** The ball's tick, against the cars where this tick's inputs left them. */
function stepBall(ctx, cars) {
  const ball = ctx.entities.get("ball");
  if (ball === undefined) return kickoff(ctx, cars, false);
  const now = ctx.projectiles.at("ball");
  const before = ctx.projectiles.at("ball", ctx.tick - 1);
  const p = [now.x, now.y, now.z];
  const v = [now.vx, now.vy, now.vz];
  let changed = false;
  // Off the cars first, each at its first contact this tick, placed by where the car is now.
  for (const car of cars) {
    const hit = carContact(ctx, car, [before.x, before.y, before.z], p);
    if (hit === null) continue;
    changed = true;
    const { n, push } = hit.contact;
    hitBall(ctx, car, v, n);
    // From the contact on it moves with its new velocity relative to the car: never left inside it.
    const base = [car.x, car.y, car.z];
    const vc = [car.vx, car.vy, car.vz];
    const rest = (1 - hit.s) * ctx.dt;
    for (let i = 0; i < 3; i++) p[i] = base[i] + hit.rel[i] + n[i] * push + (v[i] - vc[i]) * rest;
  }
  // A goal: the ball touching an end wall inside its goal mouth.
  if (Math.abs(p[1]) < GOAL_W && p[2] < GOAL_H && Math.abs(p[0]) + BALL_R >= X) {
    const team = p[0] > 0 ? "blue" : "orange";
    const score = { ...ctx.state.score, [team]: ctx.state.score[team] + 1 };
    ctx.state.score = score;
    ctx.emit("goal", { team, scorer: ctx.state.lastTouch, blue: score.blue, orange: score.orange });
    return kickoff(ctx, cars, true);
  }
  // Then off the world, box by box: the world has the last word, so no hit leaves it in a wall.
  for (const b of WORLD.boxes) {
    const contact = sphereBox(p, b[0], b[1], b[2], b[3], b[4], b[5]);
    if (contact === null) continue;
    for (let i = 0; i < 3; i++) p[i] += contact.n[i] * contact.push;
    bounceWorld(v, contact.n);
    changed = true;
  }
  const onFloor = p[2] - BALL_R <= SUPPORT;
  if (changed) {
    const speed = Math.sqrt(dot(v, v));
    if (speed > BALL_MAX) for (let i = 0; i < 3; i++) v[i] *= BALL_MAX / speed;
    // Settled on the floor: it rolls there, with no vertical speed and no gravity.
    const rolling = onFloor && Math.abs(v[2]) < IMPACT;
    if (rolling) {
      p[2] = BALL_R;
      v[2] = 0;
    }
    return launchBall(ctx, p, v, rolling);
  }
  // Rolling friction, every ROLL_TICKS ticks while a rolling ball moves.
  if (ball.g === 0 && ctx.tick - ball.t0 >= ROLL_TICKS && (v[0] !== 0 || v[1] !== 0)) {
    const speed = Math.sqrt(v[0] * v[0] + v[1] * v[1]);
    const next = Math.max(0, speed * (1 - ROLL_K * ROLL_TICKS * ctx.dt) - ROLL_DECEL * ROLL_TICKS * ctx.dt);
    const k = next < STOP_SPEED ? 0 : next / speed;
    launchBall(ctx, p, [v[0] * k, v[1] * k, 0], true);
  }
}

/** The cars, by id: one order on every run. */
function carsOf(ctx) {
  return ctx.entities.all().filter((e) => e.kind === "car").sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export default defineRoom({
  contract: 1,
  config: {
    tickHz: 60,
    maxPlayers: 4,
    // Every other parameter at its default (maxSpeed 1410, boost 2300, substeps 2); the sandbox
    // writes the world's hash into params.world.
    preset: { name: "vehicle", params: { radius: CAR_R, height: CAR_H } },
  },
  world: WORLD,
  init() {
    // carWas: each car's [x, y, z, epoch] at the end of the last tick, for the ball's sweep.
    return { team: {}, slot: {}, score: { blue: 0, orange: 0 }, lastTouch: "", carWas: {} };
  },
  onJoin(ctx, player) {
    // The team with fewer cars (blue on a tie), and its lowest free slot.
    const seats = Object.keys(ctx.state.team);
    const blue = seats.filter((s) => ctx.state.team[s] === "blue").length;
    const team = blue <= seats.length - blue ? "blue" : "orange";
    const taken = seats.filter((s) => ctx.state.team[s] === team).map((s) => ctx.state.slot[s]);
    const slot = taken.includes(0) ? 1 : 0;
    if (taken.length >= SLOTS[team].length) return;
    ctx.state.team[player.id] = team;
    ctx.state.slot[player.id] = slot;
    const id = ctx.entities.spawn({ kind: "car", owner: player.id, data: { team } });
    toSlot(ctx, ctx.entities.get(id), false);
  },
  onLeave(ctx, player) {
    const car = ctx.entities.ownedBy(player.id);
    if (car) ctx.entities.remove(car.id);
    delete ctx.state.team[player.id];
    delete ctx.state.slot[player.id];
    if (ctx.state.lastTouch === player.id) ctx.state.lastTouch = "";
  },
  onInput() {
    // The preset drives the car; the ball is judged once a tick, in step.
  },
  step(ctx) {
    const cars = carsOf(ctx);
    stepBall(ctx, cars);
    if (ctx.tick % REFILL_TICKS === 0) {
      for (const car of cars) if (car.fuel < 1) car.fuel = Math.fround(Math.min(1, car.fuel + REFILL));
    }
    const carWas = {};
    for (const car of carsOf(ctx)) carWas[car.id] = [car.x, car.y, car.z, car.epoch];
    ctx.state.carWas = carWas;
  },
});
```

package.json:

```json
{ "genex": { "authority": { "module": "server/room.js", "maxPlayers": 4 } } }
```

Validate it with `--root .`: the module imports `src/car-world.ts`, which is outside `server/`. It
uses no trigonometry (only `+ - * /`, `Math.sqrt`, `min` and `max`), so a replay is exact on every
server. Grow from here: boost pads are entities the module spawns, hides for a cooldown and refuels
from (`fuel: 1`); a bank along a side wall is a ramp, and the ball then needs a sphere test against
the ramp too (its closest point, never its plane); more players need more slots and, at eight cars,
the sub-step budget in [presets.md](presets.md).

### The client, with three.js

```ts
// src/cars.ts: joins the car arena, sends throttle, steer and buttons, draws what the server says.
import * as THREE from "three";
import { connectAuthority, type AuthorityEntityView } from "@genex-ai/multiplayer/authority";
import { getAuthorityUrls, getColyseusAuth, waitForPlayer } from "@genex-ai/embed-sdk";
import { GENEX } from "./genex.config";
import { BALL_R, CAR_H, GOAL_H, GOAL_W, WORLD, X } from "./car-world";

/** The preset's default buttons: jump, boost, drift. */
const JUMP = 1;
const BOOST = 2;
const DRIFT = 4;
/** Team colours; the car's team is in its data. */
const COLOUR: Record<string, number> = { blue: 0x3d8bff, orange: 0xff8a2a };

/** A refused join's code (JoinError) in the player's words. */
const REFUSED: Record<number, string> = {
  402: "Online play isn't available for this game right now.",
  424: "This game's server isn't ready yet.",
  426: "This game needs an update to play online.",
  429: "The game's servers are busy right now. Try again later.",
  503: "No game server is free right now. Try again in a moment.",
};

/** Server (x, y, z) to three.js (x, z, -y): z up becomes y up, with handedness kept. */
const toThree = (v: THREE.Vector3, x: number, y: number, z: number) => v.set(x, z, -y);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
document.body.append(renderer.domElement);
const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 2));
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 1, 20000);
const hud = document.createElement("div");
hud.style.cssText = "position:fixed;left:12px;top:12px;color:#fff;font:14px system-ui";
document.body.append(hud);

// The level drawn from the same boxes the cars collide with (the ceiling left out, so the camera sees).
WORLD.boxes.forEach((b, i) => {
  if (i === 1) return;
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(b[3] - b[0], b[5] - b[2], b[4] - b[1]),
    new THREE.MeshStandardMaterial({ color: i === 0 ? 0x2f6b3a : 0x8899aa, transparent: i > 0, opacity: i > 0 ? 0.25 : 1 }),
  );
  toThree(box.position, (b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2);
  scene.add(box);
});
// The goal mouths: blue defends -x, orange defends +x.
for (const [side, team] of [[-1, "blue"], [1, "orange"]] as const) {
  const goal = new THREE.Mesh(new THREE.PlaneGeometry(GOAL_W * 2, GOAL_H), new THREE.MeshBasicMaterial({ color: COLOUR[team], side: THREE.DoubleSide }));
  goal.rotation.y = Math.PI / 2;
  toThree(goal.position, side * (X - 2), 0, GOAL_H / 2);
  scene.add(goal);
}

const keys = new Set<string>();
addEventListener("keydown", (e) => keys.add(e.code));
addEventListener("keyup", (e) => keys.delete(e.code));

await waitForPlayer();
const session = await connectAuthority({
  urls: getAuthorityUrls(),
  room: GENEX.slug,
  auth: () => getColyseusAuth(),
  world: WORLD,
}).catch((err: { code?: number }) => {
  hud.textContent = REFUSED[err.code ?? 0] ?? "Couldn't join the game.";
  throw err;
});
session.on("disconnect", (code) => {
  hud.textContent = code === 4500 ? "The game was stopped." : "Disconnected from the game.";
});
let banner = "";
session.on("goal", (data) => {
  const goal = data as { team: string; scorer: string };
  banner = goal.scorer === session.id ? "You scored!" : `${goal.team} scores`;
  setTimeout(() => (banner = ""), 2000);
});

/** A car: a box about 118 long and 84 wide over the preset's square hull, its nose along +x. */
function makeCar(team: string): THREE.Group {
  const car = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(118, CAR_H, 84), new THREE.MeshStandardMaterial({ color: COLOUR[team] ?? 0xffffff }));
  body.position.y = CAR_H / 2;
  const nose = new THREE.Mesh(new THREE.BoxGeometry(20, 12, 60), new THREE.MeshStandardMaterial({ color: 0xffffff }));
  nose.position.set(59, CAR_H, 0);
  car.add(body, nose);
  return car;
}

const meshes = new Map<string, THREE.Object3D>();
function draw(entities: Map<string, AuthorityEntityView>): void {
  for (const [id, e] of entities) {
    let mesh = meshes.get(id);
    if (!mesh) {
      mesh = e.kind === "ball"
        ? new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 24, 16), new THREE.MeshStandardMaterial({ color: 0xf2f2f2 }))
        : makeCar(JSON.parse(e.data || "{}").team ?? "");
      scene.add(mesh);
      meshes.set(id, mesh);
    }
    toThree(mesh.position, e.x, e.y, e.z); // the ball from its flight; your car predicted; the others 100 ms behind
    mesh.rotation.y = e.yaw; // the heading, about three's up axis
  }
  for (const [id, mesh] of meshes) {
    if (entities.has(id)) continue;
    scene.remove(mesh);
    meshes.delete(id);
  }
}

const eye = new THREE.Vector3();
const target = new THREE.Vector3();
function loop(now: number): void {
  session.input.moveY = (keys.has("KeyW") ? 1 : 0) - (keys.has("KeyS") ? 1 : 0); // throttle: below 0 brakes, then reverses
  session.input.moveX = (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0); // steer: +1 turns right
  session.input.buttons = (keys.has("Space") ? JUMP : 0) | (keys.has("ShiftLeft") ? BOOST : 0) | (keys.has("KeyQ") ? DRIFT : 0);
  session.frame(now);
  draw(session.entities());
  const me = session.me();
  if (me) {
    // A chase camera behind the heading.
    toThree(eye, me.x - Math.cos(me.yaw) * 700, me.y - Math.sin(me.yaw) * 700, me.z + 300);
    camera.position.lerp(eye, 0.2);
    camera.lookAt(toThree(target, me.x, me.y, me.z + 100));
  }
  const score = JSON.parse(session.entity("ball")?.data || '{"blue":0,"orange":0}');
  const why = session.prediction.reason === "world_mismatch" ? " · world mismatch: not predicted" : "";
  hud.textContent = `blue ${score.blue} : ${score.orange} orange · boost ${Math.round((me?.fuel ?? 0) * 100)}${banner ? ` · ${banner}` : ""}${why}`;
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
```

What it shows, and what to keep when you change it:

- **One world, imported by both sides.** The module exports `WORLD` and the client passes the same
  object as `world`; a copy that differs by one number turns prediction off (the HUD says so).
- **The car is drawn with three's handedness kept**: `(x, z, -y)` and `rotation.y = yaw`, so the
  steer-right key (`moveX = +1`) turns the car right on screen. A mirrored drawing turns it left.
- **The client never moves the ball.** It comes from `session.entities()` already where its flight
  is this frame; every bounce, hit and roll is a re-launch the module wrote.
- **Fuel, score and goals come only from the server**: `fuel` on your car, the score in the ball's
  `data`, and the `goal` and `touch` events.
- **A touch looks a little early or late**, by about the one-way latency (presets.md says why).
  Test at `--latency 75` and judge whether it plays well there, not at zero.

## Template 4: a physics car arena (server physics)

The car arena of template 3 with the ball and four crate stacks simulated by the server's physics
core ([physics.md](physics.md)). Each car's hull pushes the ball and topples the crates; the module
only spawns the bodies, watches the ball for goals and puts everything back at a kickoff. Clients
draw the ball and the crates from the server, at its present. It needs the physics core
([physics.md](physics.md) says when Genex's servers run it).

### The world, shared by both sides

`src/car-world.ts` of template 3, plus the crates:

```ts
// src/car-world.ts, appended: the crate stacks.

/** A crate's half size, and the stacks: a pyramid of `rows` rows at (x, y). */
export const CRATE_HALF = 35;
export const STACKS = [
  { x: 1400, y: -1100, rows: 3 },
  { x: 1400, y: 1100, rows: 3 },
  { x: -1400, y: -1100, rows: 3 },
  { x: -1400, y: 1100, rows: 3 },
];

/** Every crate's id and home, bottom row first. */
export function crateHomes(): { id: string; x: number; y: number; z: number }[] {
  const out: { id: string; x: number; y: number; z: number }[] = [];
  STACKS.forEach((stack, s) => {
    for (let row = 0; row < stack.rows; row++) {
      const count = stack.rows - row;
      for (let i = 0; i < count; i++) {
        const offset = (i - (count - 1) / 2) * (CRATE_HALF * 2 + 2);
        out.push({ id: `crate.${s}.${row}.${i}`, x: stack.x + offset, y: stack.y, z: CRATE_HALF + row * (CRATE_HALF * 2 + 1) });
      }
    }
  });
  return out;
}
```

### The room module

```js
// server/room.js (physics car arena): runs on Genex's servers, never in a browser.
import { BALL_R, CAR_H, CAR_R, CRATE_HALF, GOAL_H, GOAL_W, WORLD, X, Y, crateHomes } from "../src/car-world";

const defineRoom = (room) => room;
const SLOTS = { blue: [[-1536, -512], [-1536, 512]], orange: [[1536, 512], [1536, -512]] };
const HEADING = { blue: 0, orange: -Math.fround(Math.PI) };
const KICKOFF_FUEL = Math.fround(0.34);
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

/** A car on its slot, at rest; the epoch bump makes every client snap. */
function toSlot(ctx, car, bump) {
  const team = ctx.state.team[car.owner];
  const [x, y] = SLOTS[team][ctx.state.slot[car.owner]];
  ctx.entities.update(car.id, {
    x, y, z: 0, vx: 0, vy: 0, vz: 0, yaw: HEADING[team], spin: 0, mstate: 0, fuel: KICKOFF_FUEL,
    epoch: bump ? car.epoch + 1 : car.epoch,
  });
}

/** A body back home at rest, its epoch bumped so clients snap rather than slide. */
function reset(ctx, id, p) {
  ctx.physics.setPose(id, { p, q: IDENTITY }, { resetVelocity: true, wake: true });
  const entity = ctx.entities.get(id);
  if (entity) ctx.entities.update(id, { epoch: entity.epoch + 1 });
}

function kickoff(ctx, cars) {
  reset(ctx, "ball", { x: 0, y: 0, z: BALL_R });
  ctx.entities.update("ball", { data: ctx.state.score });
  for (const home of crateHomes()) reset(ctx, home.id, { x: home.x, y: home.y, z: home.z });
  for (const car of cars) toSlot(ctx, car, true);
  ctx.state.lastTouch = "";
}

function carsOf(ctx) {
  return ctx.entities.all().filter((e) => e.kind === "car").sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export default defineRoom({
  contract: 1,
  config: {
    tickHz: 60,
    maxPlayers: 4,
    preset: { name: "vehicle", params: { radius: CAR_R, height: CAR_H } },
    // lengthUnit 100 and gravity 650 come from the vehicle preset.
    physics: { subscribe: ["ball"], player: { events: true } },
  },
  world: WORLD,
  init(ctx) {
    ctx.entities.spawn({ id: "ball", kind: "ball", z: BALL_R, data: { blue: 0, orange: 0 } });
    ctx.physics.spawn({
      key: "ball", kind: "ball", type: "dynamic", ccd: true, linearDamping: 0.15, angularDamping: 0.4,
      pose: { p: { x: 0, y: 0, z: BALL_R }, q: IDENTITY },
      colliders: [{ key: "ball", shape: { kind: "sphere", radius: BALL_R }, density: 0.2, restitution: 0.65, events: true }],
    });
    for (const home of crateHomes()) {
      ctx.entities.spawn({ id: home.id, kind: "crate", x: home.x, y: home.y, z: home.z });
      ctx.physics.spawn({
        key: home.id, kind: "crate", type: "dynamic",
        pose: { p: { x: home.x, y: home.y, z: home.z }, q: IDENTITY },
        colliders: [{ key: "box", shape: { kind: "box", half: { x: CRATE_HALF, y: CRATE_HALF, z: CRATE_HALF } }, density: 0.5, friction: 0.7 }],
      });
    }
    return { team: {}, slot: {}, score: { blue: 0, orange: 0 }, lastTouch: "" };
  },
  onJoin(ctx, player) {
    const seats = Object.keys(ctx.state.team);
    const blue = seats.filter((s) => ctx.state.team[s] === "blue").length;
    const team = blue <= seats.length - blue ? "blue" : "orange";
    const taken = seats.filter((s) => ctx.state.team[s] === team).map((s) => ctx.state.slot[s]);
    if (taken.length >= SLOTS[team].length) return;
    ctx.state.team[player.id] = team;
    ctx.state.slot[player.id] = taken.includes(0) ? 1 : 0;
    const id = ctx.entities.spawn({ kind: "car", owner: player.id, data: { team } });
    toSlot(ctx, ctx.entities.get(id), false);
  },
  onLeave(ctx, player) {
    const car = ctx.entities.ownedBy(player.id);
    if (car) ctx.entities.remove(car.id);
    delete ctx.state.team[player.id];
    delete ctx.state.slot[player.id];
  },
  onInput() {
    // The preset drives the car; the server's physics moves the ball and the crates.
  },
  step(ctx) {
    const cars = carsOf(ctx);
    for (const ev of ctx.physics.events) {
      if (ev.kind !== "contactBegin" || (ev.a !== "ball" && ev.b !== "ball")) continue;
      const car = ctx.entities.get(ev.a === "ball" ? ev.b : ev.a);
      if (car && car.kind === "car") ctx.state.lastTouch = car.owner;
    }
    const ball = ctx.physics.body("ball");
    if (!ball) return;
    const { x, y, z } = ball.p;
    if (Math.abs(y) < GOAL_W && z < GOAL_H && Math.abs(x) + BALL_R >= X - 4) {
      const team = x > 0 ? "blue" : "orange";
      ctx.state.score = { ...ctx.state.score, [team]: ctx.state.score[team] + 1 };
      ctx.emit("goal", { team, scorer: ctx.state.lastTouch, blue: ctx.state.score.blue, orange: ctx.state.score.orange });
      kickoff(ctx, cars);
    } else if (Math.abs(x) > X + BALL_R || Math.abs(y) > Y + BALL_R || z < -BALL_R) {
      kickoff(ctx, cars);
    }
  },
});
```

### The client

Template 3's client, with two changes in `draw`: a crate gets its own mesh, and a body is turned
by its quaternion instead of a heading (z up becomes y up for both):

```ts
const crate = () => new THREE.Mesh(new THREE.BoxGeometry(70, 70, 70), new THREE.MeshStandardMaterial({ color: 0xb07a3c }));

function draw(entities: Map<string, AuthorityEntityView>): void {
  for (const [id, e] of entities) {
    let mesh = meshes.get(id);
    if (!mesh) {
      mesh = e.kind === "ball"
        ? new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 24, 16), new THREE.MeshStandardMaterial({ color: 0xf2f2f2 }))
        : e.kind === "crate" ? crate() : makeCar(JSON.parse(e.data || "{}").team ?? "");
      scene.add(mesh);
      meshes.set(id, mesh);
    }
    toThree(mesh.position, e.x, e.y, e.z); // a body at the server's present; your car predicted; other cars 100 ms behind
    if (e.body) mesh.quaternion.set(e.qx, e.qz, -e.qy, e.qw);
    else mesh.rotation.set(0, e.yaw, 0);
  }
  for (const [id, mesh] of meshes) {
    if (entities.has(id)) continue;
    scene.remove(mesh);
    meshes.delete(id);
  }
}
```

What to keep when you change it:

- **Spawn the entity, then its body**, and never write a body entity's `x y z` from the module.
- **A kickoff is `setPose` plus an `epoch` bump**, so clients snap; without the bump they slide the
  ball and the crates back across the arena.
- **The client never moves a body.** It draws what `session.entities()` says, already extrapolated
  to the server's present.
