// The client session of a server-authoritative room (PROTOCOL.md §17, protocol 4) over the official
// Colyseus C core v0.18.10, in polled mode.
//
// Port of sdks/godot/addons/genex_multiplayer/authority_native.gd (the same C predict API, through the
// GDExtension), cross-checked line by line with sdks/unity/Runtime/Core/Authority/GenexAuthoritySession.cs
// and the TypeScript reference packages/multiplayer/src/authority/session.ts (`connectAuthority`).
// Where Godot and Unity differ, the newer measured decision in docs/knowledge/engine-sdks.md wins and
// the .cpp says so at that spot.
//
// The server simulates; this client sends typed input and renders. Per render frame the game calls
// Frame(): the C core's Predict says how many fixed input steps are due and the session sends one
// AuthorityInput per step (the staged `input`, sanitized as the server will), the reconciler predicts
// the entity this seat owns with the room's movement preset (GenexPresets.h: the server's own step,
// bit for bit) and rewinds-and-replays when the server's truth arrives, and every other entity is
// drawn renderDelayMs in the past on the render time the server's lag compensation rewinds to,
// serverNow - renderDelay - rtt/2, interpolated from this session's own record of the server-stamped
// patches (the measurement behind that choice: sdks/unreal/SPIKE.md "The C core's lerp"), with its
// respawn (an epoch bump) snapped on that same timeline (§17.3).
//
// A `firstperson` or `vehicle` room (§17.7) is predicted only while the client's collision world
// (SetWorld, or AuthorityOptions::world) hashes to the room's `params.world`; otherwise the own entity is
// drawn from the server's state like any other, and PredictionStatus() says why (`world_mismatch`). Its
// views carry the body's aim pitch, duck amount, movement bits and speed cap: predicted (pitch, duck,
// mstate) for your own, interpolated (pitch straight, a bounded angle, held to the preset's pitchLimit;
// duck) for every other; and a vehicle's yaw rate and fuel (`spin`, `fuel`): predicted for yours, the
// server's latest for others. Your own heading is drawn as an angle (along the short arc across ±π,
// never the long way round a plain-number interpolation takes when a predicted heading wraps), and
// every other entity's is interpolated as one.
//
// Projectiles (§17.9: an entity with a launch tick, t0 > 0) are neither: each is drawn from its
// closed-form flight (presets::ProjectileAt) at the server's present, serverTick(now), never
// interpolated, and never taken as your own entity. One you fire is predicted (PredictProjectile,
// while staging the input that fires it) on the C core's predicted-spawn store (colyseus_spawns_*,
// the port of @colyseus/sdk/predict's PredictedSpawns), keyed `<seat>.<seq>.<n>`: drawn at once from
// its own launch, handed over in place to the server's projectile of that id and drawn `lead` ahead
// of the present while it is still yours (so the flight never snaps back by lead × velocity), and
// dropped unconfirmed once a state patch acknowledging its firing input lacks it (TTL
// max(2·RTT, 600 ms) only as the fallback).
//
// Physics bodies (§17.10: an entity with a descriptor in the room state's `bodies`) are drawn, outside
// physics prediction (below): at the server's present, extrapolated on the room clock from the latest state
// the server sent, with each newer state's correction eased out over 100 ms and a snap on an epoch
// change, an offset over one metre or a fresh descriptor (genex::bodies::BodyDrawer, GenexBodies.h, held
// to physics-draw.json). Every other entity is drawn renderDelayMs behind as above. A body whose entity
// leaves this client's view (§17.10 *Interest*) is held at its last state while its descriptor stays.
// Every authority join sends `caps: ['physics@1']`, so a physics room seats this client (one without it
// is refused 426); a physics room's own entity is never a body entity.
//
// Physics prediction (§17.11, physics-predict-session.ts): given the game's physics core
// (AuthorityOptions::physicsCore, or physicsCoreLoader called when a room first sends keyframes: the
// plugin's C ABI bound by GenexCore/GenexPhysicsNative.h) the join
// also claims `physics@2`, and in a predicting room (the state carries `physDesc` and keyframes) the
// bodies near you are stepped in a client world of their own (genex::physics::PhysicsPredictor, held to
// physics-predict.json) and drawn at your present (`predicted` on the view); every other body is drawn
// as above. PhysicsPrediction() reports its status: `on`, `off` (the kill switch predictPhysics false,
// no core given, or the session ended), `loading`, `unavailable` (the loader gave no core), `mismatch`,
// `self_test`, `diverged` or `cpu` (which keeps the client world and probes its way back: `fallbacks` and
// `recoveries` count it). The room module's rules run in the prediction when given (AuthorityOptions::contacts,
// bodyRule, seatRule; GenexOwnPredict.h StepOwnInput): the seat rule before each of your predicted inputs,
// the seat contacts after it, the body rule before every client-world step; at every keyframe your inputs in
// flight are stepped again from the server's state of your entity (OwnPath) before the adoption, so a replay
// poses your preset body where the corrected prediction has it. In a predicting room other entities are drawn
// on the tick timeline (GenexTickDrawing.h: each keyframe patch sampled at its tick, never across an epoch)
// unless AuthorityOptions::remoteSamples is Patch.
//
// Deliberately NOT shared with the relay session: no §16 heartbeat (on an authority room the input
// channel IS the game's input, so a heartbeat would be simulated as blank input), no host, objects or
// shared map. Reconnection is §8's: in place, no send queue, and once the reconnect's first state
// lands the prediction is rebuilt from the server's state, so nothing sent before the drop replays.
//
// Single-threaded and pumped (sdks/unreal/core/DESIGN.md): the session registers itself with
// genex::Pump; Pump::Frame polls the C core and then calls Update, which handles what the core's
// callbacks queued (join, drop, reconnect, leave, messages) and the timers (capacity retry, the
// post-reconnect deadline, the stalled-handshake drop, the clock warm-up). Update never sends input:
// only Frame does, so a game that stops calling Frame sends nothing (no heartbeat). Drain what happened
// with DrainEvents() after the frame. No room is ever freed inside its own callback.
#pragma once

