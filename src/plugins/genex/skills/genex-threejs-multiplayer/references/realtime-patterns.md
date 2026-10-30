# Realtime patterns: rendering, objects, host, events, persistence

The `@genex-ai/multiplayer` SDK smooths remote players **and shared objects** for you (client-side
entity interpolation on a shared clock). These are the patterns you build on top — none of them
re-implement smoothing, because doing so is the mistake that makes games lag.

## The golden rule

- **Remote players & objects:** draw `players.get(id).state` / `objects.get(id).state` directly.
  Already smoothed.
- **Yourself & objects you own:** draw from your own local object. Never from the network echo.

If you ever buffer `state` and lerp between snapshots, stop — you're rebuilding smoothing the SDK
already did, and stacking two smoothers adds visible lag.

## Complete movement example (players)

```ts
import * as THREE from "three";
import { connect } from "@genex-ai/multiplayer";
import { waitForPlayer, getColyseusAuth } from "@genex-ai/embed-sdk";
import { GENEX } from "./genex.config";

// Your published state — EVERY synced field, including discrete ones like hp. `me.set`
// replaces your state wholesale, so the tick must send all of these every time (below).
type S = { x: number; z: number; q: number[]; hp: number };

const { user } = await waitForPlayer();  // player gate (guest OR signed-in) — never waitForAuth()
const room = await connect<S>({
  urls: getColyseusUrls(),
  room: GENEX.slug,
  name: user.name,
  auth: () => getColyseusAuth(), // REQUIRED — resolved fresh for this connect; NEVER log it.
});

// --- local player: input mutates this; we render yourself from it (zero latency) ---
// This ONE object holds everything you sync. Keep hp/ammo/etc. here too — see the warning below.
const me = { x: 0, z: 0, yaw: 0, hp: 100 };
addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft") me.yaw += 0.1;
  if (e.key === "ArrowRight") me.yaw -= 0.1;
  if (e.key === "ArrowUp") { me.x += Math.sin(me.yaw); me.z += Math.cos(me.yaw); }
});

// rotation helper — turn our yaw into the quaternion we publish (and send with shots, below)
const _q = new THREE.Quaternion();
const myQuat = (): number[] => _q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), me.yaw).toArray();

// --- publish at ~15 Hz (NOT per frame). Send the WHOLE state — a field you omit is deleted. ---
const tick = setInterval(() => {
  room.me.set({ x: me.x, z: me.z, q: myQuat(), hp: me.hp });
}, 66);
```

> **`me.set` replaces your state wholesale.** Every tick must include EVERY field — position,
> rotation, AND discrete values like `hp`/`ammo`. A field you leave out is gone on the wire, so
> keep one local `me` object with all of them and publish it whole each tick. (Same for
> `objects.set`.)

```ts

// --- meshes, one per id ---
const meshes = new Map<string, THREE.Object3D>();
function meshFor(id: string) {
  let m = meshes.get(id);
  if (!m) { m = new THREE.Mesh(boxGeo, boxMat); scene.add(m); meshes.set(id, m); }
  return m;
}
room.on("leave", (id) => {
  const m = meshes.get(id);
  if (m) { scene.remove(m); meshes.delete(id); }
});

function frame() {
  // yourself: render from the local object (zero latency)
  const self = meshFor(room.id);
  self.position.set(me.x, 0, me.z);
  self.rotation.y = me.yaw;

  // everyone else: draw state DIRECTLY — it is already smoothed
  for (const [id, p] of room.players) {
    if (id === room.id) continue;
    const m = meshFor(id);
    m.position.set(p.state.x ?? 0, 0, p.state.z ?? 0);
    if (p.state.q) m.quaternion.fromArray(p.state.q);   // slerped for you by the SDK
  }

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
frame();
```

No interpolation buffer, no render-delay constant, no lerp of remote state — the SDK owns all of it.

## A shared object (the ball) — `objects`, not `shared`

A ball belongs to no player. On `objects`, exactly one client **owns** it at a time (server-
enforced), the owner simulates it, and everyone else reads it auto-smoothed — on the same
interpolation as a player. The stream is keyed by the object id, so it stays continuous when
ownership changes (no snap), and the object survives its owner leaving (reassigned to the host).

```ts
// ball.ts
const ball = { x: 0, y: 0.5, z: 0, vx: 0, vy: 0, vz: 0 }; // the owner's local sim

// Confirm on the contact edge; retry a `held` result only while contact remains.
async function kick(dir: THREE.Vector3, power: number) {
  const result = await room.objects.claimConfirmed("ball");
  if (!result.accepted) return;
  ball.vx += dir.x * power; ball.vz += dir.z * power;
}

// in your fixed tick: if you own it, simulate + publish it (flat fields so it smooths)
function publishBall() {
  const view = room.objects.get("ball");
  if (view?.isMine) {
    stepBallPhysics(ball);                     // your own integrator or Rapier
    room.objects.set("ball", { x: ball.x, y: ball.y, z: ball.z });
  }
}

// render: owner draws its local sim (zero latency); everyone else draws the smoothed state
function drawBall() {
  const view = room.objects.get<{ x: number; y: number; z: number }>("ball");
  if (!view) return;
  ballMesh.position.set(view.state.x ?? 0, view.state.y ?? 0, view.state.z ?? 0);
}
```