#include "GenexCore/GenexAuthorityRegions.h"
#include "GenexCore/GenexRoomKey.h"
#include "GenexCore/GenexBodies.h"
#include "GenexCore/GenexConfig.h"
#include "GenexCore/GenexFastClient.h"
#include "GenexCore/GenexFirstperson.h"
#include "GenexCore/GenexIdentity.h"
#include "GenexCore/GenexInput.h"
#include "GenexCore/GenexJson.h"
#include "GenexCore/GenexPhysicsPredictor.h"
#include "GenexCore/GenexPresets.h"
#include "GenexCore/GenexPump.h"
#include "GenexCore/GenexSeatContacts.h"
#include "GenexCore/GenexSeatPredict.h"

#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace genex {

namespace authority_session_detail {
struct Impl;
struct RejoinRun;
struct RegroupRun;
}  // namespace authority_session_detail

/** How other entities' samples are timed in a predicting room (§17.11 *Drawing other seats*). */
enum class RemoteSamples : std::uint8_t {
  /** By their keyframe's tick (tickOrigin + tick · 1000 / tickHz): the default. */
  Tick,
  /** By the patch's server stamp, as in a room that does not predict physics (kept for comparison). */
  Patch,
};

/** How other seats are drawn with a seat contact rule (§17.11 *Drawing other seats*). */
enum class SeatDrawing : std::uint8_t {
  /** The default, the Rocket League model: every other seat predicted on your entity's clock, stepped from the
   *  latest state by the room preset under its last input (`remotePredict`) with the room's contact pass on every
   *  seat, yours included (SeatWorld), each correction drawn as a decaying offset; then kept out of yours and out
   *  of each other (SeparateSeats). */
  Predicted,
  /** On the render timeline, moved out of your drawn entity by the rule and taken round it, never across it, and
   *  out of each other (draw-only). */
  Separate,
  /** On the render timeline only, where a seat that missed yours on the server can be drawn through it. */
  Timeline,
};

/** How an authority session joins and draws. */
struct AuthorityOptions {
  /** Connect to THIS exact URL (wins over `urls`). */
  std::string url;
  /** The authority cluster's URLs (EmbedIdentity::AuthorityUrls()). Without `regions` each is a region of
   *  its own (PROTOCOL.md §17.1 *Regions*): one is used directly; several are probed for latency. With
   *  neither, GENEX_AUTHORITY_URL (Studio's local server); with none of the three the join is refused. */
  std::vector<std::string> urls;
  /** The cluster's regions (EmbedIdentity::AuthorityRegions(), §17.1 *Regions*): one url per sample of each
   *  region is probed (3 samples, 4 s ceiling, 1 s grace after the first answer), a pool join looks for players
   *  in the regions in reach first (`regionRule`), then the nearest region is joined, and a join refused 503
   *  twice there moves to the next-best one at once. Each region is its own matchmaking pool. Empty: `urls` are
   *  the regions. */
  std::vector<regions::Region> regions;
  /** How a pool join picks its region (§17.1 *Finding players*). Players (the default): the regions in reach are
   *  asked for a room that already has players (Colyseus's plain join), nearest first, and a room is opened in the
   *  nearest one only when none has. Nearest: the nearest region, whoever is elsewhere. A join by code, a private
   *  create, a rejoin and `url` never search. */
  regions::RegionRule regionRule = regions::RegionRule::Players;
  /** The farthest region asked for players, as a probe's round trip in ms; anything but a finite number >= 0 is
   *  regions::kMaxPingMs (350). */
  double maxPingMs = regions::kMaxPingMs;
  /** The one region to play in, by its name in `regions` (a player's own choice; without `regions` a flat url is its
   *  own name): no other is joined or created in. Empty, or a name the cluster does not have, is no pin. A join by
   *  code ignores it and still walks every region. */
  std::string region;
  /** The game's slug: everyone who passes the same id shares a room. Must equal the token's `slug`. */
  std::string gameId;
  /** Display-name fallback; the verified token's name wins. */
  std::string name;
  /** Extra join options (an object). Server-owned names are dropped (GenexUrl.h BuildJoinOptions). */
  Json extra = Json::MakeObject();
  /** A FRESH `embed:play` token before every join attempt (§3.2), never cached. Empty against a
   *  LOOPBACK server: the local placeholder `local:test` is sent (RequestJoinOptions). */
  TokenProvider tokenProvider;
  /** Predict your own entity (default true): with `prediction` when set, else the room's preset. */
  bool predict = true;
  /** Your own prediction step (a known preset with your parameters). Must be the server's step: it
   *  is used as given (a firstperson one through the session's world), never gated on the world. */
  std::optional<Prediction> prediction;
  /** The pool to join (§17.2 *Choosing a room*): players with one key share rooms, and the room module reads it at
   *  init to choose a world or mode. Empty: the game's one pool. Give the world the key picks to `world`
   *  (room_key::SelectMatchWorld). */
  std::string matchKey;
  /** Create a private room: Code() is the invite, and no matchmaking reaches it. `matchKey` chooses its world. */
  bool createPrivate = false;
  /** Join the room with this invite code, walking the regions until one holds it. */
  std::optional<std::string> joinCode;
  /** Whether a seat whose room ended for a deploy, or whose socket no reconnect restored, goes back into play
   *  by itself (§17.13 *Drain and rejoin*). Default true; false makes that close final. */
  bool rejoin = true;
  /** Whether a player who is alone in a pool room keeps asking for a room that already has players and moves there
   *  (§17.1 *Regrouping*): only the regions listed before the seat's own, in reach, are asked, after each wait of
   *  regions::kRegroupWaitsMs, and the game hears Rejoined with `moved`. Default true; false keeps the player where
   *  they are. Needs `rejoin`; a private room, a join by code, `url`, a pinned region and the rule Nearest never
   *  regroup. */
  bool regroup = true;
  /** The `firstperson` collision world, as the room module exports it (SetWorld later, too); nullptr =
   *  the empty world. Your own entity is predicted only while its hash is the room's `params.world`. */
  FirstpersonWorldPtr world;
  /** The physicsHash (16 hex digits, C§10.2) of a physics world this client runs a copy of (SetPhysics
   *  later, too). No SDK steps bodies in this release, so a mismatch is only reported (PhysicsStatus). */
  std::string physics;
  /** The game's physics core (§17.11): with it (or physicsCoreLoader), a predicting physics room's bodies
   *  near you are predicted and the join claims physics@2. With neither, nothing is predicted and
   *  PhysicsPrediction() says `off`, as physics-predict-session.ts does without a core. */
  std::shared_ptr<physics::PredictCore> physicsCore;
  /** Loads the core the first time a room sends keyframes (§17.11: "the core loads only once a room
   *  sends keyframes"), when physicsCore is unset; nullptr from it is `unavailable`. Called once, on the
   *  thread that pumps the session. The plugin's subsystem hands FGenexMultiplayerModule::PhysicsCore. */
  std::function<std::shared_ptr<physics::PredictCore>()> physicsCoreLoader;
  /** The client's kill switch (§17.11 `predictPhysics`): false never predicts and never claims physics@2. */
  bool predictPhysics = true;
  /** The device's replay budget, ms (§17.11 *Budgets*: 4 desktop, 5 mobile; the plugin's subsystem sets
   *  the mobile one on iOS and Android). */
  double physicsResimBudgetMs = physics::kResimBudgetDesktopMs;
  /** A replay budget, ms, that overrides the device's when finite and over 0; anything else is ignored
   *  (AuthorityEffectiveBudgetMs). For benches and tests that hold every engine to one budget. */
  std::optional<double> physicsBudgetMs;
  /** The room module's seat contact rule (§17.11 *Seat contacts*: a car-to-car bump, a pure function of
   *  two seats' entities), run in your own entity's prediction after each input against every other
   *  seat. It must be the module's very rule. None: a room that declares `config.contacts` (*Contact policy*)
   *  runs the resolved policy its state's preset text carries as this rule, the pass and the drawing guard;
   *  any other room's contacts between seats arrive as corrections. */
  ContactRule contacts;
  /** The room module's whole seat contact pass (§17.11 *Seat contacts*: car-ball's pairs, pile passes and world
   *  passes), which SeatDrawing::Predicted runs on every seat after each predicted tick; none: `contacts` once on
   *  every pair. It must be the module's very pass. */
  SeatPassRule contactPass;
  /** The room module's body rule (§17.11 *Body rules*: a scripted hit on a ball), run before every step
   *  of the client world; none: what the module does to its bodies arrives as a correction. */
  physics::BodyRule bodyRule;
  /** The room module's seat rule (§17.11 *Seat rules*: a kickoff release), run on your own entity before
   *  each predicted input at the tick it is applied on (the state's tick + seq − ack), on the fields your
   *  prediction mirrors (a vehicle's include `cap`), and, in an `inputDecay` room, on each other seat's
   *  body before each of its steps; none: a release arrives as a correction, a round trip late. */
  physics::SeatRule seatRule;
  /** The room module's kinematic rule (§17.11 *Kinematic rules*: where it poses its kinematic bodies at each
   *  tick), run before every step of the client world; none: they hold the keyframe's pose and are drawn from
   *  the server's states. */
  physics::KinematicRule kinematicRule;
  /** How other entities' samples are timed in a predicting room (§17.11 *Drawing other seats*): Tick
   *  (default) by their keyframe's tick, Patch by the patch's server stamp. A room that does not predict
   *  physics always draws by the patch stamp. */
  RemoteSamples remoteSamples = RemoteSamples::Tick;
  /** How other seats are drawn with seat contacts (§17.11 *Drawing other seats*): Predicted, Separate or Timeline;
   *  none (the default): a declared contact policy's `drawing` (*Contact policy*), else Predicted. */
  std::optional<SeatDrawing> seatDrawing;
  /** How far in the past other entities render, ms (AuthorityTiming.RENDER_DELAY_MS). */
  double renderDelayMs = 100.0;
  /** The output spring on other entities, ms (display only; 0 = off; never across a respawn). Seats drawn
   *  Predicted take the shared seat offset instead (kSeatTauMs). */
  double remoteSmoothMs = 25.0;
  /** Waits before each retry of a join refused for capacity (503). Empty never retries. */
  std::vector<double> capacityRetryMs = {1000.0, 2000.0, 4000.0};
  /** The fast channel (PROTOCOL.md §17.12, GenexFastSeat.h): how this client opens a datagram socket to the
   *  room's endpoint (the plugin's FSocket UDP opener in Unreal, on by default). Given, the join asks for
   *  `fast@1`: in a room that offers it your inputs and the room's motion go by datagram, everything else
   *  stays on the WebSocket, and the seat falls back to the WebSocket by itself (Fast() says when and why).
   *  Empty: a WebSocket seat. */
  fast::SocketOpener fast;
  /** Where the transport line goes (GenexFastLine.h); default stderr. The plugin sends it to LogGenex. */
  std::function<void(const std::string&)> fastLog;
  /** The millisecond clock the fast channel's deadlines and round trips run on (default Clock::NowMs). */
  std::function<double()> fastClock;

  // ---- test seams (smoke, edge, driver; never for games) ----
  /** Send this `protocol` instead of 4 (the 426 edge case). */
  std::optional<int> protocolOverride;
  /** Send these `caps` instead of {"physics@1"} (a physics room's 426 refusal). */
  std::optional<std::vector<std::string>> capsOverride;
  /** Read GENEX_AUTHORITY_URL from here instead of the process environment (offline URL tables). */
  std::optional<std::string> environmentAuthorityUrl;
  /** The waits of §17.1 *Regrouping* instead of regions::kRegroupWaitsMs (the last repeats), so a test runs the
   *  schedule in seconds. */
  std::optional<std::vector<double>> regroupWaitsMs;
  /** Also attach the C core's own lerp (colyseus_predict_attach_all, LERP at renderDelayMs) to every
   *  entity, so ProbeRemote can compare it with the session's timeline. Display is unchanged. */
  bool probeCoreLerp = false;
};