Rules that keep it correct:

- **Confirm ownership before an irreversible interaction.** On `held`, respect `retryAfterMs` and
  retry only while the original contact/action is still valid.
- **Keep object fields flat** (`x/y/z`, a 4-number quaternion). Nested objects snap instead of glide.
- **Only the owner's `set` lands** — the relay drops writes from non-owners, so you never get two
  clients fighting over the ball. You don't need to check "am I owner" before drawing, only before
  simulating.
- **Transient objects** (bullets, pickups): the owner awaits `room.objects.removeConfirmed(id)`
  when they expire, so destruction is acknowledged and idempotent across reconnects. Every
  spawned id counts against the room's 128-object limit until removed, and each live
  projectile publishing at 30 Hz spends 30/s of your bulk budget.

## Host authority (scores, rounds, world)

One client is `room.host` — the earliest **signed-in** player (guests host only while no account
is present), and the host can change on **join** as well as leave: the first account entering a
guest-hosted room takes over. Always react to `on('host')` / read `isHost` in your loop, never
once at startup.

`room.on('shared', …)` fires on every **distinct** change of a key (a set to the same value is
de-duped) — but for a value you render every frame, read `room.shared.get(...)` in your loop rather than wiring render state through the event.

## Custom events (shots, emotes)

For one-off actions that aren't continuous state, use `send`. (Text chat is NOT one of these —
it has its own channel, `room.chat`; see below.)

**`send` reaches only OTHER clients — it never echoes back to you.** So apply your own action's
visible effect *directly* at fire time; use `on(...)` only to render everyone else's:

```ts
function fire() {
  spawnTracer(me.x, me.z, myQuat());          // MY tracer — right here, not via on("shot")
  room.send("shot", { from: room.id, x: me.x, z: me.z, q: myQuat() });
}

room.on("shot", (m: any) => {
  spawnTracer(m.x, m.z, m.q);                 // OTHER players' tracers
});
```

Read remote positions for hit-testing from `stateRaw` (raw latest), not `state` (rendered in the
past). Guard the lookup — a player may have just left:

```ts
const t = room.players.get(id);
if (!t) return;
const px = t.stateRaw.x, pz = t.stateRaw.z;   // test against the raw latest
```

## Text chat

Chat has its own channel — **never build it on `send`**. The relay stamps the sender from the
verified session, sanitizes the text, and replays the recent history to late joiners; `send` gives
you none of that and lets a client post under any name it likes.


The API's three behaviours:

```ts
room.chat.send("on my way");            // your OWN line comes back via on() — don't also append it
room.chat.on((m) => {
  el.textContent = `${m.name}: ${m.text}`;   // textContent, NEVER innerHTML — remote input
});
room.chat.history;                       // render on mount: a late joiner sees the conversation
```

- **Your own lines echo back** (unlike `send`), in server order with the server's timestamp.
  Appending locally on submit shows every message twice.
- **`m.name` is relay-verified** — safe to display, and a player cannot post under another name.
- **`m.text` is sanitized but not markup-escaped** — control and bidi characters are stripped by
  the relay, but you must still render it as text.

Chat has its own rate budget (~2 lines/second per player), separate from gameplay traffic: a chat
flood cannot starve movement, and a busy game cannot starve chat.

## Persistence helper

```ts
// persistence.ts — the embed SDK owns tokens, guest handling, and conflict
// decoding (see the genex-threejs-embed-auth skill). World slot = shared
// layout only; per-player progression goes in savePlayerState() instead.
import { loadWorldState, saveWorldState } from "@genex-ai/embed-sdk";

let worldVersion = 0;

export async function loadWorld<T>(fallback: T): Promise<T> {
  try {
    const { data, version } = await loadWorldState(); // waits for identity itself
    worldVersion = version;
    return (data as T) ?? fallback;
  } catch { return fallback; }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let latest: unknown;
export function saveWorld(world: unknown) {
  latest = world;                            // debounce: at most one write/sec, host only
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; void flushWorld(); }, 1000);
}

async function flushWorld() {
  const res = await saveWorldState(latest, { ifVersion: worldVersion }).catch(() => null);
  if (!res) return;
  if (res.saved) worldVersion = res.version!;
  else if (res.conflict) worldVersion = res.version!; // stale after a host race — next save wins
}

// The host closing their tab must not lose the last edits: flush immediately
// when the page goes hidden (savePlayerState/saveWorldState small writes ride
// fetch keepalive, so this completes even mid-unload).
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    void flushWorld();
  }
});
```

State is one JSON blob per project, max 1 MB, shared by every player. Save from a single
authority (`room.isHost`) so concurrent writers don't clobber each other; `ifVersion` turns
any remaining race into a visible `conflict` instead of silent data loss. Guests can't
write it — the relay prefers signed-in players as host, so saving works whenever any
account is in the room (guest-only rooms simply don't persist until one joins).