/** A projectile your game fires, as it predicts it (AuthoritySession::PredictProjectile): where it
 *  starts, its velocity and its gravity, in world units — the values the room module launches it with. */
struct ProjectilePrediction {
  std::string kind;
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
  double vx = 0.0;
  double vy = 0.0;
  double vz = 0.0;
  /** Downward acceleration along −z, units/s², [0, 1000]. */
  double g = 0.0;
};

/** The client's own estimate of the room clock (§16.1's sNow scale, ms) and the room's tick at that
 *  instant, `(serverNow − tickOrigin) · tickHz / 1000` (fractional): the clock projectiles are drawn by. */
struct AuthorityServerClock {
  double serverNow = 0.0;
  double serverTick = 0.0;
  double tickHz = 0.0;
};

/** An entity as this client draws it. */
struct AuthorityEntityView {
  std::string id;
  std::string kind;
  /** The owning seat's session id, or "". */
  std::string owner;
  bool isMine = false;
  /** Drawn: predicted for your own entity, renderDelayMs behind on the render timeline for others. */
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
  /** Drawn heading, radians in [-π, π). */
  double yaw = 0.0;
  double vx = 0.0;
  double vy = 0.0;
  double vz = 0.0;
  double hp = 0.0;
  double flags = 0.0;
  /** The life being drawn: lags the server's by the render delay around a respawn. */
  double epoch = 0.0;
  /** The entity's JSON text ("" = none). */
  std::string data;
  /** A projectile's launch tick (§17.9), 0 = not a projectile. A projectile's x..vz are drawn from its
   *  flight at the server's present; your own unconfirmed prediction's t0 is the (fractional) tick it
   *  was fired at, a server projectile's an integer. */
  double t0 = 0.0;
  /** A projectile's downward acceleration, units/s². */
  double g = 0.0;
  /** The seat that fired a projectile ("" = none). */
  std::string src;
  /** A firstperson body's aim pitch, radians: predicted for yours, interpolated straight for others (a
   *  bounded angle, never along the short arc), held to the room's ±pitchLimit (±π for any other preset). */
  double pitch = 0.0;
  /** A firstperson body's duck amount, 0 standing to 1 fully ducked: predicted or interpolated. */
  double duck = 0.0;
  /** A firstperson body's movement bits (1 onGround, 2 ducking, 4 jumpHeld): predicted for yours, the
   *  server's latest for others. */
  double mstate = 0.0;
  /** A firstperson body's speed multiplier, or a vehicle's top-speed multiplier, as the server last
   *  wrote it. */
  double cap = 1.0;
  /** A vehicle body's yaw rate, rad/s, positive toward +yaw: predicted for yours, the server's latest
   *  for others (for wheels and skids; the heading itself is `yaw`). */
  double spin = 0.0;
  /** A vehicle body's boost fuel, [0, 1]: predicted for yours, the server's latest for others. */
  double fuel = 0.0;
  bool IsProjectile() const { return t0 > 0.0; }
  /** The server's latest decoded pose and life, unsmoothed: for game logic, never for drawing (a
   *  projectile's: its launch). */
  double serverX = 0.0;
  double serverY = 0.0;
  double serverZ = 0.0;
  double serverYaw = 0.0;
  double serverEpoch = 0.0;
  /** Another seat drawn on your clock (SeatDrawing::Predicted), and how far it is drawn from its predicted pose
   *  (room units): the correction still being eased in plus any push out of another drawn seat. */
  bool seatPredicted = false;
  double correction = 0.0;

  // ---- a physics body (§17.10): an entity with a descriptor in the room's `bodies` ----
  /** A body entity: x y z and qx..qw are drawn at the server's present (GenexBodies.h); vx vy vz are the
   *  body's latest linear velocity in room units per second (lvx..lvz · lengthUnit); yaw is whatever
   *  the module wrote (never used to draw a body); pitch and the preset fields are 0. */
  bool isBody = false;
  /** The descriptor: `dynamic`, `fixed` or `kinematic`; its physics kind ("" none); its colliders as the
   *  JSON text the core accepted (C§6.2's form). */
  std::string bodyType;
  std::string bodyKind;
  std::string colliders;
  /** The drawn orientation, a unit quaternion (z up); the identity for an entity that is not a body. */
  double qx = 0.0;
  double qy = 0.0;
  double qz = 0.0;
  double qw = 1.0;
  /** The latest state the server sent: linear velocity in metres per second (times the room's
   *  lengthUnit for room units per second), angular velocity in rad/s (world axes), asleep. */
  double lvx = 0.0;
  double lvy = 0.0;
  double lvz = 0.0;
  double avx = 0.0;
  double avy = 0.0;
  double avz = 0.0;
  bool sleep = false;
  /** Out of this client's view (§17.10 *Interest*): its descriptor stays, its entity is not in the
   *  state; drawn from its last state. */
  bool held = false;
  /** The room tick of the latest body state (the patch's tick + 1). */
  double bodyTick = 0.0;
  /** Drawn by the physics predictor at your present (§17.11), not from the server's states. */
  bool predicted = false;
};

/** Physics prediction's state (§17.11, session.ts `physicsPrediction`). */
struct AuthorityPhysicsPrediction {
  /** `on`, `off`, `loading`, `unavailable`, `mismatch`, `self_test`, `diverged` or `cpu`. */
  std::string status = "off";
  /** Keyframes adopted by skip-on-match and by replay. */
  int matched = 0;
  int replayed = 0;
  /** Why keyframes replayed: the first check each failed (AdoptReport::Miss). Probes are not counted. */
  int missNoPrediction = 0;
  int missRows = 0;
  int missBodySet = 0;
  int missAckLate = 0;
  int missJoints = 0;
  int missSeats = 0;
  /** The slowest replay, ms. */
  double peakResimMs = 0.0;
  /** How many times the replay budget turned prediction off (`cpu`), and on again (`cpu` keeps the
   *  client world and probes its way back: §17.11 *Budgets*). */
  int fallbacks = 0;
  int recoveries = 0;
};

/** Whether this client's copy of the room's physics world is the room's (§17.10 *The resolved config*,
 *  session.ts AuthorityPhysicsStatus). */
struct AuthorityPhysicsStatus {
  /** "" or "physics_mismatch" (the room runs physics, `roomPhysics` not "", with another hash than the
   *  one SetPhysics was given). No SDK steps bodies in this release: the report is the whole effect. */
  std::string reason;
  /** The hash given to SetPhysics ("" until then). */
  std::string physics;
  /** The room's `physics` (its world's physicsHash), "" in a room without physics. */
  std::string roomPhysics;
  /** The room's lengthUnit (room units per metre), 0 without physics. */
  double lengthUnit = 0.0;
};

/** Whether your own entity is predicted, and why not when it is not (session.ts AuthorityPredictionStatus). */
struct AuthorityPredictionStatus {
  bool predicting = false;
  /** "" (predicting), "off" (AuthorityOptions::predict false), "no_entity" (you own no entity yet),
   *  "no_preset" (the room runs no preset this client knows, and you gave no prediction) or
   *  "world_mismatch" (the room's firstperson or vehicle world is not this client's: SetWorld the room
   *  module's). */
  std::string reason = "no_entity";
  /** The hash of this client's world (the empty world's, 2615243109, until SetWorld). */
  std::uint32_t world = FirstpersonWorld::kEmptyHash;
  /** The world the room's preset steps through (`params.world`), or nullopt when it has none. */
  std::optional<std::uint32_t> roomWorld;
};

/** A seated player. */
struct AuthorityPlayerView {
  std::string id;
  std::string name;
  std::string uid;
  std::string team;
  bool connected = false;
  std::string avatarUrl;
  bool isMe = false;
};

/** What the session measured. Counters only grow. */
struct AuthorityTelemetry {
  /** Inputs transmitted. */
  int inputsSent = 0;
  /** Input steps that came due while the socket was down, and were not sent (never queued). */
  int inputsDropped = 0;
  /** Server acks the reconciler checked its prediction against. */
  int reconciles = 0;
  /** Reconciles that moved the own entity's place by more than 5 cm (0.05 × the room's units per metre). */
  int visibleCorrections = 0;
  /** Largest correction of the own entity's place seen, and the latest one: the length of the move, in
   *  room units. Velocity and angles are never in it. */
  double peakCorrection = 0.0;
  double lastCorrection = 0.0;
  /** Largest correction of any other mirrored field (velocity, heading, pitch, duck), each in its own
   *  unit, so only zero or not says anything: with peakCorrection, whether the prediction was exact. */
  double peakStateCorrection = 0.0;
  /** Times the prediction was re-seeded from the server (a reconnect, a respawn of your entity). */
  int reseeds = 0;
  /** Stalled reconnect handshakes this session ended (the C core's handshake stall). */
  int reconnectKicks = 0;
  /** Physics body states received (a patch that carried a body's changed fields). */
  int bodyStates = 0;
  /** Of those, the ones drawn by snapping (a new descriptor, an epoch change, an offset over one metre). */
  int bodySnaps = 0;
  /** The largest correction offset a body state left, in room units. */
  double peakBodyCorrection = 0.0;
  /** Projectiles PredictProjectile drew before the server had them. */
  int projectilesPredicted = 0;
  /** Predictions the server's projectile of the same id confirmed. */
  int projectilesConfirmed = 0;
  /** Predictions no server projectile confirmed, and dropped: the server refused the shot, or removed
   *  it before any state patch carried it (a point-blank hit). Found once the server acknowledges the
   *  firing input, else after max(2·RTT, 600 ms). */
  int projectilesRejected = 0;
  /** The latest confirmation's input lead, ms: the server's launch instant minus the prediction's. */
  double lastProjectileLeadMs = 0.0;
  /** Keyframes whose other entities were sampled on the tick timeline (§17.11 *Drawing other seats*): 0
   *  in a room that does not predict physics, or with RemoteSamples::Patch. */
  int tickKeyframes = 0;
};

enum class AuthorityStatus {
  /** Selecting a server, matchmaking, or waiting for a capacity retry. */
  Joining,
  /** Seated; the first state arrived (views wait for IsReady()). */
  Connected,
  /** The socket dropped; the C core is reconnecting in place (§8). */
  Reconnecting,
  /** Over: left, refused or disconnected. */
  Closed,
};

GENEX_CORE_API const char* AuthorityStatusName(AuthorityStatus status);

enum class AuthorityEventType {
  /** The room is ready: the first state landed and the room clock has its first round trip (at most
   *  2 s). `message` = your session id. */
  Ready,
  /** The join was refused: `code` is the JoinError (402 not entitled, 424 no module, 426 protocol,
   *  429 quota, 503 after the capacity ladder, 0 local), `message` says why. Terminal. */
  JoinFailed,
  /** The socket dropped; reconnecting in place. `attempt` (1-based), `code` the drop's close code. */
  Reconnecting,
  /** Back in the same seat; the prediction was rebuilt from the server. */
  Reconnected,
  /** Terminal after a seat: `code` (4500 halted, 4501 module fault, 4001 shutdown, 4003, …). Not
   *  raised after Leave(). */
  Disconnected,
  /** The server is draining (`server:restart`): the room ends soon. Also delivered as a Message. */
  ServerRestart,
  /** The server closes this room in `ms` for a deploy (§17.13), -1 when an older server does not say. Play on:
   *  the seat moves by itself at the close. */
  Draining,
  /** The room is gone and the seat is on its way back: attempt `attempt` (from 1) starts in `ms`; `code` is the
   *  close that lost it. Say so; there is nothing to do. */
  Rejoining,
  /** Back in play: a new seat (SessionId()) in a new room (`name`, the new invite code). `moved` is set when no
   *  room was lost: the player was alone and now sits in a room that has players (§17.1 *Regrouping*). */
  Rejoined,
  /** An event the room module emitted (`ctx.emit(type, data)`), or `server:restart`: `name`, `data`. */
  Message,
  /** Something a developer should see (a room error after the join, a missing workaround). */
  Warning,
};

GENEX_CORE_API const char* AuthorityEventTypeName(AuthorityEventType type);

struct AuthorityEvent {
  AuthorityEventType type = AuthorityEventType::Warning;
  int code = 0;
  int attempt = 0;
  /** Draining: until the close. Rejoining: until the attempt. */
  double ms = 0.0;
  /** Message: the event type. */
  std::string name;
  /** Message: its payload (msgpack decoded; ext 0 = absent). */
  Json data;
  std::string message;
  /** Rejoined: the seat moved out of a room it was alone in (§17.1 *Regrouping*), no room was lost. */
  bool moved = false;
};

/** A remote entity drawn both ways (AuthorityOptions::probeCoreLerp): the measurement seam behind
 *  SPIKE.md "The C core's lerp". Positions in world units, times in server-clock ms. */
struct AuthorityRemoteProbe {
  /** This session's timeline sample at renderTime (what is drawn, before the output spring). */
  double timelineX = 0.0;
  double timelineY = 0.0;
  /** colyseus_predict_value of the core's LERP slots (spring off). */
  double coreX = 0.0;
  double coreY = 0.0;
  /** serverNow - renderDelay - smoothedRtt/2. */
  double renderTime = 0.0;
  /** The newest noted patch time. */
  double newestPatch = 0.0;
  /** The server's latest velocity (vx, vy) for this entity. */
  double vx = 0.0;
  double vy = 0.0;
  /** The entity's current life has at least two noted patches and no respawn is pending. */
  bool steady = false;
};

/**
 * One server-authoritative room. Construct it (the join starts at once), stage `input`, call Frame()
 * once per render frame, read Me() / Entities(), and drain events after each pump frame.
 */
class GENEX_CORE_API AuthoritySession final : public IPumped {
 public:
  explicit AuthoritySession(AuthorityOptions options);
  ~AuthoritySession() override;
  AuthoritySession(const AuthoritySession&) = delete;
  AuthoritySession& operator=(const AuthoritySession&) = delete;

  /** The input sent on each fixed step. Mutate it any time; Frame() sends it (sanitized). */
  Input input;

  /** Pump::Frame calls it: handles the core's callbacks and the timers. Never sends input. */
  void Update(double nowMs) override;
  /** Pump::Frame calls it before the C core's poll (the fast channel's held fields, GenexFastSeat.h). */
  void BeforePoll() override;

  /** Once per render frame, before reading positions: sends one input per due fixed step and advances
   *  prediction and interpolation. Returns the inputs sent. `nowMs` is Clock::NowMs(). */
  int Frame(double nowMs);
  int Frame();

  /** Leave on purpose: never reconnects, raises no Disconnected. */
  void Leave();

  /** Everything that happened since the last drain, in order. */
  std::vector<AuthorityEvent> DrainEvents();

  AuthorityStatus Status() const;
  /** This seat's session id ("" before the join): the `owner` of your entity. */
  const std::string& SessionId() const;
  const std::string& RoomId() const;
  /** The URL joined (after selection; "" before). */
  const std::string& Url() const;
  /** The region the seat is in (§17.1 *Regrouping*): the name of the region whose urls hold Url(), by `regions`
   *  (else each of `urls` is its own region); "" before a server is picked, or when no region lists it. */
  std::string Region() const;
  /** The room's invite code (§17.2 *Choosing a room*): friends pass it as AuthorityOptions::joinCode. */
  const std::string& Code() const;
  /** The room's match key, empty for none. After a join by code, read it once the first state has landed
   *  and hand the room's world to SetWorld; until then the own entity is unpredicted. */
  std::string MatchKey() const;
  /** True once the first state landed and the room clock has its first round trip (at most 2 s):
   *  Me() and Entities() stay empty until then, while inputs already flow. Players() is listed from
   *  the first state. */
  bool IsReady() const;
  /** Seated and the socket up (false from a drop until the reconnect's first state). */
  bool IsConnected() const;
  bool IsClosed() const;
  /** The fixed-step tick the server last wrote. */
  double Tick() const;
  /** The room's movement preset as JSON text ("" = none). */
  const std::string& Preset() const;
  /** Smoothed round trip in ms; 0 until the first input is acknowledged. */
  double Rtt() const;
  AuthorityTelemetry Telemetry() const;
  /** The fast channel (§17.12): whether it is live, snapshots applied, and why it fell back. */
  const fast::FastSeatStatus& Fast() const;
  /** Inputs in flight (SteppedAck + 1 … sent) your own path could not step just now: 0 while every one is
   *  stepped from the server's state of your entity (§17.11 *The client world*); a test reads it. */
  int OwnPathMissing() const;
  /** Inputs in flight the latest re-seed of your prediction could not replay onto the server's pose (0: all of
   *  them, or none has run); a test reads it. */
  int ReseedMissing() const;
  /** The newest transport line (§17.12 *The transport line*): names the transport and why; empty until the
   *  socket's transport is known. */
  const std::string& TransportLine() const;

  /** Your own entity (the first one you own that is not a projectile), as drawn; null until it exists
   *  and IsReady(). Valid until the next Frame(). */
  const AuthorityEntityView* Me() const;
  /** Every entity as drawn, as of the last Frame() (empty before IsReady()), your predicted projectiles
   *  included. */
  const std::map<std::string, AuthorityEntityView>& Entities() const;
  /** The tick other seats were last drawn at (SeatDrawing::Predicted): the state after that tick, fractional
   *  between two, on your own entity's clock; NaN when they are drawn on the render timeline. */
  double DrawTick() const;
  /** How far ahead of the server's present (ms, on this client's room clock) other seats were last drawn:
   *  DrawTick as an instant; NaN when it is. */
  double DrawLead() const;

  /**
   * Predict a projectile you fire (§17.9): call it while staging the input that fires it, before the
   * Frame() that sends it. It is drawn at once from this launch (Entity(id) and Entities() list it
   * now), under the id the room gives it, `<seat>.<seq>.<n>` (the sequence of the input being staged,
   * counted on from your seat's seqBase after a reconnect, and your launches during it), and keeps
   * that id when the server's projectile arrives, drawn on from where the prediction was. One the state
   * never shows (a cooldown, a dead shooter, or a hit before any patch carried it) is dropped as soon as
   * the server acknowledges the input that fired it, at the latest after max(2·RTT, 600 ms). Launch
   * values are taken as the server writes them (float32, a non-finite one 0, g in [0, 1000]). Returns
   * the id, or "" before the first state (there is no input sequence to key it on yet), while
   * reconnecting (no input staged then is sent) or after the end. A prediction fired on the socket a
   * drop cut that the reconnect's first state does not confirm is dropped then, counted rejected.
   */
  std::string PredictProjectile(const ProjectilePrediction& projectile);
  /** The id PredictProjectile would give a projectile staged now, without predicting one ("" when it
   *  would refuse). */
  std::string NextProjectileId() const;
  /** Draw every projectile again at this instant (their flight is closed-form: no Frame needed), and
   *  return the clock they were drawn by; nullopt before the first timed state patch or the room's tick
   *  rate (projectiles are then drawn on the local clock). Invalidates pointers to projectile views. */
  std::optional<AuthorityServerClock> DrawProjectiles();
  /** The clock projectiles are drawn by, now (nullopt as DrawProjectiles). */
  std::optional<AuthorityServerClock> ServerClock() const;
  const AuthorityEntityView* Entity(const std::string& id) const;
  /** Every seated player, as of the last Frame() (or Update, before the first Frame). */
  const std::map<std::string, AuthorityPlayerView>& Players() const;

  /**
   * The `firstperson` or `vehicle` collision world: the same `{ boxes, ramps }` the room module exports, validated
   * and hashed by §17.7's rules (FirstpersonWorld::FromJson / FromSolids). Your own entity is predicted
   * while that hash equals the room's `params.world`, and drawn from the server's state, unpredicted,
   * while it does not. Valid any time, before the join too; a different hash re-seeds the prediction
   * (the inputs still in flight are replayed on the server's pose). nullptr is the empty world.
   * Returns the world's hash.
   */
  std::uint32_t SetWorld(FirstpersonWorldPtr world);
  /** SetWorld from a world as JSON (`{boxes, ramps}`): false, with `error`, when §17.7 refuses it (and
   *  nothing changes); else true with its hash in `hash`. */
  bool SetWorld(const Json& world, std::string* error = nullptr, std::uint32_t* hash = nullptr);
  /** The world this client predicts through (the empty world until SetWorld). */
  const FirstpersonWorldPtr& World() const;
  /** Whether your own entity is predicted now, and why not. */
  AuthorityPredictionStatus PredictionStatus() const;

  /** Hands the SDK the physicsHash of the physics world your client runs a copy of (§17.10). When the
   *  room runs physics with another hash, PhysicsStatus() reports `physics_mismatch`. Returns it. */
  std::string SetPhysics(std::string hash);
  /** Whether your physics copy matches the room's (and the room's hash and lengthUnit). */
  AuthorityPhysicsStatus PhysicsStatus() const;
  /** Draw every physics body again at this instant (bodies are drawn from their latest state on the room
   *  clock: no Frame needed). Returns false before the room clock is timed. Invalidates no pointers. */
  bool DrawBodies();
  /** Physics prediction's status and counts (§17.11). */
  AuthorityPhysicsPrediction PhysicsPrediction() const;

  /** TEST ONLY: kill the socket (close 4010, Godot's test_drop), as a network cut would; the core reconnects. */
  void TestDrop();
  /** TEST ONLY (probeCoreLerp): both drawings of a remote entity this frame. */
  std::optional<AuthorityRemoteProbe> ProbeRemote(const std::string& id) const;

 private:
  /** One Update's worth of a rejoin (§17.13): the attempt in the air, or the next one when its wait is over. */
  void DriveRejoin(double nowMs);
  void AdoptRejoin();
  /** One Update's worth of §17.1 *Regrouping*: the next look when its wait is over, the ask in the air, and the rooms
   *  the seat moved out of. */
  void DriveRegroup(double nowMs);
  void StartRegroupAsk();
  void DriveRegroupAsk(double nowMs);
  /** The ask in the air is given back (company arrived, the room was lost or left): its seat, if any, is left. */
  void GiveBackRegroupAsk(double nowMs);
  void AdoptRegroup(double nowMs);
  void SettleLeftRooms(double nowMs);

  std::unique_ptr<authority_session_detail::Impl> impl_;
  /** A rejoin on its way: what was lost, where it stands, and the attempt in the air. */
  std::unique_ptr<authority_session_detail::RejoinRun> rejoin_;
  /** Regrouping, for a pool join that may: the probe it asks by, the schedule, the ask in the air. */
  std::unique_ptr<authority_session_detail::RegroupRun> regroup_;
};

/**
 * What a region picker shows (§17.1 *Regrouping*; measureAuthorityRegions): the regions probed as a join probes them
 * (3 samples each, 4 s ceiling, 1 s grace after the first answer), with no join. Pumped like a session; `done` is
 * called once, from an Update, with every region's latency in list order (nullopt: no answer). One region is not
 * probed: its latency is nullopt.
 */
class GENEX_CORE_API AuthorityRegionMeter final : public IPumped {
 public:
  /** `regions` as AuthorityOptions::regions; empty, each of `urls` is a region of its own. */
  AuthorityRegionMeter(const std::vector<regions::Region>& regions, const std::vector<std::string>& urls,
                       std::function<void(const std::vector<regions::RegionPing>&)> done);
  ~AuthorityRegionMeter() override;
  AuthorityRegionMeter(const AuthorityRegionMeter&) = delete;
  AuthorityRegionMeter& operator=(const AuthorityRegionMeter&) = delete;
  void Update(double nowMs) override;
  /** `done` was called. */
  bool Done() const { return notified_; }

 private:
  std::unique_ptr<authority_session_detail::Impl> impl_;
  std::function<void(const std::vector<regions::RegionPing>&)> done_;
  std::optional<std::vector<regions::RegionPing>> pings_;
  bool notified_ = false;
};

// ---- pure pieces, exposed for the offline tables (authority_edge `offline`) ----

/** A drawn pose on the render timeline. */
struct AuthorityPose {
  double t = 0.0;
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
  double yaw = 0.0;
  /** A firstperson body's aim pitch (a bounded angle: interpolated straight) and duck amount. */
  double pitch = 0.0;
  double duck = 0.0;
};

/** One step of the output spring, from the pose drawn `dtMs` ago toward `target`: the target itself
 *  on first sight (`has` false), across a respawn (a new `epoch`) or with `tauMs` <= 0; the last pose
 *  again in the same instant (`dtMs` <= 0); otherwise eased by 1 - e^(-dt/τ), the heading along the
 *  shorter arc, the pitch (a bounded angle) straight. (Unity SpringStep; Godot _smoothed.) */
GENEX_CORE_API AuthorityPose AuthoritySpringStep(const AuthorityPose& target, double epoch, bool has,
                                                 const AuthorityPose& last, double lastEpoch, double dtMs,
                                                 double tauMs);

/** Linear interpolation of noted patches (oldest first) at `time`, clamped to the ends; yaw along the
 *  shorter arc. `history` must not be empty. Pitch (a bounded angle) and duck linearly.
 *  (Godot _sample, Unity Sample.) */
GENEX_CORE_API AuthorityPose AuthoritySample(const std::vector<AuthorityPose>& history, double time);

/** A drawn angle back in [-π, π). */
GENEX_CORE_API double AuthorityWrapAngle(double v);

/** A drawn pitch: wrapped to [-π, π), then held to [-limit, limit] (session.ts drawnPitch). */
GENEX_CORE_API double AuthorityDrawnPitch(double pitch, double limit);

/** Whether a mirrored field is a heading, whose corrections and eases take the short arc across ±π
 *  (session.ts ANGLES): only `yaw`. A firstperson pitch is a bounded angle (±pitchLimit, at most
 *  float32(π/2)): a plain number, eased and corrected straight. */
GENEX_CORE_API bool AuthorityIsHeading(const std::string& field);

/** How far a reconcile moved your own `field` from `before` to `after`: the short arc for a heading,
 *  the plain difference otherwise (session.ts noteCorrection). */
GENEX_CORE_API double AuthorityCorrection(const std::string& field, double before, double after);

/** How far a reconcile moved each kind of mirrored field (session.ts correctionSizes, PROTOCOL.md §17.3
 *  *Correction telemetry*): `place` the length of the move of x y z, room units; `state` the largest
 *  AuthorityCorrection of any other counted field (never mstate, cap, spin or fuel). */
struct AuthorityCorrectionSizes {
  double place = 0.0;
  double state = 0.0;
};
GENEX_CORE_API AuthorityCorrectionSizes AuthorityCorrectionsOf(const std::vector<std::string>& fields,
                                                               const std::vector<double>& before,
                                                               const std::vector<double>& after);
/** Whether a move of `place` room units is a visible correction in a room of `unitsPerMetre`. */
GENEX_CORE_API bool AuthorityVisibleCorrection(double place, double unitsPerMetre);

/** The id the server gives a projectile seat `sid` launches while handling its input `seq` (the input
 *  handle's count on this socket, from 1), counted on from the seat's `seqBase`: `<sid>.<seqBase+seq>.<n>`,
 *  `n` the launches during that input from 0 (§17.9). Numbers print as JavaScript prints them. */
GENEX_CORE_API std::string AuthorityProjectileId(const std::string& sid, double seqBase, int seq, int n);

/** A predicted projectile no server entity confirmed within max(2·RTT, this) is dropped, when no acknowledgement
 *  of its firing input settled it first (§17.9). */
inline constexpr double kProjectileTtlMinMs = 600.0;

/**
 * §17.9's TTL for a predicted projectile nothing else settles (session.ts `ttl`): max(2·RTT, 600 ms), not counting a
 * stall. While the socket is up, the time no state arrives is not a lost input (a reliable socket loses none), so the
 * TTL waits out the current silence, and for max(2·RTT, 600 ms) after a stall ends it also waits out that stall's
 * length (a shot fired into a one-second burst of loss would otherwise vanish, then snap back when the server's
 * lands). Times are one monotonic clock's ms (the session uses the room clock's `now`).
 */
class GENEX_CORE_API ProjectileTtl {
 public:
  explicit ProjectileTtl(double now = 0.0) : lastStateAt_(now) {}
  /** A state patch was decoded at `now`: a gap longer than the stall remembered (or after it is forgotten) is the
   *  new stall. */
  void NoteState(double now);
  /** The TTL, ms, at `now` in a room of `rtt` ms; `connected` false (the socket down): max(2·RTT, 600 ms). */
  double Ms(double rtt, bool connected, double now) const;

 private:
  double lastStateAt_;
  double stallMs_ = 0.0;
  double stallEndedAt_ = 0.0;
};

/** A measured input lead (ms) in ticks of a room at `tickHz`: `(leadMs · tickHz) / 1000`. */
GENEX_CORE_API double AuthorityLeadTicks(double leadMs, double tickHz);

/** A replay budget override as a connect option or the conformance driver's `physicsBudgetMs` gives it:
 *  the number when it is a finite number over 0, else none (a string, NaN, a negative, 0, ±Infinity, an
 *  object, null, a bool or nothing are ignored, never an error). */
GENEX_CORE_API std::optional<double> AuthorityBudgetOverride(const Json* value);

/** The replay budget in use: `overrideMs` when finite and over 0, else the device's `deviceMs`. */
GENEX_CORE_API double AuthorityEffectiveBudgetMs(const std::optional<double>& overrideMs, double deviceMs);

}  // namespace genex
