// The client session of a server-authoritative room (PROTOCOL.md §17, protocol 4) over the official
// Colyseus C# SDK: a port of packages/multiplayer/src/authority/session.ts (`connectAuthority`).
//
// The server simulates; this client sends typed input and renders. Per render frame the game (or
// GenexPump) calls Frame(): the SDK's Predict says how many fixed input steps are due and the session
// sends one AuthorityInput per step (the staged Input, sanitized as the server will), the reconciler
// predicts the entity this seat owns with the room's movement preset (Presets.cs, the same step the
// server runs, so prediction matches by construction) and rewinds-and-replays when the server's truth
// arrives, and every other entity is drawn RenderDelayMs in the past on the render time the server's
// lag compensation rewinds to (serverNow - renderDelay - rtt/2: the SDK's lerp target), with a respawn
// (an epoch bump) snapped on that same timeline. A projectile (an entity with a launch tick, §17.9) is
// never interpolated: it is drawn from its closed-form flight (Projectile.cs) at the server's present,
// and the shooter's own from the moment it fires (PredictProjectile), on the SDK's PredictedSpawns. A
// `firstperson` or `vehicle` room (§17.7) is predicted only while the collision world the game handed SetWorld is the
// room's: its hash must equal the preset's `params.world`; otherwise the own entity is drawn from the server's state,
// unpredicted, and Prediction says why. A predicted heading that wraps across ±π (a car's) is drawn as an angle: the
// SDK reconciler eases it as a plain number, so the session draws your own yaw from the reconciler's state along the
// short arc (OwnYaw) and folds a seam-crossing correction to the short arc (FoldYawCorrection).
// In a physics room (§17.10) every join declares `physics@1`, and a body entity (one with a descriptor in the room's
// `bodies`) is never interpolated or predicted: it is drawn at the server's present from its latest state, extrapolated
// on the room clock with corrections eased in (PhysicsDraw.cs), and held at its last state while out of this client's view.
// In a predicting physics room (§17.11) a client with a physics core (the native one this package ships, or
// GenexAuthorityOptions.PhysicsCore) also declares `physics@2`, steps the bodies near it in a world of its own
// (PhysicsPredict.cs, PhysicsPredictSession.cs) and draws those at its present; PredictPhysics = false turns that off.
// In a predicting room other entities are drawn on the tick timeline (§17.11 *Drawing other seats*, TickDrawing.cs): each
// keyframe's sample is timed by its tick, not by the patch's server stamp (RemoteSamples = Patch keeps the stamp). The room
// module's seat rule (§17.11 *Seat rules*, GenexAuthorityOptions.SeatRule) runs before each of your predicted inputs.
//
// Deliberately NOT shared with the relay session (GenexSession): no §16 heartbeat (on an authority
// room the input channel IS the game's input, so a heartbeat would be simulated as blank input), and
// no host, objects or shared map. Reconnection is §8's: in place, no send queue, and once the
// reconnect's first state lands the prediction is re-seeded from the server, so nothing sent before
// the drop is replayed.
//
// THREADING: as GenexSession: everything runs on the thread that owns the room callbacks (Unity's main
// thread). No thread-pool timers: the post-reconnect deadline is checked in TickTimers(), which Frame()
// also runs. Frame() first decodes the patches that have arrived (DecodeArrived): Unity runs the socket's
// posted work only after the scripts' Update, so a keyframe already here would otherwise be adopted after
// the frame had sent its inputs. Engine-agnostic: no UnityEngine here.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Colyseus;
using Colyseus.Predict;
using Colyseus.Schema;
using Genex.Multiplayer.Authority.Wire;
using P = Genex.Multiplayer.GenexProtocol;
using A = Genex.Multiplayer.GenexProtocol.Authority;

namespace Genex.Multiplayer.Authority
{
    /// <summary>How other seats are drawn against your entity with a seat contact rule (§17.11 *Drawing other seats*;
    /// <see cref="GenexAuthorityOptions.SeatDrawing"/>), in the TypeScript's wire spelling.</summary>
    public static class GenexSeatDrawing
    {
        /// <summary>The default, the Rocket League model: every other seat predicted on your entity's clock, stepped from the
        /// latest state by the room preset under its last input with the room's contact pass on every seat, yours included
        /// (<see cref="GenexSeatWorld"/>), each correction drawn as a decaying offset; then kept out of yours and out of each other.</summary>
        public const string Predicted = "predicted";
        /// <summary>On the render timeline, moved out of your drawn entity and taken round it, never across it, and out of each other.</summary>
        public const string Separate = "separate";
        /// <summary>On the render timeline only.</summary>
        public const string Timeline = "timeline";
    }

    public sealed class GenexAuthorityOptions
    {
        /// <summary>
        /// Authority cluster URLs (the sign-in answer's <c>colyseus.authorityUrls</c>). Without <see cref="Regions"/> each is a
        /// region of its own (PROTOCOL.md §17.1 *Regions*): several are probed for latency; none → <see cref="Url"/>, else the
        /// <c>GENEX_AUTHORITY_URL</c> environment variable (Studio's local server).
        /// </summary>
        public string[] Urls;
        /// <summary>
        /// The cluster's regions (<see cref="GenexNativeIdentity.AuthorityRegions"/>, §17.1 *Regions*): one url per sample of
        /// each region is probed (3 samples, 4 s ceiling, 1 s grace after the first answer), the nearest region is joined,
        /// and a join refused 503 twice there moves to the next-best one at once. Each region is its own matchmaking pool.
        /// Empty: <see cref="Urls"/> are the regions.
        /// </summary>
        public GenexAuthorityRegion[] Regions;
        /// <summary>How a pool join (the plain join of a game's pool: not a join by code, a private create or an explicit
        /// <see cref="Url"/>) picks its region (§17.1 *Finding players*). <see cref="GenexRegionRule.Players"/>, the default: the
        /// regions in reach (<see cref="MaxPingMs"/>) are asked, nearest first, then the ones that did not answer the probe,
        /// for a room that already exists, and a room is
        /// opened in the nearest region only when none has one. <see cref="GenexRegionRule.Nearest"/> joins the nearest region
        /// whoever is elsewhere.</summary>
        public GenexRegionRule RegionRule = GenexRegionRule.Players;
        /// <summary>The farthest region asked for players, as a probe's round trip in ms (default
        /// <see cref="GenexAuthorityRegions.MaxPingMs"/>, 350). A value that is not finite or is below 0 is the default.</summary>
        public double MaxPingMs = GenexAuthorityRegions.MaxPingMs;
        /// <summary>How long one ask for an existing room may take before the next region is asked, ms (§17.1 *Finding
        /// players*, *Regrouping*; default <see cref="GenexAuthorityRegions.AskMs"/>, 3000). A value that is not finite or is
        /// below 0 is the default.</summary>
        public double AskMs = GenexAuthorityRegions.AskMs;
        /// <summary>The one region to play in, by its name in <see cref="Regions"/> (a player's own choice): no other is joined or
        /// created in. Null, or a name the cluster does not have: no choice. A join by code still walks every region.</summary>
        public string Region;
        /// <summary>The player's home region (<see cref="GenexNativeIdentity.AuthorityHome"/>, §17.1 *Regions*): the region nearest
        /// the player by geography, which the server names. It is asked for players and created in first, whatever the probe
        /// measured; <see cref="Region"/> wins over it. Set it yourself to override the server's. Null, empty, or a name the
        /// cluster does not have: no home.</summary>
        public string Home;
        /// <summary>Connect to THIS exact URL, skipping latency selection: an invitee passes the inviter's
        /// <see cref="GenexAuthoritySession.Url"/> and plays in the inviter's region.</summary>
        public string Url;
        /// <summary>TEST SEAM: one latency sample of a url (default: <see cref="GenexAuthorityRegions.HttpProbe(string, int)"/>, an HTTP ping). Never for games.</summary>
        internal GenexAuthorityRegions.Probe Probe { get; set; }
        /// <summary>The game's slug: everyone who passes the same id shares a room. Must equal the token's <c>slug</c>.</summary>
        public string GameId;
        /// <summary>Display-name fallback; the verified token's name wins.</summary>
        public string Name;
        /// <summary>
        /// Identity provider: a FRESH <c>embed:play</c> token, read before every join attempt and never cached
        /// (§3.2). Unset against a LOOPBACK server: the local placeholder credential is sent. Never log it.
        /// </summary>
        public Func<Task<string>> GetEmbedToken;
        /// <summary>Predict your own entity (default true): with <see cref="Prediction"/>, else the room's movement preset.</summary>
        public bool Predict = true;
        /// <summary>Your own prediction step, when the room module moves your entity with its own code. Must be the server's step.</summary>
        public GenexPrediction Prediction;
        /// <summary>
        /// The <c>firstperson</c> or <c>vehicle</c> collision world, as the room module exports it (<see cref="GenexAuthoritySession.SetWorld"/>
        /// later, too): your own entity is predicted only while its hash equals the room's <c>params.world</c>. Default: the
        /// empty world.
        /// </summary>
        public GenexFirstpersonWorld World;
        /// <summary>The pool to join (§17.2 *Choosing a room*): players with one key share rooms, and the room module reads
        /// it at init to choose a world or mode. Null or empty: the game's one pool. Give the world the key picks to
        /// <see cref="World"/> (<see cref="GenexRoomKey.SelectMatchWorld{T}"/>).</summary>
        public string MatchKey;
        /// <summary>Create a private room: <see cref="GenexAuthoritySession.Code"/> is the invite, and no matchmaking
        /// reaches it. <see cref="MatchKey"/> chooses its world.</summary>
        public bool CreatePrivate;
        /// <summary>Join the room with this invite code, walking the regions until one holds it.</summary>
        public string JoinCode;
        /// <summary>How far in the past other entities render, ms (default 100, AuthorityTiming).</summary>
        public double RenderDelayMs = A.Timing.RenderDelayMs;
        /// <summary>
        /// The output spring on other entities, ms (display only; default 25, 0 = off). The SDK's lerp draws at
        /// serverNow - renderDelay - rtt/2, and the smoothed RTT and clock offset still move after the first acks:
        /// measured at 300 ms RTT, one frame stepped 0.35 world units (over the teleport bar) a few frames after
        /// the views appeared. The spring trails what a shot is judged against by speed × this (0.15 units at
        /// 6 units/s); hits measured the same. Never applied across a respawn. Godot's session has the same knob.
        /// </summary>
        public double RemoteSmoothMs = 25;
        /// <summary>Waits before each retry of a join refused for capacity (503). Default 1, 2, 4 s; empty never retries.</summary>
        public double[] CapacityRetryMs = { 1000, 2000, 4000 };
        /// <summary>Whether a seat whose room ended for a deploy, or whose socket no reconnect restored, goes back into
        /// play by itself (§17.13 *Drain and rejoin*). Default true; false makes that close final.</summary>
        public bool Rejoin = true;
        /// <summary>Whether a player who is alone in a pool room keeps asking for a room that already has players and moves there
        /// (§17.1 *Regrouping*): the session stays the game's object, <see cref="GenexAuthoritySession.Rejoined"/> is raised with
        /// <see cref="GenexAuthoritySession.Moved"/> set, and the room the player was alone in is left. Default true; false keeps
        /// the player where they are. It needs <see cref="Rejoin"/>, and never applies to a private room, a join by code, an
        /// explicit <see cref="Url"/>, a pinned <see cref="Region"/> or <see cref="GenexRegionRule.Nearest"/>. "Alone" is read from
        /// the room's state, which a session updates as it is framed or pumped as usual.</summary>
        public bool Regroup = true;
        /// <summary>TEST SEAM: the waits before each ask of a player who is alone, ms (default
        /// <see cref="GenexAuthorityRegions.RegroupWaitsMs"/>: 2, 4, 9, 15, then every 30 s); the last repeats. Never for games.</summary>
        internal double[] RegroupWaitsMs { get; set; }

        /// <summary>
        /// Run the SDK's reconnect attempts when it does not (see GenexAuthoritySession's reconnect watchdog).
        /// Default: on in a WebGL player, where the Colyseus C# SDK's retry waits on Task.Delay, which never
        /// resumes there; off elsewhere, where the SDK's own loop runs.
        /// </summary>
        public bool DriveReconnects =
#if UNITY_WEBGL && !UNITY_EDITOR
            true;
#else
            false;
#endif

        /// <summary>
        /// The physicsHash of a physics world your client runs a copy of (§17.10; <see cref="GenexAuthoritySession.SetPhysics"/>
        /// later, too). In this release no SDK steps bodies, so a mismatch with the room's is only reported
        /// (<see cref="GenexAuthoritySession.Physics"/>). Default "": none.
        /// </summary>
        public string Physics = "";

        /// <summary>
        /// Predict a predicting physics room's bodies (§17.11): step the bodies near you in a world of your own and draw them at
        /// your present. <c>false</c> is the client's kill switch: bodies are drawn §17.10's way. Default true; it needs a
        /// physics core (<see cref="PhysicsCore"/>, or the native one this package ships for desktop, iOS and Android
        /// players and the editor; WebGL has none), and the join then declares <c>physics@2</c>.
        /// </summary>
        public bool PredictPhysics = true;

        /// <summary>
        /// The physics core that predicts (§17.11): called once a room sends keyframes. Null: the native core
        /// (<see cref="GenexPhysicsNativeCore.Load"/>). The room's static world is the one given to <see cref="World"/>.
        /// </summary>
        public Func<IGenexPhysicsCore> PhysicsCore;

        /// <summary>A replay's budget, ms (§17.11 *Budgets*): 4 on desktop, 5 in a mobile player.</summary>
        public double PhysicsResimBudgetMs =
#if (UNITY_ANDROID || UNITY_IOS) && !UNITY_EDITOR
            GenexPhysicsPredictor.ResimBudgetMobileMs;
#else
            GenexPhysicsPredictor.ResimBudgetDesktopMs;
#endif

        /// <summary>
        /// A replay budget, ms, that overrides the device's (<see cref="PhysicsResimBudgetMs"/>) when finite and over 0; anything
        /// else is ignored. For benches and tests that hold every engine to one budget (§17.11 *Budgets*).
        /// </summary>
        public double? PhysicsBudgetMs;

        /// <summary>
        /// The room module's seat contact rule (§17.11 *Seat contacts*: a car-to-car bump, a pure function of two seats'
        /// entities, <c>a</c> the lower id), run in your own entity's prediction after each input against every other seat
        /// moved on by its velocity. It must be the module's very rule. Null: a room that declares <c>config.contacts</c>
        /// (*Contact policy*) runs the resolved policy its state's preset text carries as this rule, the pass and the drawing
        /// guard (<see cref="GenexDeclaredContacts"/>); any other room's contacts between seats arrive as corrections.
        /// </summary>
        public GenexContactRule Contacts;

        /// <summary>
        /// The room module's whole seat contact pass (§17.11 *Seat contacts*: car-ball's pairs, pile passes and world passes),
        /// which <see cref="GenexSeatDrawing.Predicted"/> runs on every seat after each predicted tick; null: <see cref="Contacts"/>
        /// once on every pair. It must be the module's very pass.
        /// </summary>
        public GenexSeatPass ContactPass;

        /// <summary>
        /// How other seats are drawn when the room has a seat contact rule (<see cref="Contacts"/>, §17.11 *Drawing other
        /// seats*): <see cref="GenexSeatDrawing.Predicted"/> (default, the Rocket League model) on your own entity's clock;
        /// <see cref="GenexSeatDrawing.Separate"/> on the render timeline like every other entity, then moved out of your drawn
        /// entity by the rule and taken round it, never across it (draw-only); <see cref="GenexSeatDrawing.Timeline"/> on the
        /// render timeline only. Both <c>predicted</c> and <c>separate</c> keep every seat out of yours and out of each other.
        /// Null (the default): a declared contact policy's <c>drawing</c> (a shooter's <c>separate</c>, a vehicle arena's
        /// <c>predicted</c>), else <c>predicted</c>. Any other value draws as <c>predicted</c>.
        /// </summary>
        public string SeatDrawing;

        /// <summary>
        /// The room module's body rule (§17.11 *Body rules*: velocities it sets on its dynamic bodies from the seats and the
        /// bodies, a pure function), run in the client world before every predicted step. Null: what the module does to its
        /// bodies arrives as a correction. It must be the module's very rule.
        /// </summary>
        public GenexPredictBodyRule BodyRule;

        /// <summary>
        /// The room module's seat rule (§17.11 *Seat rules*: what it does to a seat's own entity at a tick it announced in
        /// advance, such as a kickoff release), run on your own entity before each predicted input, at the tick that input is
        /// applied on (the state's tick + seq − ack), and, in an <c>inputDecay</c> room, on each other seat's body before each of
        /// its steps (the keyframe's tick + j). Your entity's fields it sees are the ones your prediction mirrors (the vehicle
        /// preset's include <c>cap</c>); what it writes to them is predicted, other names it writes are dropped. Null: a release
        /// arrives as a correction, a round trip late. It must be the module's very rule.
        /// </summary>
        public GenexSeatRule SeatRule;

        /// <summary>
        /// The room module's seat rule taking your input's sequence too (§17.11 <i>Seat rules</i>, TypeScript
        /// <c>seatRule(seat, tick, seq)</c>): run on your own entity before each predicted input with that input's tick and
        /// sequence, and on other seats' bodies with none. Wins over <see cref="SeatRule"/> when both are set.
        /// </summary>
        public GenexSeatRuleSeq SeatRuleSeq;

        /// <summary>
        /// The room module's kinematic rule (§17.11 <i>Kinematic rules</i>: where it poses its kinematic bodies, a door, a platform,
        /// a moving floor, at each tick), run before every step of the client world, so it moves them as the room does and draws
        /// them as predicted bodies, also outside the simulated set. Null: they hold each keyframe's pose and are drawn from the
        /// server's states. It must be the module's very rule.
        /// </summary>
        public GenexPredictKinematicRule KinematicRule;

        /// <summary>
        /// How other entities' samples are timed in a predicting room (§17.11 *Drawing other seats*): <see cref="GenexRemoteSamples.Tick"/>
        /// (default) by their keyframe's tick, <see cref="GenexRemoteSamples.Patch"/> by the patch's server stamp (every other
        /// room's way, kept for comparison). Rooms that do not predict physics always draw by the patch stamp.
        /// </summary>
        public GenexRemoteSamples RemoteSamples = GenexRemoteSamples.Tick;

        /// <summary>
        /// The fast channel (PROTOCOL.md §17.12, <c>fast@1</c>, with <c>tick@1</c>), on by default: where the room offers it, your
        /// inputs and your motion state move off the WebSocket onto raw UDP datagrams, back to the WebSocket when no snapshot comes,
        /// and on to the datagrams again when they do (<see cref="GenexAuthoritySession.Fast"/>, and one log line per join names the
        /// transport and any fallback). False keeps the seat on the WebSocket. A WebGL player has no sockets: its seat stays a
        /// WebSocket seat unless <see cref="FastWebTransport"/> asks for WebTransport.
        /// </summary>
        public bool Fast = true;

        /// <summary>
        /// A WebGL player has no sockets, so <see cref="Fast"/> alone leaves it on the WebSocket; true asks for WebTransport through
        /// the room's relay where the browser has it (PROTOCOL.md §17.12 *WebTransport*, never yet run in a player). Off by default.
        /// </summary>
        public bool FastWebTransport;

        /// <summary>The replay budget in use: <see cref="PhysicsBudgetMs"/> when finite and over 0, else the device's.</summary>
        internal double EffectiveBudgetMs()
        {
            var o = PhysicsBudgetMs;
            return o.HasValue && !double.IsNaN(o.Value) && !double.IsInfinity(o.Value) && o.Value > 0 ? o.Value : PhysicsResimBudgetMs;
        }

        // Test seams: the smoke test's 426 path and its environment. Not for games.
        internal int? ProtocolOverride { get; set; }
        /// <summary>The <c>caps</c> sent instead of this package's (the physics smoke's 426 without <c>physics@1</c>).</summary>
        internal string[] CapsOverride { get; set; }
        internal Func<string, string> ReadEnvironment { get; set; }
        /// <summary>The fast channel's socket opener instead of UDP (tests).</summary>
        internal GenexFastSocketOpener FastOpener { get; set; }
        /// <summary>The fast channel's clock (ms) instead of the SDK's (tests).</summary>
        internal Func<double> FastClock { get; set; }

        /// <summary>The opener the session's fast seat uses: null when the channel is not asked for, or this build of the
        /// SDK lacks a member the seat reaches by reflection (GenexFastSeat.Missing).</summary>
        internal GenexFastSocketOpener FastSocketOpener() =>
            Fast && GenexFastSeat.Missing().Length == 0 ? FastOpener ?? PlatformOpener() : null;

        /// <summary>The opener this platform has: raw UDP, or in a browser whose game asked (<see cref="FastWebTransport"/>) and which
        /// has WebTransport the relay's session (none: the seat never claims fast@1, and its transport line says why).</summary>
        private GenexFastSocketOpener PlatformOpener()
        {
            if (!GenexFastSeat.InBrowser) return GenexFastUdp.Open;
            return FastWebTransport && GenexFastWebSocket.Available ? GenexFastWebSocket.Open : (GenexFastSocketOpener)null;
        }

        /// <summary>Where the transport line goes instead of the log (tests).</summary>
        internal Action<string> FastLog { get; set; }
    }

    /// <summary>How other entities' samples are timed in a predicting room (§17.11 *Drawing other seats*).</summary>
    public enum GenexRemoteSamples
    {
        /// <summary>By their keyframe's tick (<c>tickOrigin + tick / tickHz</c>): the default.</summary>
        Tick,
        /// <summary>By the patch's server stamp, as in a room that does not predict physics (for comparison).</summary>
        Patch,
    }

    /// <summary>An entity as this client draws it. Rewritten in place by every <see cref="GenexAuthoritySession.Frame()"/>.</summary>
    public sealed class GenexAuthorityEntity
    {
        public string Id { get; internal set; }
        public string Kind { get; internal set; } = "";
        /// <summary>The owning seat's session id, or "".</summary>
        public string Owner { get; internal set; } = "";
        public bool IsMine { get; internal set; }
        /// <summary>Drawn: predicted for your own entity, interpolated RenderDelayMs behind for every other one.</summary>
        public double X { get; internal set; }
        public double Y { get; internal set; }
        public double Z { get; internal set; }
        /// <summary>Drawn heading, radians in [-π, π).</summary>
        public double Yaw { get; internal set; }
        public double VX { get; internal set; }
        public double VY { get; internal set; }
        public double VZ { get; internal set; }
        public double Hp { get; internal set; }
        public double Flags { get; internal set; }
        /// <summary>The life being drawn: lags the server's by the render delay around a respawn.</summary>
        public double Epoch { get; internal set; }
        /// <summary>The entity's JSON text ("" = none).</summary>
        public string Data { get; internal set; } = "";
        /// <summary>The server's latest decoded pose and life, unsmoothed: for game logic, never for drawing.</summary>
        public double ServerX { get; internal set; }
        public double ServerY { get; internal set; }
        public double ServerZ { get; internal set; }
        public double ServerYaw { get; internal set; }
        public double ServerEpoch { get; internal set; }
        /// <summary>
        /// A projectile's launch tick (§17.9), 0 = not a projectile. A projectile's X..VZ are drawn from its flight;
        /// your own prediction's is the (fractional) tick it was fired at, the server's an integer.
        /// </summary>
        public double T0 { get; internal set; }
        /// <summary>A projectile's downward acceleration along -z, units/s².</summary>
        public double G { get; internal set; }
        /// <summary>The seat that fired a projectile ("" = none).</summary>
        public string Src { get; internal set; } = "";
        /// <summary>Whether this is a projectile (<see cref="T0"/> &gt; 0): drawn from its flight, never interpolated.</summary>
        public bool IsProjectile => T0 > 0;
        /// <summary>Your own projectile as <see cref="GenexAuthoritySession.PredictProjectile"/> drew it, before the server's confirmed it.</summary>
        public bool IsPredicted { get; internal set; }
        /// <summary>Another seat drawn predicted on your clock (<see cref="GenexSeatDrawing.Predicted"/>): how far it is drawn from
        /// its predicted pose (room units), the correction still being eased in plus any push out of another drawn seat.</summary>
        public double SeatCorrection { get; internal set; }
        /// <summary>
        /// A <c>firstperson</c> body's aim pitch, radians (+ looks up): predicted for yours, interpolated for others,
        /// within the room's ±pitchLimit. 0 in a room that writes none.
        /// </summary>
        public double Pitch { get; internal set; }
        /// <summary>A <c>firstperson</c> body's duck amount, 0 standing to 1 fully ducked: predicted or interpolated.</summary>
        public double Duck { get; internal set; }
        /// <summary>
        /// A <c>firstperson</c> body's movement bits (<see cref="GenexFirstperson.OnGround"/> 1,
        /// <see cref="GenexFirstperson.Ducking"/> 2, <see cref="GenexFirstperson.JumpHeld"/> 4): predicted for yours, the
        /// server's latest for others.
        /// </summary>
        public double Mstate { get; internal set; }
        /// <summary>A <c>firstperson</c> body's speed multiplier, or a <c>vehicle</c>'s top-speed multiplier, as the server last wrote it (default 1).</summary>
        public double Cap { get; internal set; } = 1;
        /// <summary>
        /// A <c>vehicle</c> body's yaw rate, rad/s, positive toward +yaw: predicted for yours, the server's latest for others
        /// (for wheels and skids; the heading itself is <see cref="Yaw"/>). 0 in a room that writes none.
        /// </summary>
        public double Spin { get; internal set; }
        /// <summary>A <c>vehicle</c> body's boost fuel, [0, 1]: predicted for yours, the server's latest for others.</summary>
        public double Fuel { get; internal set; }
        /// <summary>The server's latest pitch, unsmoothed.</summary>
        public double ServerPitch { get; internal set; }

        /// <summary>
        /// A physics body (PROTOCOL.md §17.10): an entity with a descriptor in the room's <c>bodies</c>. Its <c>X Y Z</c> and
        /// <c>Qx..Qw</c> are drawn at the server's present, extrapolated on the room clock, with corrections eased in (never
        /// <c>RenderDelayMs</c> behind, never predicted, never <see cref="GenexAuthoritySession.Me"/>). False for every other entity.
        /// </summary>
        public bool IsBody { get; internal set; }
        /// <summary>The drawn orientation, a unit quaternion (z up): a body's; the identity for any other entity.</summary>
        public double Qx { get; internal set; }
        public double Qy { get; internal set; }
        public double Qz { get; internal set; }
        public double Qw { get; internal set; } = 1;
        /// <summary>A body's latest linear velocity, metres per second (times the room's <c>LengthUnit</c> for units/s); 0 otherwise.</summary>
        public double Lvx { get; internal set; }
        public double Lvy { get; internal set; }
        public double Lvz { get; internal set; }
        /// <summary>A body's latest angular velocity, rad/s, world axes; 0 otherwise.</summary>
        public double Avx { get; internal set; }
        public double Avy { get; internal set; }
        public double Avz { get; internal set; }
        /// <summary>The core has put the body to sleep: it is drawn still, at its state.</summary>
        public bool Sleep { get; internal set; }
        /// <summary>
        /// False while a body is out of this client's view (§17.10 *Interest*: its entity is gone and its descriptor is not):
        /// it is held at its last state until it comes back. True for every entity in view.
        /// </summary>
        public bool InView { get; internal set; } = true;
        /// <summary>A body's descriptor: <c>dynamic</c>, <c>fixed</c> or <c>kinematic</c>; "" otherwise.</summary>
        public string BodyType { get; internal set; } = "";
        /// <summary>A body's physics kind ("" for none; independent of <see cref="Kind"/>).</summary>
        public string BodyKind { get; internal set; } = "";
        /// <summary>A body's colliders as the core accepted them, JSON text (§17.10 <c>AuthorityBody.colliders</c>); "" otherwise.</summary>
        public string Colliders { get; internal set; } = "";
        /// <summary>How far, in room units, a body is still drawn off its state's extrapolation (the decaying correction).</summary>
        public double BodyOffset { get; internal set; }
    }

    /// <summary>Whether this client's physics copy is the room's (<see cref="GenexAuthoritySession.Physics"/>).</summary>
    public sealed class GenexPhysicsStatus
    {
        /// <summary>"" or <c>"physics_mismatch"</c>: the room runs physics and its hash is not the one given to SetPhysics.</summary>
        public string Reason { get; internal set; } = "";
        /// <summary>The hash given to SetPhysics ("" until then).</summary>
        public string Physics { get; internal set; } = "";
        /// <summary>The room's <c>physics</c> (its world's physicsHash, 16 hex digits); "" in a room without physics.</summary>
        public string RoomPhysics { get; internal set; } = "";
    }

    /// <summary>Whether your own entity is predicted, and why not (<see cref="GenexAuthoritySession.Prediction"/>).</summary>
    public sealed class GenexPredictionStatus
    {
        public bool Predicting { get; internal set; }
        /// <summary>
        /// <c>""</c> while predicting; <c>"off"</c> (<see cref="GenexAuthorityOptions.Predict"/> false), <c>"no_entity"</c>
        /// (you own none yet), <c>"no_preset"</c> (the room runs no preset this package knows, and no
        /// <see cref="GenexAuthorityOptions.Prediction"/>), <c>"world_mismatch"</c> (the room's firstperson or vehicle world is not the
        /// one given to SetWorld): your entity is then drawn from the server's state.
        /// </summary>
        public string Reason { get; internal set; } = "";
        /// <summary>The hash of this client's world (the empty world's until SetWorld).</summary>
        public uint World { get; internal set; }
        /// <summary>The world the room's preset steps through (<c>params.world</c>), or null when it has none.</summary>
        public uint? RoomWorld { get; internal set; }
    }

    /// <summary>
    /// A projectile your game fires, as it predicts it (<see cref="GenexAuthoritySession.PredictProjectile"/>): where it
    /// starts, its velocity and its gravity, in world units: the values the room module launches it with.
    /// </summary>
    public sealed class GenexProjectilePrediction
    {
        public string Kind = "";
        public double X, Y, Z, VX, VY, VZ;
        /// <summary>Downward acceleration along -z, units/s², [0, 1000]. Default 0.</summary>
        public double G;
    }

    /// <summary>A seated player.</summary>
    public sealed class GenexAuthorityPlayer
    {
        public string Id { get; internal set; }
        public string Name { get; internal set; } = "";
        public string Uid { get; internal set; } = "";
        public string Team { get; internal set; } = "";
        public bool Connected { get; internal set; }
        public string AvatarUrl { get; internal set; } = "";
        public bool IsMe { get; internal set; }
    }

    /// <summary>What the session measured. Counters only grow.</summary>
    public sealed class GenexAuthorityTelemetry
    {
        /// <summary>Inputs transmitted.</summary>
        public int InputsSent;
        /// <summary>Input steps that came due while the socket was down, and were not sent (never queued).</summary>
        public int InputsDropped;
        /// <summary>Server acks the reconciler checked its prediction against.</summary>
        public int Reconciles;
        /// <summary>Reconciles that moved the own entity's place by more than 5 cm (0.05 × the room's units per metre).</summary>
        public int VisibleCorrections;
        /// <summary>Largest correction of the own entity's place seen, and the latest one: the length of the move, in room
        /// units. Velocity and angles are never in it.</summary>
        public double PeakCorrection;
        public double LastCorrection;
        /// <summary>Largest correction of any other mirrored field (velocity, heading, pitch, duck), each in its own unit, so
        /// only zero or not says anything: with <see cref="PeakCorrection"/>, whether the prediction was exact.</summary>
        public double PeakStateCorrection;
        /// <summary>Times the prediction was re-seeded from the server (a reconnect, a respawn of your entity).</summary>
        public int Reseeds;
        /// <summary>Reconnect attempts this session ran because the SDK's never did (WebGL, see DriveReconnects).</summary>
        public int ReconnectKicks;
        /// <summary>Projectiles <see cref="GenexAuthoritySession.PredictProjectile"/> drew before the server had them.</summary>
        public int ProjectilesPredicted;
        /// <summary>Predictions the server's projectile of the same id confirmed.</summary>
        public int ProjectilesConfirmed;
        /// <summary>
        /// Predictions no server projectile confirmed, and dropped: the server refused the shot, or removed it before
        /// any state patch carried it (a point-blank hit), or its input was lost in a drop. Found once the server
        /// acknowledges the firing input or the reconnect's first state lacks it, else after max(2·RTT, 600 ms).
        /// </summary>
        public int ProjectilesRejected;
        /// <summary>The latest confirmation's input lead, ms: the server's launch instant minus the prediction's.</summary>
        public double LastProjectileLeadMs;
        /// <summary>Prediction steps run (every replayed input counts), and the time they took, ms.</summary>
        public int PredictionSteps;
        public double PredictionStepMs;
        /// <summary>The most time prediction steps took within one <see cref="GenexAuthoritySession.Frame()"/>, ms.</summary>
        public double PeakFramePredictionMs;
        /// <summary>The longest <see cref="GenexAuthoritySession.Frame()"/>, ms, and of it the longest decode of what had
        /// arrived (the socket's queue drained at the frame's start), with the most states one drain decoded.</summary>
        public double PeakFrameMs;
        public double PeakDrainMs;
        public int PeakDrainStates;
        /// <summary>
        /// Physics body states received (§17.10), and how many of them snapped instead of easing in (a body's first state,
        /// an epoch change, a body spawned again, or an offset over one metre).
        /// </summary>
        public int BodyStates;
        public int BodySnaps;
        /// <summary>The largest correction a body state started, room units (eased away, never drawn as a jump).</summary>
        public double PeakBodyCorrection;
        /// <summary>Keyframes whose other entities were sampled on the tick timeline (§17.11 *Drawing other seats*): 0 in a room
        /// that does not predict physics or with <see cref="GenexAuthorityOptions.RemoteSamples"/> Patch.</summary>
        public int TickKeyframes;

        internal GenexAuthorityTelemetry Copy() => (GenexAuthorityTelemetry)MemberwiseClone();
    }

    /// <summary>Where a join goes: the servers asked for a room that already exists, the servers the join itself tries in order, and
    /// what a session needs to regroup (§17.1 *Regrouping*).</summary>
    internal sealed class GenexJoinTargets
    {
        public readonly string[] Search;
        public readonly string[] Create;
        /// <summary>The regions of the cluster (empty for an explicit url).</summary>
        public readonly IList<GenexAuthorityRegion> Regions;
        /// <summary>The servers a player alone behind a url keeps asking, nearest first.</summary>
        public readonly Func<string, string[]> Regroup;

        public GenexJoinTargets(string[] search, string[] create, IList<GenexAuthorityRegion> regions = null, Func<string, string[]> regroup = null)
        {
            Search = search;
            Create = create;
            Regions = regions ?? new List<GenexAuthorityRegion>();
            Regroup = regroup ?? (_ => Array.Empty<string>());
        }
    }

    /// <summary>Entry point of server-authoritative rooms.</summary>
    public static class GenexAuthority
    {
        /// <summary>
        /// Join (or create) the game's authority room with protocol 4 and wait for its first state. A refused
        /// join throws <see cref="GenexJoinException"/>: 402 (not entitled), 424 (no module) and 426 are final,
        /// 429 MAY be tried later, and 503 is retried per <see cref="GenexAuthorityOptions.CapacityRetryMs"/>
        /// before it is thrown.
        /// </summary>
        public static async Task<GenexAuthoritySession> Connect(GenexAuthorityOptions options)
        {
            if (string.IsNullOrEmpty(options.GameId)) throw new ArgumentException("GenexAuthorityOptions.GameId is required");
            var plan = GenexRoomKey.Plan(options.MatchKey, options.CreatePrivate, options.JoinCode);
            if (plan.Refused != GenexTargetRefusal.None) throw new ArgumentException("this room cannot be asked for: " + plan.Refused);
            var route = await JoinTargets(options, plan.Method);
            var targets = route.Create;
            var found = await JoinWherePlayersAre(options, plan, route);
            if (found != null) return found;
            var delays = options.CapacityRetryMs ?? Array.Empty<double>();
            var state = new GenexCapacityState(0, 0, 0);
            var url = targets[0];
            var client = new Client(url);
            for (;;)
            {
                try
                {
                    var tokenless = options.GetEmbedToken == null && IsLoopbackUrl(url);
                    var joinOptions = await BuildJoinOptions(options, tokenless);
                    if (plan.MatchKey != null) joinOptions[A.JoinOption.MatchKey] = plan.MatchKey;
                    if (plan.PrivateRoom) joinOptions[A.JoinOption.Private] = true;
                    var joining = client;
                    var room = await GenexMultiplayer.MapRefusals(() => plan.Method == GenexJoinMethod.JoinById
                        ? joining.JoinById<AuthorityRoomState>(plan.RoomId, joinOptions)
                        : plan.Method == GenexJoinMethod.Create
                            ? joining.Create<AuthorityRoomState>(A.RoomType, joinOptions)
                            : joining.JoinOrCreate<AuthorityRoomState>(A.RoomType, joinOptions));
                    return await Seated(room, options, plan, url, route);
                }
                catch (GenexJoinException e) when (plan.Method == GenexJoinMethod.JoinById)
                {
                    // §17.2 *Choosing a room*: the room is in exactly one region, so a join by code walks them.
                    var region = GenexRoomKey.NextCodeRegion(e.Code, state.Region, targets.Length);
                    if (!region.HasValue)
                    {
                        Explain(e);
                        throw;
                    }
                    url = targets[region.Value];
                    client = new Client(url);
                    state = new GenexCapacityState(region.Value, 0, 0);
                }
                catch (GenexJoinException e)
                {
                    // §17.1 *Regions*: a second refusal on a region moves to the next-best one at once; otherwise the
                    // schedule's next wait on the same region.
                    var kind = GenexAuthorityRegions.KindOfRefusal(e);
                    if (kind == GenexRefusalKind.NextRegion && state.Region + 1 < targets.Length)
                    {
                        state = new GenexCapacityState(state.Region + 1, 0, state.Step);
                        url = targets[state.Region];
                        client = new Client(url);
                        continue;
                    }
                    var next = kind == GenexRefusalKind.Capacity ? GenexAuthorityRegions.Next(state, targets.Length, delays) : null;
                    if (!next.HasValue)
                    {
                        Explain(e);
                        throw;
                    }
                    if (next.Value.State.Region != state.Region)
                    {
                        url = targets[next.Value.Attempt.Region];
                        client = new Client(url);
                    }
                    else await GenexTime.Delay(next.Value.Attempt.WaitMs);
                    state = next.Value.State;
                }
            }
        }

        /// <summary>The session of a joined <paramref name="room"/> once its first state is in: its url first, then the
        /// other servers of the walk. Only a pool join regroups (§17.1 *Regrouping*): a private room and a room joined by code
        /// are where the player asked to be.</summary>
        private static async Task<GenexAuthoritySession> Seated(Room<AuthorityRoomState> room, GenexAuthorityOptions options, GenexJoinPlan plan, string url, GenexJoinTargets route)
        {
            var input = new GenexInput();
            var seat = new GenexAuthoritySeat(room, options, input) { Url = url };
            await seat.FirstState;
            var walk = new List<string> { url };
            foreach (var target in route.Create) if (target != url) walk.Add(target);
            var pool = plan.Method == GenexJoinMethod.JoinOrCreate;
            return new GenexAuthoritySession(seat, options, input, walk.ToArray(), plan.PrivateRoom || plan.Method == GenexJoinMethod.JoinById,
                route.Regions, pool ? route.Regroup : null);
        }

        /// <summary>Asks each of <paramref name="route"/>'s search servers for a room that already exists (§17.1 *Finding players*), with the
        /// join options the join-or-create would send: the first that has one seats the player; null when none has. A refusal
        /// that is a server's answer about this player or game ends the join (the way a refused join does), as every region
        /// would repeat it; an empty region (Colyseus's 521), a dead path or a full region is the next region.</summary>
        private static async Task<GenexAuthoritySession> JoinWherePlayersAre(GenexAuthorityOptions options, GenexJoinPlan plan, GenexJoinTargets route)
        {
            foreach (var url in route.Search)
            {
                Room<AuthorityRoomState> room = null;
                try
                {
                    var joinOptions = await BuildJoinOptions(options, options.GetEmbedToken == null && IsLoopbackUrl(url));
                    if (plan.MatchKey != null) joinOptions[A.JoinOption.MatchKey] = plan.MatchKey;
                    if (plan.PrivateRoom) joinOptions[A.JoinOption.Private] = true;
                    var client = new Client(url);
                    room = await AskInTime(GenexMultiplayer.MapRefusals(() => client.Join<AuthorityRoomState>(A.RoomType, joinOptions)), options.AskMs);
                }
                catch (GenexJoinException e) when (GenexAuthorityRegions.SearchRefusalKind(e) == GenexSearchRefusal.Next)
                {
                    // No room here, a path that is down or full, or an ask that did not answer in time: the next region is
                    // asked. So is an answer the player could not read: the fleet's "no room" is HTTP 521, which Cloudflare
                    // replaces with a page a browser blocks.
                }
                catch (GenexJoinException e)
                {
                    Explain(e);
                    throw;
                }
                catch (Exception)
                {
                    // A network that failed before any refusal is the next region too (the TypeScript's missing code); the join
                    // walk after the search meets the same failure and throws it.
                }
                // Outside the try: a room that is joined is never left behind for the next region's.
                if (room != null) return await Seated(room, options, plan, url, route);
            }
            return null;
        }

        /// <summary><paramref name="ask"/>'s room, or a refusal that is no server's answer once <paramref name="ms"/> have
        /// passed (§17.1 *Finding players*; not finite or below 0 is <see cref="GenexAuthorityRegions.AskMs"/>): the next region
        /// is asked instead of the join waiting on one that never answers, and a seat that still arrives is given back. The
        /// wait is <see cref="GenexTime"/>'s, so a WebGL player runs it too.</summary>
        internal static async Task<Room<AuthorityRoomState>> AskInTime(Task<Room<AuthorityRoomState>> ask, double ms)
        {
            var limit = double.IsNaN(ms) || double.IsInfinity(ms) || ms < 0 ? GenexAuthorityRegions.AskMs : ms;
            if (await Task.WhenAny(ask, GenexTime.Delay(limit)) == ask) return await ask;
            _ = GiveBackLate(ask);
            throw new GenexJoinException(0, "a region did not answer an ask for a room in time", null, false);
        }

        /// <summary>Leaves the room of an ask that answered after its time was up; its refusal is nobody's to read.</summary>
        private static async Task GiveBackLate(Task<Room<AuthorityRoomState>> ask)
        {
            try
            {
                var room = await ask;
                await room.Leave(true);
            }
            catch (Exception)
            {
                // Refused after all, or already gone: nothing was seated.
            }
        }

        /// <summary>One attempt of a rejoin (§17.13 *Drain and rejoin*), through one url: the seat with its first state, or
        /// the refusal thrown. The session's schedule is the ladder.</summary>
        internal static async Task<GenexAuthoritySeat> JoinSeat(GenexAuthorityOptions options, string url, GenexRejoinWay way, string lostRoom, string matchKey, bool closed, GenexInput input)
        {
            var client = new Client(url);
            var joinOptions = await BuildJoinOptions(options, options.GetEmbedToken == null && IsLoopbackUrl(url));
            if (way != GenexRejoinWay.Room && !string.IsNullOrEmpty(matchKey)) joinOptions[A.JoinOption.MatchKey] = matchKey;
            if (way == GenexRejoinWay.Successor)
            {
                joinOptions[A.JoinOption.SuccessorOf] = lostRoom;
                if (closed) joinOptions[A.JoinOption.SuccessorClosed] = true;
            }
            var room = await GenexMultiplayer.MapRefusals(() => way == GenexRejoinWay.Room
                ? client.JoinById<AuthorityRoomState>(lostRoom, joinOptions)
                : client.JoinOrCreate<AuthorityRoomState>(A.RoomType, joinOptions));
            var seat = new GenexAuthoritySeat(room, options, input) { Url = url };
            await seat.FirstState;
            return seat;
        }

        /// <summary>One attempt of a regroup (§17.1 *Regrouping*), through one url: asks for a room that already exists, with the
        /// pool's options (the match key), and answers the seat once its first state has landed; the refusal is thrown. The
        /// ask is given <see cref="GenexAuthorityOptions.AskMs"/>, as the search's is. A room that is joined but never sends a
        /// state is left.</summary>
        internal static async Task<GenexAuthoritySeat> JoinPoolSeat(GenexAuthorityOptions options, string url, GenexInput input)
        {
            var client = new Client(url);
            var joinOptions = await BuildJoinOptions(options, options.GetEmbedToken == null && IsLoopbackUrl(url));
            if (!string.IsNullOrEmpty(options.MatchKey)) joinOptions[A.JoinOption.MatchKey] = options.MatchKey;
            var room = await AskInTime(GenexMultiplayer.MapRefusals(() => client.Join<AuthorityRoomState>(A.RoomType, joinOptions)), options.AskMs);
            var seat = new GenexAuthoritySeat(room, options, input) { Url = url };
            try
            {
                await seat.FirstState;
            }
            catch (Exception)
            {
                try
                {
                    await seat.Leave();
                }
                catch (Exception)
                {
                    // Already gone; the first state's failure is the one thrown.
                }
                throw;
            }
            return seat;
        }

        /// <summary>Every region with its latency, in list order, for a region picker: the probe a join runs (the regions of
        /// <see cref="GenexAuthorityOptions.Regions"/>, else one per <see cref="GenexAuthorityOptions.Urls"/>), with no join.
        /// A region that does not answer, or the only region of a cluster (which is not probed), has no
        /// <see cref="GenexRegionPing.PingMs"/>. Never throws on a probe. The same timer-free waits as a join, so it works on every
        /// platform, WebGL included.</summary>
        public static Task<List<GenexRegionPing>> MeasureRegions(GenexAuthorityOptions options) =>
            GenexAuthorityRegions.Measure(GenexAuthorityRegions.Normalize(options.Regions, options.Urls), options.Probe);

        /// <summary>Where a join goes (§17.1 *Regions*, *Finding players*, *Regrouping*): <c>Search</c>, the servers asked for a room
        /// that already exists, and <c>Create</c>, the servers the join itself tries in order (the override alone, else one per
        /// region, nearest first, else the environment's local server). Only a pool join searches or regroups; a join by code
        /// walks every region, pinned or not. A private create searches nowhere.</summary>
        internal static async Task<GenexJoinTargets> JoinTargets(GenexAuthorityOptions options, GenexJoinMethod method)
        {
            if (!string.IsNullOrEmpty(options.Url)) return new GenexJoinTargets(Array.Empty<string>(), new[] { options.Url });
            var regions = GenexAuthorityRegions.Normalize(options.Regions, options.Urls);
            if (regions.Count == 0) return new GenexJoinTargets(Array.Empty<string>(), new[] { PickUrl(options) });
            var pool = method == GenexJoinMethod.JoinOrCreate;
            var rule = pool ? options.RegionRule : GenexRegionRule.Nearest;
            var pinned = method == GenexJoinMethod.JoinById ? null : options.Region;
            var best = await GenexAuthorityRegions.ProbeBest(regions, options.Probe);
            var plan = GenexAuthorityRegions.PlanSearch(regions, best, rule, options.MaxPingMs, pinned, options.Home);
            // The probe's answers stay with the session: a player alone behind a server asks the regions listed before it.
            string[] RegroupFrom(string url) =>
                GenexAuthorityRegions.PlanRegroup(regions, best, rule, options.MaxPingMs, pinned, GenexAuthorityRegions.RegionOf(regions, url)).Select(p => p.Url).ToArray();
            return new GenexJoinTargets(plan.Search.Select(p => p.Url).ToArray(), plan.Create.Select(p => p.Url).ToArray(), regions, RegroupFrom);
        }

        /// <summary>Whether <paramref name="url"/> names this machine (ws/wss on 127.0.0.1, localhost or [::1]).</summary>
        public static bool IsLoopbackUrl(string url)
        {
            if (string.IsNullOrEmpty(url)) return false;
            string rest;
            if (url.StartsWith("ws://", StringComparison.Ordinal)) rest = url.Substring(5);
            else if (url.StartsWith("wss://", StringComparison.Ordinal)) rest = url.Substring(6);
            else return false;
            var slash = rest.IndexOf('/');
            var host = slash >= 0 ? rest.Substring(0, slash) : rest;
            if (host.IndexOf('@') >= 0) return false;
            if (host.StartsWith("[::1]", StringComparison.Ordinal)) return host == "[::1]" || host.StartsWith("[::1]:", StringComparison.Ordinal);
            var colon = host.IndexOf(':');
            if (colon >= 0) host = host.Substring(0, colon);
            return host == "127.0.0.1" || host == "localhost";
        }

        /// <summary>An explicit Url wins; with Urls the SDK races them; with neither, $GENEX_AUTHORITY_URL. Null = race Urls.</summary>
        internal static string PickUrl(GenexAuthorityOptions options)
        {
            if (!string.IsNullOrEmpty(options.Url)) return options.Url;
            var urls = options.Urls ?? Array.Empty<string>();
            if (urls.Length == 1) return urls[0];
            if (urls.Length > 1) return null;
            var env = (options.ReadEnvironment ?? Environment.GetEnvironmentVariable)(A.UrlEnvironmentVariable);
            if (string.IsNullOrEmpty(env)) throw new ArgumentException("GenexAuthorityOptions needs Url or Urls (or GENEX_AUTHORITY_URL)");
            return env;
        }

        /// <summary>Fresh join options for EVERY attempt (§3.2: never cache a token). <c>protocol</c> goes last.</summary>
        internal static async Task<Dictionary<string, object>> BuildJoinOptions(GenexAuthorityOptions options, bool tokenless)
        {
            var o = new Dictionary<string, object> { [P.JoinOption.GameId] = options.GameId };
            if (!string.IsNullOrEmpty(options.Name))
                o[P.JoinOption.Name] = options.Name.Length > P.Limits.MaxNameChars ? options.Name.Substring(0, P.Limits.MaxNameChars) : options.Name;
            var token = tokenless ? A.LocalToken : options.GetEmbedToken != null ? await options.GetEmbedToken() : null;
            if (!string.IsNullOrEmpty(token)) o[P.JoinOption.EmbedToken] = token;
            // This package decodes and draws §17.10's bodies: a physics room admits it (and refuses a client without it, 426);
            // with a core it predicts them too (§17.11 *Joining*), and it reconciles a predicting room's repeated inputs
            // (§17.11 *Input pacing*: SteppedAck).
            // §17.12: a client that asks for the fast channel claims fast@1 beside tick@1 (every slot carries the input's tick).
            var caps = PredictsPhysics(options) ? new List<string> { A.Caps.Physics, A.Caps.PhysicsPredict, A.Caps.InputRepeat } : new List<string> { A.Caps.Physics, A.Caps.InputRepeat };
            if (options.FastSocketOpener() != null) caps.AddRange(new[] { A.Caps.InputTick, A.Caps.Fast, A.Caps.FastReturn });
            o[A.JoinOption.Caps] = options.CapsOverride ?? caps.ToArray();
            o[A.JoinOption.Sdk] = A.SdkLabel; // §17.1: counted, so a protocol bump can see whom it would strand
            o[P.JoinOption.Protocol] = options.ProtocolOverride ?? A.ProtocolVersion;
            return o;
        }

        /// <summary>Whether this client predicts a predicting room's bodies (§17.11): asked to, with a core to do it.</summary>
        internal static bool PredictsPhysics(GenexAuthorityOptions options) =>
            options.PredictPhysics && (options.PhysicsCore != null || GenexPhysicsNativeCore.Load(out _) != null);

        /// <summary>The refusals a developer must act on (§17.2).</summary>
        private static void Explain(GenexJoinException e)
        {
            if (e.ProtocolUnsupported)
                ColyseusContext.Logger.LogError($"[genex] the authority server refused protocol {A.ProtocolVersion} (426): this game needs an updated com.genex.multiplayer.");
            else if (e.NotEntitled)
                ColyseusContext.Logger.LogError("[genex] server-authoritative rooms are not available for this game (402): its owner is not entitled to them. Final; not retried.");
        }
    }

    /// <summary>
    /// One server-authoritative room. Stage <see cref="Input"/>, call <see cref="Frame()"/> once per render frame
    /// (GenexPump does), then read <see cref="Me"/> and <see cref="Entities"/>.
    /// </summary>
    public sealed class GenexAuthoritySeat
    {
        /// <summary>A reconcile that moves the own entity more than this (world units) counts as a visible correction.</summary>
        /// <summary>Without a reconciler the session paces inputs itself; a stalled frame catches up at most this many steps.</summary>
        private const int MaxCatchUpSteps = 8;
        /// <summary>The longest the views wait for the room clock's first round trip (see Warm).</summary>
        private const double ClockWarmupTimeoutMs = 2000;
        /// <summary>
        /// A respawn of your own entity is the reconcile that adopts the server's new pose; the SDK eases that jump
        /// out as a correction offset (tau = one patch interval), so for this many intervals after it (the offset has
        /// then decayed to e^-8 of the jump) the own entity is drawn from its predicted state, interpolated here
        /// between its fixed steps (see SnapPose). The fallback tau is the SDK's own default without a patch rate.
        /// </summary>
        private const double RespawnSnapTaus = 8;
        private const double RespawnSnapFallbackTauMs = 50;
        private const double TwoPi = 2 * Math.PI;
        /// <summary>§17.9's TTL for predictions no acknowledgement settled: max(2·RTT, 600 ms), a stalled link's silence not
        /// counted (on GenexTime's clock).</summary>
        private readonly GenexProjectileTtl projectileTtl = new GenexProjectileTtl(GenexTime.Now());
        /// <summary>
        /// The most a keyframe decoded at the start of a frame is taken to have arrived before that frame's instant, ms (half a
        /// 20 fps frame): a loop held longer than that was not framing, and the TypeScript session too reads what queued
        /// during a stall when it ends (see ArrivalLag).
        /// </summary>
        private const double MaxArrivalLagMs = 25;
        private static readonly string[] PositionFields = { "x", "y", "z" };
        private static readonly string[] AngleFields = { "yaw" };
        /// <summary>
        /// firstperson bodies: the aim pitch and the duck amount (others' are interpolated). Pitch is a bounded angle, held
        /// to ±pitchLimit, so it is eased straight, never along a short arc: at the widest limit, float32(π/2), the swing
        /// from +limit to -limit is 2·limit &gt; π and the short arc would sweep through ±π.
        /// </summary>
        private static readonly string[] PitchFields = { "pitch" };
        private static readonly string[] DuckFields = { "duck" };

        private readonly Room<AuthorityRoomState> room;
        private readonly GenexAuthorityOptions options;
        private readonly double renderDelay;
        private readonly InputHandle handle;
        /// <summary>§17.11 *Input pacing*: the input handle your reconciler reads, acknowledged up to <see cref="SteppedAck"/>
        /// (<see cref="GenexShadowInput"/>), and the upstream throttle with the frame instant it last paid at.</summary>
        private readonly GenexShadowInput shadow;
        private readonly GenexFastSeat fast;
        /// <summary>Whether this session claims tick@1 (with the fast channel): every input carries its view's tick.</summary>
        private readonly bool inputTicks;
        /// <summary>Your inputs' map (state tick less SteppedAck) as the last frame ended (NaN before the first).</summary>
        private double sentMap = double.NaN;
        private readonly GenexInputThrottle throttle = new GenexInputThrottle();
        private double throttleAt = double.NaN;
        private readonly Predict predict;
        private readonly TaskCompletionSource<bool> firstState = new TaskCompletionSource<bool>();
        private readonly GenexAuthorityTelemetry telemetry = new GenexAuthorityTelemetry();
        private readonly Dictionary<string, List<Action<object>>> handlers = new Dictionary<string, List<Action<object>>>();
        private readonly Dictionary<string, Remote> remotes = new Dictionary<string, Remote>();
        private readonly Dictionary<string, Spring> springs = new Dictionary<string, Spring>();
        /// <summary>§17.11 *Drawing other seats*: other entities' keyframe samples on the tick timeline, by id (forgotten when
        /// the id's entity is replaced or removed), and the room's K, cached per physDesc text.</summary>
        private readonly GenexTickDrawing<string> ticked = new GenexTickDrawing<string>(StringComparer.Ordinal);
        private string keyframeTicksText;
        private int keyframeTicks = 1;
        private readonly Dictionary<string, GenexAuthorityEntity> views = new Dictionary<string, GenexAuthorityEntity>();
        private readonly Dictionary<string, GenexAuthorityPlayer> playerViews = new Dictionary<string, GenexAuthorityPlayer>();
        private readonly List<string> gone = new List<string>();
        private readonly Dictionary<string, Body> bodies = new Dictionary<string, Body>();
        private readonly List<string> goneBodies = new List<string>();
        private string physicsHash;
        private string warnedPhysics = "";
        private readonly GenexPhysicsPredictSession physicsPrediction;
        /// <summary><see cref="GenexSeatDrawing.Predicted"/>: the seat prediction (null with another drawing or no contact rule),
        /// each other seat's drawn correction, when they were last decayed, and the room preset's step and physDesc, cached.</summary>
        private readonly GenexSeatWorld seatWorld;
        private readonly Dictionary<string, GenexSeatOffset> seatOffsets = new Dictionary<string, GenexSeatOffset>();
        /// <summary>Each other seat's share of your entity's exact input (<see cref="GenexSeatTouch.Share"/>), by its key.</summary>
        private readonly Dictionary<string, double> touchShares = new Dictionary<string, double>();
        private double seatOffsetsAt = double.NaN;
        private GenexSeatClock? seatDrawClock;
        private string seatStepPreset = "\u0000";
        private uint seatStepWorld;
        private GenexRemoteStep seatStep;
        private string seatDescText = "\u0000";
        private GenexPhysDesc seatDesc;
        private string seatUnitPreset = "\u0000";
        private double seatUnitOfPreset = 1;
        // reused by every predicted step: no allocation per replayed input
        private readonly GenexPredictedBody stepBody = new GenexPredictedBody();
        /// <summary>§17.11 *Seat contacts*: the module's rule in your own prediction (null without one), your entity as the
        /// rule sees it, and the other seats it is given (pooled).</summary>
        private readonly GenexSeatContacts contacts;
        private readonly GenexContactBody contactMine = new GenexContactBody("");
        /// <summary>§17.11 *Drawing other seats*, <c>separate</c>: the drawing (null without a contact rule or with the
        /// <c>timeline</c> drawing), your drawn entity and a seat's as it sees them (pooled), and where each other seat was
        /// drawn against yours last frame with the lives it was drawn in (a new life on either side starts afresh).</summary>
        private readonly GenexSeatSeparation separation;
        private readonly GenexContactBody separateYou = new GenexContactBody("");
        private readonly GenexContactBody separateSeat = new GenexContactBody("");
        private readonly Dictionary<string, DrawnSide> sides = new Dictionary<string, DrawnSide>();
        /// <summary>§17.11 *Seat rules*: your entity's mirrored fields as the seat rule sees them (pooled).</summary>
        private readonly Dictionary<string, double> seatFields = new Dictionary<string, double>();
        private readonly List<GenexContactBody> contactOthers = new List<GenexContactBody>();
        private readonly List<GenexContactBody> contactPool = new List<GenexContactBody>();
        /// <summary>The ring re-predicted at a keyframe (OwnPath): its body, reused.</summary>
        private AuthorityEntity pathEntity;
        private readonly GenexInput stepInput = new GenexInput();
        private readonly GenexReconnectWatchdog<AuthorityRoomState> watchdog;
        private readonly PredictedSpawns<AuthorityEntity, Shot> shots;
        /// <summary>Predictions not yet confirmed (see SettleShots).</summary>
        private readonly List<Shot> unsettled = new List<Shot>();
        /// <summary>The input being staged: its handle epoch and sequence, and the launches predicted against it.</summary>
        private int stagedEpoch = -1, stagedSeq, stagedLaunches;
        /// <summary>The firstperson or vehicle collision world, and why the own entity is not predicted (see Prediction).</summary>
        private GenexFirstpersonWorld world;
        private string blocked = "no_entity";
        private string warnedMismatch = "";
        /// <summary>The prediction steps' time in the current Frame (Stopwatch ticks).</summary>
        private long frameStepTicks;
        /// <summary>States decoded by the drain running now (DecodeArrived).</summary>
        private int drainStates;
        private string pitchLimitText;
        private double pitchLimit = Math.PI;

        private Own own;
        private bool entitiesChanged = true;
        private bool connected = true;
        private bool ended;
        /// <summary>This session's room callbacks on the stack (DecodeArrived never dispatches inside one).</summary>
        private int callbackDepth;
        /// <summary>Inside Frame(now): the frame's instant on the SDK clock (see FrameLag).</summary>
        private bool framing;
        private double frameAt = double.NaN;
        /// <summary>The previous Frame's instant on the SDK clock (NaN before the second frame; see ArrivalLag).</summary>
        private double previousFrameAt = double.NaN;
        /// <summary>Inside DecodeArrived: the states decoded arrived since the previous frame (see ArrivalLag).</summary>
        private bool decodingArrived;
        private bool awaitingResync;
        private double resyncDeadline;
        /// <summary>Set at a drop: the next state decoded is the reconnect's first (see DropEarlierSockets).</summary>
        private bool resyncFirstState;
        private int reconnectAttempt;
        private double paceFrom = double.NaN;
        private bool warm;
        private double warmDeadline = double.PositiveInfinity;

        /// <summary>The input sent on each fixed step. Mutate it any time; <see cref="Frame()"/> sends it.</summary>
        public GenexInput Input { get; }

        /// <summary>The socket dropped; the SDK is reconnecting in place (§8). Inputs are not sent meanwhile. (attempt, close code)</summary>
        public event Action<int, int> Reconnecting;
        /// <summary>Back in the same seat; prediction was re-seeded from the server.</summary>
        public event Action Reconnected;
        /// <summary>Terminal: the seat is gone (4500 halted, 4501 module fault, §11). Not raised after <see cref="Leave"/>.</summary>
        public event Action<int> Disconnected;
        /// <summary>The server is draining (<c>server:restart</c>): the room ends soon.</summary>
        public event Action ServerRestart;

        internal GenexAuthoritySeat(Room<AuthorityRoomState> room, GenexAuthorityOptions options, GenexInput input)
        {
            this.room = room;
            this.options = options;
            Input = input;
            renderDelay = options.RenderDelayMs >= 0 && !double.IsNaN(options.RenderDelayMs) ? options.RenderDelayMs : A.Timing.RenderDelayMs;

            var r = room.Reconnection;
            r.Enabled = P.Reconnection.Enabled;
            r.MinUptime = P.Reconnection.MinUptime;
            r.Delay = P.Reconnection.Delay;
            r.MinDelay = P.Reconnection.MinDelay;
            r.MaxDelay = P.Reconnection.MaxDelay;
            r.MaxRetries = P.Reconnection.MaxRetries;
            r.MaxEnqueuedMessages = P.Reconnection.MaxEnqueuedMessages;
            watchdog = new GenexReconnectWatchdog<AuthorityRoomState>(room, GiveUp);

            // The delay goes to the input handle too, not only to Predict: lag compensation rewinds to
            // serverNow - renderDelay - rtt/2, and Predict binds its delay to the handle only once a
            // reconciler exists. Without one the server would rewind to ~100 ms after what was drawn.
            handle = room.Input(new AuthorityInput(), new InputOptions { Mode = "reliable", RenderDelay = renderDelay });
            shadow = new GenexShadowInput(handle, () => room.Clock);
            // §17.12: with the fast channel your inputs also go by datagram (numbered by the handle) and your motion arrives
            // by snapshot, written into this same state; its ack stands in for the handle's.
            var fastOpener = options.FastSocketOpener();
            inputTicks = fastOpener != null && options.CapsOverride == null;
            fast = new GenexFastSeat(room, handle, fastOpener, options.FastClock ?? (() => RoomClock.GetNow()), TickHz, FastStateCurrent, options.Fast, options.FastLog ?? (line => ColyseusContext.Logger.Log(line)));
            predict = Predict.Get(room, new PredictGetOptions { Mode = PredictMode.Lerp, Delay = renderDelay });
            predict.AttachAll("entities", new AttachOptions { Mode = PredictMode.Lerp, Fields = PositionFields });
            predict.AttachAll("entities", new AttachOptions { Mode = PredictMode.Lerp, Fields = AngleFields, Angle = true });
            predict.AttachAll("entities", new AttachOptions { Mode = PredictMode.Lerp, Fields = PitchFields });
            predict.AttachAll("entities", new AttachOptions { Mode = PredictMode.Lerp, Fields = DuckFields });
            world = options.World ?? GenexFirstpersonWorld.Empty;
            physicsHash = options.Physics ?? "";
            // Physics prediction (§17.11): only once the room sends keyframes, with a core.
            physicsPrediction = new GenexPhysicsPredictSession(
                GenexAuthority.PredictsPhysics(options),
                options.PhysicsCore ?? (() => GenexPhysicsNativeCore.Load(out _)),
                () => room.State,
                () => world,
                TickHz,
                () => handle.SentCount,
                () => SteppedAck(),
                () => own?.Id,
                options.EffectiveBudgetMs(),
                RemoteStep,
                OwnPath,
                options.BodyRule,
                GenexSeatRules.ForOthers(options.SeatRuleSeq, options.SeatRule),
                SeatPoseOf,
                options.KinematicRule,
                // §17.11 *Contact policy*: a declared policy's pass runs in the replay on ticks no seat prediction posed.
                DeclaredPass,
                // §17.12: on the fast channel a body is in a keyframe only while the newest snapshot carries it.
                id => fast.MotionKnown(id));
            // §17.11 *Seat contacts*: the room's rule (the module's, or a declared policy's) against every other seat, used
            // while the room has seat contacts (HasContacts).
            contacts = new GenexSeatContacts(ContactRuleNow, OtherSeats);
            // `predicted` (the default): every other seat predicted on your clock (seat-predict.ts), while the room has seat
            // contacts; your contacts and the physics replay's seats come from it whatever the drawing.
            if (options.SeatDrawing != GenexSeatDrawing.Separate && options.SeatDrawing != GenexSeatDrawing.Timeline)
            {
                // The module's pass, else (no module rule either) the declared policy's (session.ts contactPassOf).
                var pass = options.ContactPass ?? (options.Contacts == null ? DeclaredPass : (GenexSeatPass)null);
                seatWorld = new GenexSeatWorld(new GenexSeatWorldOptions
                {
                    Rule = ContactRuleNow, Pass = pass, Others = HeldSeats, Step = SeatStep, SeatRule = GenexSeatRules.ForOthers(options.SeatRuleSeq, options.SeatRule),
                    Remote = SeatRemote, MaxAheadMs = () => (SeatDescNow()?.LeadMs ?? GenexPhysicsKeyframe.DefaultLeadMs) + GenexSeatWorld.StallPredictMs,
                });
            }
            if (options.SeatDrawing != GenexSeatDrawing.Timeline) separation = new GenexSeatSeparation(DrawingRuleNow);

            // Projectiles (§17.9): correlation is by id. The server's projectile `<seat>.<seq>.<n>` confirms the
            // prediction made under that id and no other; only your own are offered a prediction to confirm.
            shots = predict.Spawns("entities", new PredictedSpawnsOptions<AuthorityEntity, Shot>
            {
                Owned = server => server.t0 > 0 && server.src == room.SessionId,
                Correlate = Confirms,
                SpawnTime = LaunchInstant,
                // §17.9: a stall (the socket up, nothing arriving) is not a lost input: the TTL waits it out, so a shot fired
                // into a burst of loss is not dropped and then snapped back in when the server's lands.
                Ttl = rtt => projectileTtl.Ms(rtt, connected, GenexTime.Now()),
                OnReject = (local, id) =>
                {
                    if (unsettled.Remove(local)) telemetry.ProjectilesRejected++;
                },
            });

            var callbacks = Callbacks.Get(room);
            callbacks.OnAdd("entities", new KeyValueEventHandler<string, AuthorityEntity>((id, entity) => entitiesChanged = true));
            callbacks.OnRemove("entities", new KeyValueEventHandler<string, AuthorityEntity>((id, entity) => entitiesChanged = true));

            room.OnStateChange += OnStateChange;
            room.OnDrop += OnDrop;
            room.OnReconnect += OnReconnect;
            room.OnLeave += OnLeave;
            room.OnMessage<object>(P.ServerMessage.ServerRestart, m =>
            {
                ServerRestart?.Invoke();
                Dispatch(P.ServerMessage.ServerRestart, m);
            });
            if (room.WaitForFirstState().IsCompleted) OnStateChange(room.State, true);
        }

        /// <summary>Completes when the first full state has been decoded.</summary>
        internal Task FirstState => firstState.Task;

        /// <summary>This seat's session id: the <c>Owner</c> of your entity.</summary>
        public string Id => room.SessionId;
        public string RoomId => room.RoomId;
        /// <summary>The room's invite code (§17.2 *Choosing a room*): friends pass it as
        /// <see cref="GenexAuthorityOptions.JoinCode"/>.</summary>
        public string Code => room.RoomId;
        /// <summary>The room's match key, empty for none. After a join by code, hand the room's world to SetWorld by it;
        /// until then the own entity is unpredicted.</summary>
        public string MatchKey => room.State?.matchKey ?? "";
        /// <summary>The server this session joined through (its region's, §17.1 *Regions*). An invite carries it: an invitee
        /// passes it as <see cref="GenexAuthorityOptions.Url"/> and plays in this session's region.</summary>
        public string Url { get; internal set; }
        /// <summary>The underlying Colyseus room, for anything this layer does not wrap.</summary>
        public Room<AuthorityRoomState> Room => room;
        /// <summary>False from a drop until the reconnect's first state lands, and after the session ends.</summary>
        public bool IsConnected => connected && !ended;
        public bool IsClosed => ended;
        /// <summary>The fixed-step tick the server last wrote.</summary>
        public double Tick => room.State != null ? room.State.tick : 0;
        /// <summary>The room's movement preset as JSON text ("" = none).</summary>
        public string Preset => room.State?.preset ?? "";
        /// <summary>Smoothed round trip in ms; 0 until the first input is acknowledged.</summary>
        public double Rtt => room.Clock.SmoothedRtt();

        /// <summary>The fast channel (§17.12, <see cref="GenexAuthorityOptions.Fast"/>): live, snapshots applied, the fallback's reason.</summary>
        public GenexFastStatus Fast => fast.Status;
        /// <summary>A copy of the counters.</summary>
        public GenexAuthorityTelemetry Telemetry
        {
            get
            {
                telemetry.ReconnectKicks = watchdog.Kicks;
                return telemetry.Copy();
            }
        }

        /// <summary>
        /// True once the first state landed and the room clock has its first round trip (at most 2 s): <see cref="Me"/>
        /// and <see cref="Entities"/> stay empty until then, while inputs already flow. <see cref="Players"/> is
        /// listed from the first state (no position to draw).
        /// </summary>
        public bool IsReady => !ended && Warm();

        /// <summary>Your own entity (the first one you own that is not a projectile), predicted; null until it exists and <see cref="IsReady"/>.</summary>
        public GenexAuthorityEntity Me => own != null && views.TryGetValue(own.Id, out var v) ? v : null;
        /// <summary>Every entity as drawn, as of the last <see cref="Frame()"/>. Views are rewritten in place.</summary>
        public IReadOnlyDictionary<string, GenexAuthorityEntity> Entities => views;
        /// <summary>Every seated player, as of the last <see cref="Frame()"/>.</summary>
        public IReadOnlyDictionary<string, GenexAuthorityPlayer> Players => playerViews;

        public GenexAuthorityEntity Entity(string id) => id != null && views.TryGetValue(id, out var v) ? v : null;

        /// <summary>
        /// The room's tick now, fractional, on this client's estimate of the room clock (§17.9 <c>serverTick</c>):
        /// the instant projectiles are drawn at. NaN before the first state patch.
        /// </summary>
        public double ServerTick => room.Clock.LastServerTime() > 0 ? NowTick() : double.NaN;

        /// <summary>
        /// The tick every projectile in <see cref="Entities"/> is drawn at: the last <see cref="Frame()"/>'s (or
        /// <see cref="RedrawProjectiles"/>'s) <see cref="ServerTick"/>. NaN until one drew after the first state patch.
        /// </summary>
        public double DrawnTick { get; private set; } = double.NaN;

        /// <summary>The tick other seats were last drawn at (<see cref="GenexSeatDrawing.Predicted"/>): the state after that tick,
        /// fractional between two, on your own entity's clock; NaN when they are drawn on the render timeline.</summary>
        public double SeatDrawTick { get; private set; } = double.NaN;
        /// <summary>How far ahead of the server's present (ms, on this client's room clock) other seats were last drawn:
        /// <see cref="SeatDrawTick"/> as an instant; NaN when it is.</summary>
        public double SeatDrawLead { get; private set; } = double.NaN;

        /// <summary>
        /// The <c>firstperson</c> or <c>vehicle</c> collision world (§17.7): the same boxes and ramps the room module exports, validated when
        /// you built it (<see cref="GenexFirstpersonWorld.Create"/> / <see cref="GenexFirstpersonWorld.FromJson"/>). Your own
        /// entity is predicted while its hash equals the room's <c>params.world</c>, and drawn from the server's state
        /// without prediction otherwise (<see cref="Prediction"/> says which). Call it before your first
        /// <see cref="Frame()"/>, or pass <see cref="GenexAuthorityOptions.World"/>; a later call with another world
        /// re-seeds the prediction from the server, with the inputs in flight replayed on top. Returns the world's hash.
        /// </summary>
        public uint SetWorld(GenexFirstpersonWorld next)
        {
            if (next == null) throw new ArgumentNullException(nameof(next));
            var changed = next.Hash != world.Hash;
            world = next;
            // Same hash: the same world, value for value; nothing to re-seed.
            if (changed && own != null && !ended) Repredict(own);
            return world.Hash;
        }

        /// <summary>The collision world SetWorld was last given (the empty world until then).</summary>
        public GenexFirstpersonWorld World => world;

        /// <summary>Whether your own entity is predicted now, and why not.</summary>
        public GenexPredictionStatus Prediction
        {
            get
            {
                if (!ended) TrackOwn();
                var predicting = own?.Reconciler != null;
                return new GenexPredictionStatus
                {
                    Predicting = predicting,
                    Reason = predicting ? "" : own != null ? blocked : !options.Predict ? "off" : "no_entity",
                    World = world.Hash,
                    RoomWorld = GenexPresets.RoomWorld(room.State?.preset),
                };
            }
        }

        /// <summary>
        /// Predict a projectile you fire (§17.9): call it while staging the input that fires, before the
        /// <see cref="Frame()"/> that sends it. It is drawn at once from this launch, under the id the room gives it
        /// (<c>&lt;seat&gt;.&lt;seq&gt;.&lt;n&gt;</c>: the input's sequence and your launches during it), and
        /// <see cref="Entities"/> keeps that id when the server's projectile arrives, drawn on from where the
        /// prediction was. One the state never shows (a cooldown, a dead shooter, or a hit before any patch carried it)
        /// is dropped as soon as the server acknowledges the input that fired it, one whose input a drop lost at the
        /// reconnect's first state, and any at the latest after max(2·RTT, 600 ms). Returns the id, or <c>""</c>
        /// (and predicts nothing) while the socket is down: from a drop until the reconnect's first state.
        /// </summary>
        public string PredictProjectile(GenexProjectilePrediction projectile)
        {
            if (projectile == null) throw new ArgumentNullException(nameof(projectile));
            if (ended) throw new InvalidOperationException("the session has ended");
            // No prediction while the socket is down (§17.9): no input goes out until the reconnect, and the seat's
            // sequence is not known until the reconnect's first state writes its seqBase.
            if (!connected) return "";
            // The input being staged goes out as the next send: its sequence is one past what was sent, counted on
            // from the seqBase the server gave this socket.
            var seq = handle.SentCount + 1;
            if (stagedEpoch != handle.Epoch || stagedSeq != seq)
            {
                stagedEpoch = handle.Epoch;
                stagedSeq = seq;
                stagedLaunches = 0;
            }
            var players = room.State?.players;
            var seqBase = players != null && players.TryGetValue(room.SessionId, out var me) && me != null ? me.seqBase : 0;
            var id = room.SessionId + "." + ((long)(seqBase + seq)).ToString(CultureInfo.InvariantCulture) + "." + stagedLaunches++.ToString(CultureInfo.InvariantCulture);
            var at = room.Clock.ServerNow();
            var g = GenexProjectile.LaunchNumber(projectile.G);
            var shot = new Shot
            {
                Id = id,
                Kind = projectile.Kind ?? "",
                At = at,
                Seq = seq,
                Epoch = handle.Epoch,
                Launch = new GenexProjectileLaunch
                {
                    X = GenexProjectile.LaunchNumber(projectile.X),
                    Y = GenexProjectile.LaunchNumber(projectile.Y),
                    Z = GenexProjectile.LaunchNumber(projectile.Z),
                    VX = GenexProjectile.LaunchNumber(projectile.VX),
                    VY = GenexProjectile.LaunchNumber(projectile.VY),
                    VZ = GenexProjectile.LaunchNumber(projectile.VZ),
                    G = g < 0 ? 0 : g > GenexProjectile.MaxG ? GenexProjectile.MaxG : g,
                    T0 = GenexProjectile.ServerTick(at, TickOrigin(), TickHz()),
                },
            };
            shot.Entry = shots.Spawn(shot);
            unsettled.Add(shot);
            telemetry.ProjectilesPredicted++;
            // Drawn at once, in this frame, at the tick the frame's other projectiles are drawn at (before its launch
            // tick, so at its origin until the next frame): the views otherwise change only in Frame().
            if (warm && !(EntityMap()?.ContainsKey(id) ?? false)) ShotView(shot, double.IsNaN(DrawnTick) ? NowTick() : DrawnTick);
            return id;
        }

        /// <summary>
        /// Redraw every projectile at this instant and return the tick it was drawn at (<see cref="ServerTick"/>). A
        /// projectile moves between frames, and <see cref="Frame()"/> draws it at the frame's instant: call this to
        /// read one at another (a hit test, a tool sampling the views). A projectile the state no longer holds (and no
        /// pending prediction) leaves <see cref="Entities"/>; nothing else changes.
        /// </summary>
        public double RedrawProjectiles()
        {
            var tick = NowTick();
            var map = warm ? EntityMap() : null;
            if (map == null) return ServerTick;
            var pending = PendingShots();
            gone.Clear();
            foreach (var kv in views)
                if (kv.Value.IsProjectile && !map.ContainsKey(kv.Key) && !pending.ContainsKey(kv.Key)) gone.Add(kv.Key);
            foreach (var id in gone) views.Remove(id);
            foreach (var kv in map) if (kv.Value != null && kv.Value.t0 > 0) ProjectileView(kv.Key, kv.Value, tick);
            foreach (var shot in pending.Values) if (!map.ContainsKey(shot.Id)) ShotView(shot, tick);
            DrawnTick = room.Clock.LastServerTime() > 0 ? tick : double.NaN;
            return DrawnTick;
        }

        /// <summary>
        /// Redraw every physics body (§17.10) at this instant: a body is drawn from its latest state on the room clock,
        /// and <see cref="Frame()"/> draws it at the frame's instant. Call this to read one at another (a tool sampling the
        /// views, the conformance driver's snapshot). Only bodies already in <see cref="Entities"/> are redrawn; nothing
        /// else changes. Returns false before the room clock's first sample (no body is drawn then).
        /// </summary>
        public bool RedrawBodies()
        {
            var map = warm ? EntityMap() : null;
            if (map == null || room.Clock.LastServerTime() <= 0) return false;
            foreach (var kv in bodies)
            {
                if (!views.ContainsKey(kv.Key) || !kv.Value.Drawer.HasState) continue;
                if (map.TryGetValue(kv.Key, out var e))
                {
                    // In view: drawn as Frame() draws it, once the entity is the one the drawer holds.
                    if (e == kv.Value.Entity) BodyView(kv.Key, kv.Value, true);
                }
                else if (HeldBody(kv.Key)) BodyView(kv.Key, kv.Value, false);
            }
            return true;
        }

        /// <summary>
        /// Receive the events the room module emits with <c>ctx.emit(type, data)</c> (and <c>server:restart</c>).
        /// Data uses the package's value model (GenexJson). Returns an unsubscribe action.
        /// </summary>
        public Action On(string type, Action<object> handler)
        {
            if (string.IsNullOrEmpty(type)) throw new ArgumentException("an event type is required", nameof(type));
            if (A.SessionEvent.IsOne(type))
                throw new ArgumentException($"'{type}' is a session event: subscribe to the C# event instead", nameof(type));
            if (!handlers.TryGetValue(type, out var list))
            {
                list = new List<Action<object>>();
                handlers[type] = list;
                if (type != P.ServerMessage.ServerRestart) room.OnMessage<object>(type, m => Dispatch(type, m));
            }
            list.Add(handler);
            return () => list.Remove(handler);
        }

        private void Dispatch(string type, object raw)
        {
            if (!handlers.TryGetValue(type, out var list) || list.Count == 0) return;
            var data = GenexJson.Normalize(raw);
            callbackDepth++;
            try
            {
                foreach (var h in list.ToArray()) h(data);
            }
            finally
            {
                callbackDepth--;
            }
        }

        // ---------------- frame ----------------

        /// <summary>
        /// Call once per render frame, before reading positions (GenexPump does, before your scripts' Update).
        /// Decodes the patches that have arrived since the last frame, sends one input per due fixed step and advances
        /// prediction and interpolation. Returns the inputs sent.
        /// </summary>
        public int Frame() => Frame(RoomClock.GetNow());

        /// <summary>As <see cref="Frame()"/> at the SDK clock's time <paramref name="now"/> (ms): everything it draws, it draws at that instant.</summary>
        public int Frame(double now)
        {
            TickTimers();
            if (ended) return 0;
            previousFrameAt = frameAt;
            frameAt = now;
            framing = true;
            var started = Stopwatch.GetTimestamp();
            try
            {
                return FrameAt(now);
            }
            finally
            {
                framing = false;
                var ms = (Stopwatch.GetTimestamp() - started) * 1000.0 / Stopwatch.Frequency;
                if (ms > telemetry.PeakFrameMs) telemetry.PeakFrameMs = ms;
            }
        }

        private int FrameAt(double now)
        {
            DecodeArrived();
            if (ended) return 0;
            PollFast();
            if (ended) return 0;
            // The newest keyframe of what arrived, adopted once before this frame's inputs go (§17.11 *A burst of keyframes*).
            physicsPrediction.Settle();
            frameStepTicks = 0;
            TrackOwn();
            var reconciler = own?.Reconciler;
            var seqBefore = reconciler?.ReconcileSeq ?? 0;
            if (reconciler != null) PredictedPose(own, own.Before);
            var headingBefore = reconciler != null ? YawBefore(own) : default;
            // The reconciler reads the shadow's ack inside the tick: it follows the state first.
            shadow.Mirror(StateAck());
            var extra = ThrottleExtra(now);
            var budget = predict.Tick(now) + extra;
            int sent;
            if (reconciler == null)
            {
                sent = SendSteps(OwnPace(now) + extra);
                sentMap = InputMap();
            }
            else
            {
                paceFrom = double.NaN;
                NoteCorrection(own, seqBefore);
                FoldYawCorrection(own, seqBefore, headingBefore);
                sent = SendSteps(budget);
                sentMap = InputMap();
                // §17.11 *Seat contacts* (session.ts): a state that put your inputs in flight on later ticks had the seat
                // prediction find a contact in an input your entity was already stepped through without it (a re-run keeps
                // none of its changes to yours): your inputs are predicted again from the state, not held still until the
                // server's bump comes back a round trip later.
                if (seatWorld != null && seatWorld.TakeMissed().Count > 0 && own != null && !ended) ShoveRepredict(own);
            }
            physicsPrediction.AfterSend(OwnPosition(), ServerNowDrawn());
            var frameMs = frameStepTicks * 1000.0 / Stopwatch.Frequency;
            if (frameMs > telemetry.PeakFramePredictionMs) telemetry.PeakFramePredictionMs = frameMs;
            RefreshViews();
            return sent;
        }

        /// <summary>
        /// How far the SDK clock has moved past the frame's instant (0 outside Frame). Frame(now) draws at `now`: the patches it
        /// decodes first, with a keyframe's replay, take a millisecond or two in some frames and none in others, and drawing at
        /// the clock after them moved a car a frame's worth of that work (remote cars' frame-to-frame jitter p99 3.6-4.0 to
        /// 10.2-10.9 cm in car-ball lead150 jitter-30), and an output spring stepped by the clock eased them unevenly.
        /// </summary>
        private double FrameLag() => framing ? RoomClock.GetNow() - frameAt : 0;

        /// <summary>The room clock at the instant being drawn: the frame's inside Frame(now), else now.</summary>
        private double ServerNowDrawn() => room.Clock.ServerNow() - FrameLag();

        /// <summary>
        /// How long before the frame's instant a state DecodeArrived decodes is taken to have arrived, ms (0 for any other
        /// decode): half the time since the previous frame, at most MaxArrivalLagMs. The TypeScript session adopts a keyframe
        /// when its message lands, between two frames, so the frame after it draws the predicted bodies moved on by the time
        /// since (§17.11 *Drawing*: the time since the world last stepped, the correction's age). Adopted at the frame's own
        /// instant, a keyframe that lands with the world held at the lead cap was drawn exactly where the world before it
        /// would have been, a frame without progress at every keyframe (car-ball lead150 rtt-200: the ball's frame-to-frame
        /// jitter excess p99 36-56 cm, 15-25 before the decode moved into Frame, TypeScript 22-37).
        /// </summary>
        private double ArrivalLag()
        {
            if (!decodingArrived || double.IsNaN(previousFrameAt)) return 0;
            return Math.Min(Math.Max((frameAt - previousFrameAt) / 2, 0), MaxArrivalLagMs);
        }

        /// <summary>The room clock when the state being decoded arrived (see ArrivalLag).</summary>
        private double ServerNowArrived() => ServerNowDrawn() - ArrivalLag();

        /// <summary>
        /// Decodes, here and now, the patches that have arrived since the last frame, so a keyframe already here is adopted
        /// before this frame sends its inputs (§17.11 *The client world*), as the TypeScript session's socket events land
        /// between frames. The socket posts them to the thread's SynchronizationContext, and Unity's runs posted work only
        /// after the scripts' Update: a keyframe was adopted after the frame had sent, with `sent − ack` one frame's inputs
        /// larger (two at 120 Hz and 60 fps), so where the lead nears its cap the replay was clipped and the predicted ball
        /// drawn behind the TypeScript's. Only on a live, synced socket under a SynchronizationContext (a host without one
        /// has the SDK's own dispatch thread, left alone) and never inside this session's own room callbacks (the SDK's
        /// dispatch is not re-entrant). The WebGL socket has no such queue to drain.
        /// </summary>
        private void DecodeArrived()
        {
#if !UNITY_WEBGL || UNITY_EDITOR
            if (callbackDepth > 0 || !connected || awaitingResync || SynchronizationContext.Current == null) return;
            var connection = room.Connection;
            if (connection == null) return;
            decodingArrived = true;
            drainStates = 0;
            var started = Stopwatch.GetTimestamp();
            try
            {
                connection.DispatchMessageQueue();
            }
            finally
            {
                decodingArrived = false;
                var ms = (Stopwatch.GetTimestamp() - started) * 1000.0 / Stopwatch.Frequency;
                if (ms > telemetry.PeakDrainMs) telemetry.PeakDrainMs = ms;
                if (drainStates > telemetry.PeakDrainStates) telemetry.PeakDrainStates = drainStates;
            }
#endif
        }

        /// <summary>
        /// Only the time-driven work (the post-reconnect deadline). Never sends input. Frame() runs it; call it
        /// from a wall-clock timer too when frames may stop (GenexPump does on WebGL).
        /// </summary>
        public void TickTimers()
        {
            var now = GenexTime.Now();
            if (awaitingResync && now >= resyncDeadline) FinishResync();
            if (options.DriveReconnects && !ended && !connected && !awaitingResync) watchdog.Tick(now);
        }

        /// <summary>The watchdog's last attempt failed: end as the SDK would, with 4003.</summary>
        private void GiveUp()
        {
            if (ended) return;
            End();
            Disconnected?.Invoke(P.CloseCode.FailedToReconnect);
        }

        private int SendSteps(int due)
        {
            if (due <= 0) return 0;
            if (!IsConnected)
            {
                telemetry.InputsDropped += due;
                return 0;
            }
            var data = (AuthorityInput)handle.Data;
            var sent = 0;
            // §17.11 *The input's tick* (tick@1): the tick this frame's view and aim were set for, the server tick its first
            // input is predicted at by the map of your inputs as the last frame ended. Every input of the frame carries it.
            var viewTick = GenexLifts.InputTickField((double.IsNaN(sentMap) ? InputMap() : sentMap) + handle.SentCount + 1);
            for (var i = 0; i < due; i++)
            {
                Input.WriteSanitized(data);
                if (inputTicks) data.tick = viewTick;
                var seq = handle.Send();
                if (seq > 0)
                {
                    sent++;
                    fast.Sent(seq, (ushort)data.tick, GenexInput.FromRaw(data.moveX, data.moveY, data.moveZ, data.yaw, data.pitch, data.buttons),
                        FastRenderStamp());
                }
                else telemetry.InputsDropped++;
            }
            fast.Flush();
            telemetry.InputsSent += sent;
            shadow.Mirror(StateAck());
            return sent;
        }

        /// <summary>Your seat's player in the latest state, or null.</summary>
        private AuthorityPlayer MySeat() => room.State?.players != null && room.State.players.TryGetValue(room.SessionId, out var me) ? me : null;

        /// <summary>The input your entity in the state was stepped through (input-repeat.ts steppedThrough): your prediction is
        /// compared with the state there, replays the inputs after it and times them from it. Projectile settling keeps the
        /// true ack.</summary>
        private int SteppedAck() => GenexInputRepeat.SteppedThrough(fast.Ack(), MySeat()?.inRep ?? 0, handle.SentCount, RoomRepeat());

        /// <summary>The input the state holds your entity stepped through (input-repeat.ts stateThrough), not clamped to the
        /// inputs sent: the shadow's hold tells your reconciler §17.11 *The reconciler's ack* from it (waiting past the inputs
        /// sent, a hitch, and holding past the ring).</summary>
        private int StateAck() => GenexInputRepeat.StateThrough(fast.Ack(), MySeat()?.inRep ?? 0, RoomRepeat());

        /// <summary>Your inputs' map as the latest state has it: the tick input <c>seq</c> is applied at, less <c>seq</c>.</summary>
        private double InputMap() => GenexSeatRules.TickOf((long)(room.State?.tick ?? 0), SteppedAck(), 0);

        /// <summary>Input <paramref name="seq"/> for a replay: the handle's, else the fast channel's copy (the handle lets go of the
        /// inputs its WebSocket ack counted, which on a fast seat the server dropped unstepped). Read at once: reused.</summary>
        private AuthorityInput ReplayInput(int seq) => handle.At(seq) as AuthorityInput ?? fast.InputAt(seq);

        /// <summary>Whether the state is this socket's (its seqBase known): false from a drop until the reconnect's first state.</summary>
        private bool FastStateCurrent() => !resyncFirstState && !awaitingResync && MySeat() != null;

        /// <summary>The fast channel's datagrams (its snapshots written into the state, as a decode would) and deadlines.</summary>
        private void PollFast()
        {
            decodingArrived = true;
            try
            {
                fast.Poll();
            }
            finally
            {
                decodingArrived = false;
            }
        }

        private string repeatText = "\u0000";
        private GenexInputRepeatSetting repeatNow = GenexInputRepeatSetting.On;

        /// <summary>The room's input repeat setting as its preset text publishes it (session.ts <c>roomRepeat</c>), cached per
        /// text.</summary>
        private GenexInputRepeatSetting RoomRepeat()
        {
            var text = room?.State?.preset ?? "";
            if (!string.Equals(text, repeatText, StringComparison.Ordinal))
            {
                repeatText = text;
                repeatNow = GenexInputRepeat.SettingOf(text);
            }
            return repeatNow;
        }

        /// <summary>This frame's extra inputs from the upstream throttle (session.ts throttleExtra): the keyframe's
        /// <c>inStarve</c>/<c>inBuf</c> for your seat read, then the frame's share of the owed lead paid.</summary>
        private int ThrottleExtra(double now)
        {
            var stepMs = handle.StepMs ?? 0;
            var me = MySeat();
            if (me != null) GenexInputRepeat.ThrottleState(throttle, me.inStarve, me.inBuf, stepMs, RoomRepeat());
            var dt = double.IsNaN(throttleAt) ? 0 : now - throttleAt;
            throttleAt = now;
            return GenexInputRepeat.ThrottleSteps(throttle, dt, stepMs);
        }

        /// <summary>Input pacing without a reconciler (Predict paces only once one exists).</summary>
        private int OwnPace(double now)
        {
            var stepMs = handle.StepMs;
            if (!stepMs.HasValue || stepMs.Value <= 0) return 0;
            if (double.IsNaN(paceFrom))
            {
                paceFrom = now;
                return 0;
            }
            var due = (int)Math.Floor((now - paceFrom) / stepMs.Value);
            if (due > MaxCatchUpSteps)
            {
                paceFrom = now;
                return MaxCatchUpSteps;
            }
            paceFrom += due * stepMs.Value;
            return due;
        }

        // ---------------- own-entity prediction ----------------

        private sealed class Own
        {
            public string Id;
            public AuthorityEntity Entity;
            /// <summary>The server's life of the entity; <see cref="DrawnEpoch"/> is the one drawn (it changes at the snap).</summary>
            public double Epoch;
            public double DrawnEpoch;
            /// <summary>An epoch bump arrived and the reconcile that adopts the new life has not yet.</summary>
            public bool Respawning;
            /// <summary>Until then (SDK clock, ms) the entity is drawn by SnapPose; SnapPrev/SnapCur are its last two steps.</summary>
            public double SnapUntil = double.NegativeInfinity;
            public double[] SnapPrev;
            public double[] SnapCur;
            public double SnapAt;
            /// <summary>Your drawn place less your re-predicted one when a missed contact re-predicted it, and when (SDK clock, ms): eased
            /// out by <see cref="GenexShoveEase"/> (session.ts <c>shoveFrom</c>).</summary>
            public bool ShoveEasing;
            public double ShoveDx, ShoveDy, ShoveDz, ShoveAt;
            public Reconciler<AuthorityEntity, AuthorityInput> Reconciler;
            public string[] Fields;
            public GenexPredictionStep Step;
            public double[] Before;
            public double[] After;
        }

        private MapSchema<AuthorityEntity> EntityMap() => room.State?.entities;

        /// <summary>
        /// A projectile is never your own entity (§17.9), even one a server wrongly gave an owner, and in a physics room
        /// neither is a body entity (one with a descriptor, §17.10): it is drawn from the server's bodies, never predicted.
        /// </summary>
        private bool Ownable(string id, AuthorityEntity e) => e != null && e.owner == room.SessionId && !(e.t0 > 0) && !IsBodyEntity(id);

        private bool StillOwned(Own tracked)
        {
            var map = EntityMap();
            return map != null && map.TryGetValue(tracked.Id, out var e) && e == tracked.Entity && Ownable(tracked.Id, tracked.Entity);
        }

        /// <summary>Finds (or re-finds, after a respawn or a reconnect) the entity this seat owns and predicts it.</summary>
        private void TrackOwn()
        {
            if (own != null && StillOwned(own))
            {
                if (own.Entity.epoch != own.Epoch)
                {
                    // A deliberate discontinuity (§17.3): snap to the server's new life instead of correcting smoothly.
                    own.Epoch = own.Entity.epoch;
                    if (own.Reconciler != null) RespawnOwn(own);
                }
                return;
            }
            if (own == null && !entitiesChanged) return;
            DisposeOwn();
            entitiesChanged = false;
            blocked = "no_entity";
            var map = EntityMap();
            if (map == null) return;
            foreach (var kv in map)
            {
                if (!Ownable(kv.Key, kv.Value)) continue;
                own = new Own { Id = kv.Key, Entity = kv.Value, Epoch = kv.Value.epoch, DrawnEpoch = kv.Value.epoch };
                PredictOwn(own);
                return;
            }
        }

        /// <summary>
        /// A respawn (an epoch bump on the own entity, §17.3). The server applies every input after the ack that came
        /// with the bump to the NEW life, so those inputs must replay on the new pose, which the reconciler's next
        /// reconcile does (it adopts the server's state and replays what is unacknowledged). Its Reset() would instead
        /// drop them as a prior life's: the prediction then trailed the server by a round trip of movement and every
        /// later ack corrected it by whole ticks. With nothing in flight there is nothing to replay, so Reset() is
        /// exact and snaps at once.
        /// </summary>
        private void RespawnOwn(Own tracked)
        {
            telemetry.Reseeds++;
            if (handle.SentCount - fast.Ack() <= 0)
            {
                tracked.Reconciler.Reset();
                tracked.Respawning = false;
                tracked.DrawnEpoch = tracked.Entity.epoch;
                return;
            }
            // The snap is the next reconcile (see NoteCorrection), which is this same Frame's: the patch that carried
            // the bump also made the reconciler due, and predict.Tick runs right after TrackOwn. So Respawning never
            // outlives a Frame, and a socket drop (between frames) never finds it set for FinishResync to clear.
            tracked.Respawning = true;
        }

        private void DisposeOwn()
        {
            own?.Reconciler?.Dispose();
            own = null;
        }

        /// <summary>The prediction this client can run now: the game's own step, else the room's preset when its world
        /// (if it has one) is this client's; with why not, when there is none.</summary>
        private GenexPrediction PredictionInUse(out string reason)
        {
            if (!options.Predict)
            {
                reason = "off";
                return null;
            }
            if (options.Prediction != null)
            {
                reason = "";
                return options.Prediction;
            }
            var preset = room.State?.preset;
            var prediction = GenexPresets.PredictionFor(preset, world, out reason);
            if (reason == "world_mismatch")
            {
                var pair = GenexPresets.RoomWorld(preset) + "/" + world.Hash;
                if (warnedMismatch != pair)
                {
                    warnedMismatch = pair;
                    ColyseusContext.Logger.LogWarning(
                        $"[genex] the room's {GenexPresets.PresetName(preset)} world (hash {GenexPresets.RoomWorld(preset)}) is not this client's (hash {world.Hash}): " +
                        "your own entity is drawn from the server without prediction. Pass the room module's world to session.SetWorld().");
                }
            }
            return prediction;
        }

        private void PredictOwn(Own tracked)
        {
            var prediction = PredictionInUse(out blocked);
            if (prediction?.Step == null) return;
            var fields = prediction.Fields ?? GenexPrediction.AllFields;
            var step = prediction.Step;
            tracked.Fields = fields;
            tracked.Before = new double[fields.Length];
            tracked.After = new double[fields.Length];
            tracked.Step = step;
            shadow.Mirror(StateAck());
            tracked.Reconciler = predict.Reconciler(tracked.Entity, new ReconcilerOptions<AuthorityEntity, AuthorityInput>
            {
                // §17.11 *Input pacing*: it compares your prediction with the state at what the shadow's hold tells from StateAck.
                Input = shadow.Handle,
                Fields = fields,
                // The input exactly as sent, sanitized as the server sanitizes it before its own step, and the
                // fixed dt the SDK derives from the room's advertised tick rate.
                Step = (ctx, body, command) => RunStep(step, body, command, ctx.Dt, fields, ctx.Tick),
            });
        }

        /// <summary>One prediction step on <paramref name="body"/> (the reconciler's mirror), timed for the telemetry.</summary>
        private void RunStep(GenexPredictionStep step, AuthorityEntity body, AuthorityInput command, double dt, string[] fields, long seq)
        {
            var started = Stopwatch.GetTimestamp();
            StepOwn(step, body, command, dt, fields, seq);
            var spent = Stopwatch.GetTimestamp() - started;
            frameStepTicks += spent;
            telemetry.PredictionSteps++;
            telemetry.PredictionStepMs += spent * 1000.0 / Stopwatch.Frequency;
        }

        /// <summary>
        /// A fresh prediction from the server's pose, with the inputs still in flight replayed on top (or none, when this
        /// client cannot predict now): a new world (SetWorld). The reconciler's next acknowledgement adopts the server's
        /// state and replays the same inputs, landing where this did, so the switch is not counted as a correction. Until
        /// the next fixed step the own entity is drawn from that predicted state (SnapPose), not from the server's pose the
        /// reconciler's render would ease from.
        /// </summary>
        private void Repredict(Own tracked)
        {
            tracked.Reconciler?.Dispose();
            tracked.Reconciler = null;
            tracked.Respawning = false;
            tracked.DrawnEpoch = tracked.Entity.epoch;
            PredictOwn(tracked);
            var reconciler = tracked.Reconciler;
            if (reconciler == null) return;
            var dt = handle.StepSeconds ?? reconciler.StepMs / 1000;
            for (var seq = SteppedAck() + 1; seq <= handle.SentCount; seq++)
            {
                if (ReplayInput(seq) is AuthorityInput command) RunStep(tracked.Step, reconciler.State, command, dt, tracked.Fields, seq);
            }
            var tau = handle.PatchRate is int patchMs && patchMs > 0 ? patchMs : RespawnSnapFallbackTauMs;
            tracked.SnapUntil = RoomClock.GetNow() + RespawnSnapTaus * tau;
            tracked.SnapCur = null;
        }

        /// <summary>Your entity's drawn place now, as RefreshView draws it before the shove's ease (the snapped pose, else the SDK's).</summary>
        private Pose OwnPlace(Own tracked) => (RoomClock.GetNow() < tracked.SnapUntil ? SnapPose(tracked) : null) ?? Interpolated(tracked.Entity);

        /// <summary><paramref name="pose"/> with what is left of the shove's ease; a finished ease is dropped (session.ts <c>timelinePose</c>).</summary>
        private static void ShoveEased(Own tracked, ref Pose pose)
        {
            if (!tracked.ShoveEasing) return;
            var left = GenexShoveEase.Left(tracked.ShoveDx, tracked.ShoveDy, tracked.ShoveDz, RoomClock.GetNow() - tracked.ShoveAt);
            if (left.IsDone)
            {
                tracked.ShoveEasing = false;
                return;
            }
            pose.X += left.Dx;
            pose.Y += left.Dy;
            pose.Z += left.Dz;
        }

        /// <summary>
        /// Your inputs predicted again from the state after a missed contact (<see cref="GenexSeatWorld.TakeMissed"/>), the drawing kept
        /// where it was and eased to the new prediction over SeatTauMs, as the TypeScript SDK does (session.ts <c>shoveRepredict</c>).
        /// </summary>
        private void ShoveRepredict(Own tracked)
        {
            var before = OwnPlace(tracked);
            ShoveEased(tracked, ref before);
            tracked.ShoveEasing = false;
            Repredict(tracked);
            if (tracked.Reconciler == null) return;
            var after = OwnPlace(tracked);
            tracked.ShoveDx = before.X - after.X;
            tracked.ShoveDy = before.Y - after.Y;
            tracked.ShoveDz = before.Z - after.Z;
            tracked.ShoveAt = RoomClock.GetNow();
            tracked.ShoveEasing = true;
        }

        // ---------------- seat rules, seat contacts and the input-sequence ring (§17.11) ----------------

        /// <summary>
        /// One predicted input on <paramref name="body"/> (the reconciler's mirror, or the ring's): the room's seat rule at the
        /// tick the input is applied on, the step, then the seat contacts (§17.11 *Seat rules*, *Seat contacts*). The mirrored
        /// fields the rule changed are what the step reads, and a <c>cap</c> it set stays on the mirror (as on the TypeScript's
        /// predicted state) until the next acknowledgement adopts the server's.
        /// </summary>
        private void StepOwn(GenexPredictionStep step, AuthorityEntity body, AuthorityInput command, double dt, string[] fields, long seq)
        {
            ReadBody(body, stepBody);
            var capSet = ApplySeatRule(seq, stepBody, fields, out var cap);
            GenexInput.SanitizeInto(command, stepInput);
            step(stepBody, stepInput, dt);
            ApplyContacts(seq, stepBody);
            WriteBody(stepBody, body, fields);
            if (capSet) body.cap = cap;
        }

        /// <summary>The room's seat rule on your entity before input <paramref name="seq"/>, at tick <c>state.tick + (seq − ack)</c>
        /// (§17.11 *Seat rules*; <see cref="GenexSeatRules.ApplyTo"/>). True, with the value, when it changed <c>cap</c>.</summary>
        private bool ApplySeatRule(long seq, GenexPredictedBody body, string[] fields, out double cap)
        {
            cap = body.Cap;
            var stateTick = room.State != null ? room.State.tick : 0;
            var tick = GenexSeatRules.TickOf((long)stateTick, SteppedAck(), seq);
            if (options.SeatRuleSeq != null) return GenexSeatRules.ApplyTo(options.SeatRuleSeq, seq, seatFields, body, fields, tick, out cap);
            var rule = options.SeatRule;
            if (rule == null) return false;
            return GenexSeatRules.ApplyTo(rule, seatFields, body, fields, tick, out cap);
        }

        // ---------------- §17.11 *Contact policy*: a declared policy runs as the rule, the pass and the drawing guard ----------------

        private string declaredText = "\u0000";
        private uint declaredWorld;
        private GenexDeclaredContacts declaredNow;

        /// <summary>The policy the state's preset text declares, through this client's world (session.ts <c>declared</c>);
        /// null when the game gave its own rule, or the text declares none.</summary>
        private GenexDeclaredContacts Declared()
        {
            if (options.Contacts != null) return null;
            var text = room?.State?.preset ?? "";
            if (!string.Equals(text, declaredText, StringComparison.Ordinal) || world.Hash != declaredWorld)
            {
                declaredText = text;
                declaredWorld = world.Hash;
                declaredNow = GenexDeclaredContacts.Of(text, world);
            }
            return declaredNow;
        }

        /// <summary>Whether this room has seat contacts: the module's rule, or a declared policy.</summary>
        private bool HasContacts() => options.Contacts != null || Declared() != null;

        /// <summary>The room's contact rule on two seats: the module's, else the declared policy's.</summary>
        private void ContactRuleNow(GenexContactBody a, GenexContactBody b)
        {
            if (options.Contacts != null) options.Contacts(a, b);
            else Declared()?.Rule(a, b);
        }

        /// <summary>The declared policy's pass over every seat (none without one).</summary>
        private void DeclaredPass(IList<GenexContactBody> seats) => Declared()?.Pass(seats);

        /// <summary>The rule the drawing runs against your entity: a declared policy's with yours fixed (a seat by a wall is
        /// moved along it, never into it), else the room's (session.ts <c>drawingRule</c>).</summary>
        private void DrawingRuleNow(GenexContactBody a, GenexContactBody b)
        {
            var d = Declared();
            if (d == null || own == null) ContactRuleNow(a, b);
            else d.DrawRule(own.Id)(a, b);
        }

        /// <summary>How other seats are drawn now: the game's, else the declared policy's (a shooter's on the render timeline,
        /// where §17.5's rewind judges a shot), else <c>predicted</c>.</summary>
        private string SeatDrawingNow()
        {
            var given = options.SeatDrawing ?? Declared()?.Policy.Drawing;
            return given == GenexSeatDrawing.Separate || given == GenexSeatDrawing.Timeline ? given : GenexSeatDrawing.Predicted;
        }

        /// <summary>The seat prediction while the room has seat contacts.</summary>
        private GenexSeatWorld SeatWorldNow() => HasContacts() ? seatWorld : null;

        /// <summary>The seat prediction other seats are drawn from: only when they are drawn on your clock.</summary>
        private GenexSeatWorld SeatWorldDrawn() => SeatDrawingNow() == GenexSeatDrawing.Predicted ? SeatWorldNow() : null;

        /// <summary>Every other seat's own entity in the latest state (the seat contact rule's other side; pooled).</summary>
        private IList<GenexContactBody> OtherSeats()
        {
            contactOthers.Clear();
            var map = EntityMap();
            var players = room.State?.players;
            if (map == null || players == null) return contactOthers;
            // A declared policy's pair rules read each seat's `flags` (session.ts withFlags).
            var declared = Declared() != null;
            foreach (var kv in map)
            {
                var e = kv.Value;
                if (e == null || kv.Key == own?.Id || string.IsNullOrEmpty(e.owner) || e.t0 > 0 || IsBodyEntity(kv.Key)) continue;
                if (!players.TryGetValue(e.owner, out var player) || player == null) continue;
                if (contactOthers.Count == contactPool.Count) contactPool.Add(new GenexContactBody(""));
                var b = contactPool[contactOthers.Count];
                b.Id = kv.Key;
                b.X = e.x;
                b.Y = e.y;
                b.Z = e.z;
                b.Vx = e.vx;
                b.Vy = e.vy;
                b.Vz = e.vz;
                b.Yaw = e.yaw;
                b.Spin = double.IsNaN(e.spin) ? 0 : e.spin;
                b.Flags = declared ? e.flags : 0;
                contactOthers.Add(b);
            }
            return contactOthers;
        }

        /// <summary>After your input <paramref name="seq"/> was stepped into <paramref name="body"/>: the room's seat contact
        /// rule against the other seats (§17.11 *Seat contacts*); the fields it changed are written back.</summary>
        private void ApplyContacts(long seq, GenexPredictedBody body)
        {
            var tracked = own;
            if (!HasContacts() || tracked == null) return;
            var mine = contactMine;
            mine.Id = tracked.Id;
            mine.Flags = Declared() != null ? tracked.Entity.flags : 0;
            mine.X = body.X;
            mine.Y = body.Y;
            mine.Z = body.Z;
            mine.Vx = body.VX;
            mine.Vy = body.VY;
            mine.Vz = body.VZ;
            mine.Yaw = body.Yaw;
            mine.Spin = body.Spin;
            // `predicted`: the other seats stepped under their held inputs and the room's pass on every seat.
            var seats = SeatWorldNow();
            if (seats != null) seats.Apply(seq, SteppedAck(), (long)(room.State?.tick ?? 0), mine, TickHz());
            else contacts.Apply(seq, SteppedAck(), mine, TickHz());
            body.X = mine.X;
            body.Y = mine.Y;
            body.Z = mine.Z;
            body.VX = mine.Vx;
            body.VY = mine.Vy;
            body.VZ = mine.Vz;
            body.Yaw = mine.Yaw;
            body.Spin = mine.Spin;
        }

        /// <summary>
        /// Your own entity after each input in flight (ack + 1 … sent), stepped afresh from the server's state of it, with the
        /// seat contacts (§17.11 *The client world*: the input-sequence ring); null without a prediction. The body is the
        /// reconciler's: the mirrored fields from the server, the rest at their defaults.
        /// </summary>
        private IList<KeyValuePair<long, GenexOwnState>> OwnPath()
        {
            var tracked = own;
            var reconciler = tracked?.Reconciler;
            if (reconciler == null || tracked.Entity == null) return null;
            var body = pathEntity ?? (pathEntity = new AuthorityEntity());
            foreach (var f in tracked.Fields) body[f] = tracked.Entity[f];
            var dt = handle.StepSeconds ?? reconciler.StepMs / 1000;
            var path = new List<KeyValuePair<long, GenexOwnState>>();
            for (var seq = SteppedAck() + 1; seq <= handle.SentCount; seq++)
            {
                if (!(ReplayInput(seq) is AuthorityInput command)) continue;
                // Not counted as prediction steps: the session's telemetry counts the reconciler's.
                StepOwn(tracked.Step, body, command, dt, tracked.Fields, seq);
                path.Add(new KeyValuePair<long, GenexOwnState>(seq, new GenexOwnState(body.x, body.y, body.z, body.vx, body.vy, body.vz)));
            }
            return path;
        }

        private static void ReadBody(AuthorityEntity e, GenexPredictedBody b)
        {
            b.X = e.x;
            b.Y = e.y;
            b.Z = e.z;
            b.VX = e.vx;
            b.VY = e.vy;
            b.VZ = e.vz;
            b.Yaw = e.yaw;
            b.Pitch = e.pitch;
            b.Duck = e.duck;
            b.Mstate = e.mstate;
            b.Cap = e.cap;
            b.Spin = e.spin;
            b.Fuel = e.fuel;
        }

        private static void WriteBody(GenexPredictedBody b, AuthorityEntity e, string[] fields)
        {
            foreach (var f in fields)
            {
                switch (f)
                {
                    case "x": e.x = b.X; break;
                    case "y": e.y = b.Y; break;
                    case "z": e.z = b.Z; break;
                    case "vx": e.vx = b.VX; break;
                    case "vy": e.vy = b.VY; break;
                    case "vz": e.vz = b.VZ; break;
                    case "yaw": e.yaw = b.Yaw; break;
                    case "pitch": e.pitch = b.Pitch; break;
                    case "duck": e.duck = b.Duck; break;
                    case "mstate": e.mstate = b.Mstate; break;
                    case "spin": e.spin = b.Spin; break;
                    case "fuel": e.fuel = b.Fuel; break;
                    // cap is read, never written: a step that set it is ignored, and the mirror keeps the server's.
                }
            }
        }

        // Correction telemetry, measured as the TS session does: Predict reconciles inside predict.Tick, before
        // this frame's sends, so the predicted state's jump across that call is exactly the correction (0 when
        // the prediction matched the server and the reconcile was skipped). A heading moves by the short arc.
        private static void PredictedPose(Own tracked, double[] into)
        {
            var state = tracked.Reconciler.State;
            for (var i = 0; i < tracked.Fields.Length; i++) into[i] = Convert.ToDouble(state[tracked.Fields[i]]);
        }

        private void NoteCorrection(Own tracked, int seqBefore)
        {
            if (tracked.Reconciler.ReconcileSeq == seqBefore) return;
            if (tracked.Respawning)
            {
                // The reconcile that adopted the new life: a snap, not a correction (see RespawnSnapTaus).
                tracked.Respawning = false;
                tracked.DrawnEpoch = tracked.Entity.epoch;
                var tau = handle.PatchRate is int patchMs && patchMs > 0 ? patchMs : RespawnSnapFallbackTauMs;
                tracked.SnapUntil = RoomClock.GetNow() + RespawnSnapTaus * tau;
                tracked.SnapCur = null;
                return;
            }
            PredictedPose(tracked, tracked.After);
            GenexCorrection.Sizes(tracked.Fields, tracked.Before, tracked.After, out var place, out var stateGap);
            telemetry.Reconciles++;
            telemetry.LastCorrection = place;
            telemetry.PeakCorrection = Math.Max(telemetry.PeakCorrection, place);
            telemetry.PeakStateCorrection = Math.Max(telemetry.PeakStateCorrection, stateGap);
            if (GenexCorrection.IsVisible(place, SeatUnitsPerMetre())) telemetry.VisibleCorrections++;
        }

        /// <summary>A drawn angle (Predict keeps angles unwrapped) back in [-π, π).</summary>
        private static double WrapAngle(double v) => v - TwoPi * Math.Floor((v + Math.PI) / TwoPi);

        // ---- your own heading, drawn as an angle ----
        // The SDK reconciler (Colyseus.Predict.Reconciler 0.18) renders a field as prev + (current + error - prev) · alpha,
        // all plain numbers, and decays a correction `error` as one. A predicted heading that wraps across ±π (a car
        // turning through it) is then eased the long way round for one fixed step (about 2π in 16 ms), and a correction
        // measured across the seam (about 2π: the same heading) would decay through every heading. So the session reads
        // the reconciler's own `prev`, `error` and render alpha (protected members, by reflection, resolved once) and
        // draws your yaw along the short arc; a correction it measured across the seam is folded to the short arc right
        // after the reconcile, so it decays through the few degrees it is. When this SDK build keeps them elsewhere the
        // members are not found and the SDK's own value is drawn, as before.

        private static readonly System.Reflection.FieldInfo PrevField = RollbackMember<System.Reflection.FieldInfo>("prev");
        private static readonly System.Reflection.FieldInfo ErrorField = RollbackMember<System.Reflection.FieldInfo>("error");
        private static readonly System.Reflection.MethodInfo RenderAlphaMethod = RollbackMember<System.Reflection.MethodInfo>("RenderAlpha");

        private static T RollbackMember<T>(string name) where T : System.Reflection.MemberInfo
        {
            const System.Reflection.BindingFlags flags = System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Public;
            try
            {
                for (var t = typeof(Reconciler<AuthorityEntity, AuthorityInput>); t != null; t = t.BaseType)
                {
                    System.Reflection.MemberInfo m = typeof(T) == typeof(System.Reflection.MethodInfo)
                        ? (System.Reflection.MemberInfo)t.GetMethod(name, flags, null, System.Type.EmptyTypes, null)
                        : t.GetField(name, flags | System.Reflection.BindingFlags.DeclaredOnly);
                    if (m is T found) return found;
                }
            }
            catch (Exception) { }
            return null;
        }

        /// <summary>
        /// Whether this Colyseus SDK build exposes what the session reads to draw your own heading as an angle (its
        /// reconciler's correction and previous step, by reflection). When false (a build that renamed them, or a linker
        /// that stripped their metadata) your heading is drawn as the SDK eases it: across ±π the long way round for a step.
        /// </summary>
        public static bool AngleRenderAvailable => PrevField != null && ErrorField != null && RenderAlphaMethod != null;

        /// <summary>Your own predicted heading and its render correction, read before a frame's tick (not <c>Read</c> when
        /// the heading is not mirrored, or this SDK build keeps them elsewhere). A value type: Frame() allocates nothing for it.</summary>
        private struct HeadingBefore
        {
            public bool Read;
            public double Local, Error;
        }

        private static HeadingBefore YawBefore(Own tracked)
        {
            var reconciler = tracked.Reconciler;
            if (reconciler == null || Array.IndexOf(tracked.Fields, "yaw") < 0 || ErrorField == null) return default;
            if (!(ErrorField.GetValue(reconciler) is Dictionary<string, double> error)) return default;
            return new HeadingBefore { Read = true, Local = reconciler.State.yaw, Error = error.TryGetValue("yaw", out var e) ? e : 0 };
        }

        /// <summary>
        /// A correction of the predicted heading is an angle: one the reconcile measured across ±π (about 2π, the same
        /// heading) is folded to the short arc, so it decays through the few degrees it is rather than through every
        /// heading. The reconcile re-bases the render correction to the heading drawn before it less the predicted heading
        /// after it, and the same tick then decays it, so the fold is of that correction (rebuilt from the heading and
        /// correction read before the tick), carried through the same decay: folding the decayed value instead turns e.g.
        /// 0.7 of a 2π crossing into −0.3 of a turn, drawn the long way (the yaw-fold edge scenario).
        /// </summary>
        private static void FoldYawCorrection(Own tracked, int seqBefore, HeadingBefore before)
        {
            var reconciler = tracked.Reconciler;
            if (!before.Read || reconciler == null || reconciler.ReconcileSeq == seqBefore || Array.IndexOf(tracked.Fields, "yaw") < 0 || ErrorField == null) return;
            if (!(ErrorField.GetValue(reconciler) is Dictionary<string, double> error) || !error.TryGetValue("yaw", out var e)) return;
            var correction = before.Local + before.Error - reconciler.State.yaw;
            if (!(correction < -Math.PI || correction >= Math.PI)) return;
            // e is the correction after this tick's decay (0 if the reconcile snapped or re-seeded).
            error["yaw"] = WrapAngle(correction) * (e / correction);
        }

        /// <summary>
        /// Your own predicted heading as the reconciler would render it, interpolated along the short arc (NaN when it is
        /// not mirrored, or this SDK build renders elsewhere).
        /// </summary>
        private static double OwnYaw(Own tracked)
        {
            var reconciler = tracked.Reconciler;
            if (reconciler == null || Array.IndexOf(tracked.Fields, "yaw") < 0 || !AngleRenderAvailable) return double.NaN;
            if (!(ErrorField.GetValue(reconciler) is Dictionary<string, double> error) || !(PrevField.GetValue(reconciler) is Dictionary<string, double> prev)) return double.NaN;
            var current = reconciler.State.yaw;
            var smoothed = current + (error.TryGetValue("yaw", out var e) ? e : 0);
            var from = prev.TryGetValue("yaw", out var p) ? p : smoothed;
            var alpha = RenderAlphaMethod.Invoke(reconciler, null) is double a ? a : 1;
            return from + WrapAngle(smoothed - from) * alpha;
        }

        // ---------------- other entities: a respawn is a step on the render timeline ----------------
        // Another entity is drawn renderDelay behind, and lag compensation judges a shot at that same render
        // time (§17.5), so its snap lands there too: until the render time reaches the patch that carried the
        // bump, the old life is drawn and the view reports the old epoch. Snapping when the bump arrived drew
        // the new spot renderDelay + rtt/2 before the server's rewind had it there: every shot in that window
        // missed.
        //
        // While a respawn is pending the old life is drawn from this session's own record of its patches
        // (every entity's pose at every patch, interpolated on the render time and held at its last one), not
        // from the SDK's lerp: the lerp samples a field only when that field changes, so a coordinate that
        // stood still before the respawn (a target strafing along y keeps its x) has its previous sample far
        // back, and the SDK's gap resume places a hold one patch interval before the new value. That glide
        // starts before the old life's last patch: measured at 300 ms RTT, 0.59 world units a frame for two
        // frames, inside one drawn life. Otherwise (no respawn pending) others are the SDK's lerp, unchanged.

        /// <summary>How much of an entity's patch record is kept: the render delay plus half the worst round trip, with room.</summary>
        private const double RemoteHistoryMs = 1000;

        /// <summary>A drawn pose at time <c>T</c> on the render timeline.</summary>
        internal struct Pose
        {
            public double T, X, Y, Z, Yaw, Pitch, Duck;
        }

        private sealed class Respawn
        {
            public double At, Epoch;
            public List<Pose> History;
        }

        private sealed class Remote
        {
            public AuthorityEntity Entity;
            public double Epoch;
            public List<Pose> History = new List<Pose>();
            public readonly List<Respawn> Respawns = new List<Respawn>();
        }

        /// <summary>The server-stamped timeline Predict samples on and renders from.</summary>
        private double PatchTime()
        {
            var clock = room.Clock;
            return clock.LastServerTime() > 0 ? clock.LastServerTime() : RoomClock.GetNow();
        }

        /// <summary>Where other entities are drawn on that timeline (the SDK lerp's target and the server rewind's).</summary>
        /// <summary>The render time an input sent now carries on the fast channel: the stamp the handle's WebSocket frame
        /// carries (§17.12 <i>Render-time stamp</i>), on the room clock and the render delay the handle was given.</summary>
        private uint FastRenderStamp()
        {
            var clock = room.Clock;
            var now = clock.LastServerTime() > 0 ? clock.ServerNow() : (double?)null;
            return GenexFastTransport.RenderStamp(now, renderDelay, clock.SmoothedRtt());
        }

        private double RenderTime()
        {
            var clock = room.Clock;
            return clock.LastServerTime() > 0 ? ServerNowDrawn() - renderDelay - clock.SmoothedRtt() / 2 : RoomClock.GetNow() - FrameLag() - renderDelay;
        }

        private static Pose PoseOf(AuthorityEntity e, double t) => new Pose { T = t, X = e.x, Y = e.y, Z = e.z, Yaw = e.yaw, Pitch = e.pitch, Duck = e.duck };

        /// <summary>Once per decoded patch: note every entity's pose and time, and every epoch bump.</summary>
        private void NotePatches()
        {
            var map = EntityMap();
            if (map == null) return;
            var at = PatchTime();
            foreach (var kv in map)
            {
                var e = kv.Value;
                if (e == null || e.t0 > 0) continue; // a projectile is drawn from its flight, never from patches
                if (IsBodyEntity(kv.Key)) continue; // a body is drawn from its own states (Bodies below)
                if (!remotes.TryGetValue(kv.Key, out var known) || known.Entity != e)
                {
                    known = new Remote { Entity = e, Epoch = e.epoch };
                    remotes[kv.Key] = known;
                    ticked.Forget(kv.Key);
                }
                else if (known.Epoch != e.epoch)
                {
                    // The own entity's bump is not held (it is re-seeded): its new life starts a fresh record.
                    if (e.owner != room.SessionId) known.Respawns.Add(new Respawn { At = at, Epoch = known.Epoch, History = known.History });
                    known.History = new List<Pose>();
                    known.Epoch = e.epoch;
                }
                var history = known.History;
                if (history.Count == 0 || at > history[history.Count - 1].T) history.Add(PoseOf(e, at));
                while (history.Count > 2 && history[1].T < at - RemoteHistoryMs) history.RemoveAt(0);
            }
            gone.Clear();
            foreach (var id in remotes.Keys) if (!map.ContainsKey(id)) gone.Add(id);
            foreach (var id in gone)
            {
                remotes.Remove(id);
                ticked.Forget(id);
            }
        }

        /// <summary>Whether other entities are drawn on the tick timeline: in a predicting room (physDesc set), unless
        /// <see cref="GenexAuthorityOptions.RemoteSamples"/> is <see cref="GenexRemoteSamples.Patch"/>.</summary>
        private bool DrawsOnTicks() => options.RemoteSamples != GenexRemoteSamples.Patch && !string.IsNullOrEmpty(room.State?.physDesc);

        /// <summary>The room's K (keyframe interval in ticks; 1 when its physDesc does not parse), cached per text.</summary>
        private int KeyframeTicksOf(string text)
        {
            if (!string.Equals(keyframeTicksText, text, StringComparison.Ordinal))
            {
                keyframeTicksText = text;
                var k = GenexPhysDesc.Parse(text)?.KeyframeTicks ?? 1;
                keyframeTicks = k > 0 ? k : 1;
            }
            return keyframeTicks;
        }

        /// <summary>
        /// §17.11 *Drawing other seats*: once a patch is decoded whole, in a predicting room whose state holds a keyframe
        /// (<c>tick == keyframe</c>), every entity (not a projectile, not a body) is sampled at that keyframe's instant on the
        /// room clock, <c>tickOrigin + tick / tickHz</c>, in its life (epoch). The TypeScript samples only the entities the
        /// patch changed; an unchanged one here repeats its held pose at the keyframe, which draws the same as the TypeScript's
        /// held repeat a keyframe period before its next change.
        /// </summary>
        private void SampleTicks()
        {
            var state = room.State;
            var map = EntityMap();
            if (state == null || map == null || !DrawsOnTicks() || state.tick != state.keyframe) return;
            var hz = TickHz();
            var at = GenexProjectile.TickInstant(state.tick, TickOrigin(), hz);
            var period = 1000 / hz * KeyframeTicksOf(state.physDesc);
            telemetry.TickKeyframes++;
            foreach (var kv in map)
            {
                var e = kv.Value;
                if (e == null || e.t0 > 0 || IsBodyEntity(kv.Key)) continue;
                ticked.Push(kv.Key, at, new GenexTickPose { X = e.x, Y = e.y, Z = e.z, Yaw = e.yaw, Pitch = e.pitch, Duck = e.duck }, period, e.epoch);
            }
        }

        /// <summary>The respawn the render time has not reached yet, if any (those it passed are dropped).</summary>
        private Respawn PendingRespawn(string id, AuthorityEntity entity, double now)
        {
            if (!remotes.TryGetValue(id, out var remote) || remote.Entity != entity) return null;
            var respawns = remote.Respawns;
            while (respawns.Count > 0 && now >= respawns[0].At) respawns.RemoveAt(0);
            return respawns.Count > 0 ? respawns[0] : null;
        }

        /// <summary>
        /// The output spring on other entities (<see cref="GenexAuthorityOptions.RemoteSmoothMs"/>, display only): eases
        /// toward the render-time pose within a life, never across a respawn. 0 draws exactly what a shot is judged
        /// against.
        /// </summary>
        private Pose Smoothed(string id, Pose target, double epoch)
        {
            // Eased by the frames' instants, as everything Frame(now) draws (FrameLag).
            var now = GenexTime.Now() - FrameLag();
            var has = springs.TryGetValue(id, out var last);
            var output = SpringStep(target, epoch, has, last.Pose, last.Epoch, has ? now - last.At : 0, options.RemoteSmoothMs);
            springs[id] = new Spring { Pose = output, Epoch = epoch, At = now };
            return output;
        }

        /// <summary>
        /// One step of the output spring, from the pose drawn <paramref name="dt"/> ms ago toward
        /// <paramref name="target"/>: the target itself on first sight, across a respawn (a new
        /// <paramref name="epoch"/>) or with <paramref name="tau"/> ≤ 0; the last pose again in the same instant;
        /// otherwise eased by 1 − e^(−dt/τ), the heading along the shorter arc and the pitch straight.
        /// </summary>
        internal static Pose SpringStep(Pose target, double epoch, bool has, Pose lastPose, double lastEpoch, double dt, double tau)
        {
            if (!has || lastEpoch != epoch) return target;
            if (dt <= 0) return lastPose; // a second read in the same instant
            if (tau <= 0) return target;
            var k = 1 - Math.Exp(-dt / tau);
            var turn = Math.Atan2(Math.Sin(target.Yaw - lastPose.Yaw), Math.Cos(target.Yaw - lastPose.Yaw));
            return new Pose
            {
                X = lastPose.X + (target.X - lastPose.X) * k,
                Y = lastPose.Y + (target.Y - lastPose.Y) * k,
                Z = lastPose.Z + (target.Z - lastPose.Z) * k,
                Yaw = lastPose.Yaw + turn * k,
                Pitch = lastPose.Pitch + (target.Pitch - lastPose.Pitch) * k,
                Duck = lastPose.Duck + (target.Duck - lastPose.Duck) * k,
            };
        }

        private struct Spring
        {
            public Pose Pose;
            public double Epoch, At;
        }

        /// <summary>Linear interpolation of noted patches (oldest first) at <paramref name="time"/>, clamped to the ends; yaw along the shorter arc, pitch straight.</summary>
        internal static Pose Sample(List<Pose> history, double time)
        {
            if (history.Count == 1 || time <= history[0].T) return history[0];
            var last = history[history.Count - 1];
            if (time >= last.T) return last;
            var k = history.Count - 2;
            while (k > 0 && history[k].T > time) k--;
            var a = history[k];
            var b = history[k + 1];
            var u = (time - a.T) / (b.T - a.T);
            var turn = Math.Atan2(Math.Sin(b.Yaw - a.Yaw), Math.Cos(b.Yaw - a.Yaw));
            return new Pose
            {
                T = time, X = a.X + (b.X - a.X) * u, Y = a.Y + (b.Y - a.Y) * u, Z = a.Z + (b.Z - a.Z) * u, Yaw = a.Yaw + turn * u,
                Pitch = a.Pitch + (b.Pitch - a.Pitch) * u, Duck = a.Duck + (b.Duck - a.Duck) * u,
            };
        }

        // ---------------- views ----------------

        /// <summary>
        /// The views wait for the room clock's first round trip (at most <see cref="ClockWarmupTimeoutMs"/>): the
        /// SDK's lerp draws others at serverNow - renderDelay - rtt/2, and with no RTT sample yet that is rtt/2
        /// too late, so a remote drawn before the first input ack steps back once when it lands (measured at
        /// 150 ms: 0.59 world units in one frame, over the teleport bar). Inputs already flow meanwhile: they
        /// are what the clock measures. Godot's session waits the same way.
        /// </summary>
        private bool Warm()
        {
            if (warm) return true;
            if (room.Clock.SmoothedRtt() <= 0 && GenexTime.Now() < warmDeadline) return false;
            warm = true;
            return true;
        }

        private void RefreshViews()
        {
            var map = Warm() ? EntityMap() : null;
            var pending = map != null ? PendingShots() : null;
            gone.Clear();
            foreach (var id in views.Keys) if (map == null || !(map.ContainsKey(id) || pending.ContainsKey(id) || HeldBody(id))) gone.Add(id);
            foreach (var id in gone)
            {
                views.Remove(id);
                springs.Remove(id);
                sides.Remove(id);
            }
            if (map != null)
            {
                var now = RenderTime();
                var tick = NowTick();
                foreach (var kv in map)
                {
                    if (kv.Value == null) continue;
                    if (bodies.TryGetValue(kv.Key, out var body) && body.Entity == kv.Value) BodyView(kv.Key, body, true);
                    else if (kv.Value.t0 > 0) ProjectileView(kv.Key, kv.Value, tick);
                    else RefreshView(kv.Key, kv.Value, now);
                }
                // Bodies out of this client's view (§17.10 Interest): held at their last state while the descriptor lasts.
                foreach (var kv in bodies) if (!map.ContainsKey(kv.Key) && kv.Value.Drawer.HasState) BodyView(kv.Key, kv.Value, false);
                foreach (var shot in pending.Values) if (!map.ContainsKey(shot.Id)) ShotView(shot, tick);
                SeparateSeats();
                DrawnTick = room.Clock.LastServerTime() > 0 ? tick : double.NaN;
            }
            RefreshPlayers();
        }

        /// <summary>
        /// §17.11 *Drawing other seats* (session.ts <c>nearSeats</c>), with a contact rule and your prediction: every other seat's
        /// own entity (owned by a seated player, not a projectile, not a body), on your clock (<c>predicted</c>, where the seat
        /// prediction has it, with its correction: <see cref="DrawPredictedSeats"/>) or as RefreshView drew it on the render
        /// timeline (<c>separate</c>), then moved out of your drawn entity by the contact rule and taken round it, never across it,
        /// and out of each other (<see cref="GenexSeatSeparation.Seats"/>). Draw-only: the state and your entity are unchanged.
        /// Without your prediction the seats are drawn on the timeline and the memory is dropped. A seat's (or pair's) memory is
        /// forgotten when a life on either side changed since, or when it is older than <see cref="SideStaleMs"/>.
        /// </summary>
        private void SeparateSeats()
        {
            var map = EntityMap();
            var players = room.State?.players;
            var draws = separation != null && HasContacts() && SeatDrawingNow() != GenexSeatDrawing.Timeline;
            if (!draws || map == null || players == null || own == null || own.Reconciler == null || !views.TryGetValue(own.Id, out var mine))
            {
                sides.Clear();
                SeatDrawTick = SeatDrawLead = double.NaN;
                return;
            }
            // The frame's instant, as the spring's (FrameLag).
            var now = GenexTime.Now() - FrameLag();
            var onYourClock = SeatWorldDrawn() != null;
            var predicted = onYourClock ? DrawPredictedSeats(map, players, now) : null;
            if (!onYourClock) SeatDrawTick = SeatDrawLead = double.NaN;
            var declared = Declared() != null;
            var ownLife = own.Entity.epoch.ToString("R", System.Globalization.CultureInfo.InvariantCulture);
            separateYou.Id = own.Id;
            separateYou.X = mine.X;
            separateYou.Y = mine.Y;
            separateYou.Z = mine.Z;
            separateYou.Yaw = mine.Yaw;
            var seats = new List<GenexContactBody>();
            var lives = new Dictionary<string, string>();
            foreach (var kv in map)
            {
                var e = kv.Value;
                if (e == null || kv.Key == own.Id || string.IsNullOrEmpty(e.owner) || e.t0 > 0 || IsBodyEntity(kv.Key)) continue;
                if (!players.TryGetValue(e.owner, out var player) || player == null || !views.TryGetValue(kv.Key, out var v)) continue;
                seats.Add(new GenexContactBody(kv.Key) { X = v.X, Y = v.Y, Z = v.Z, Yaw = v.Yaw, Flags = declared ? e.flags : 0 });
                lives[kv.Key] = ownLife + "/" + v.Epoch.ToString("R", System.Globalization.CultureInfo.InvariantCulture);
            }
            for (var i = 0; i < seats.Count; i++)
            {
                for (var k = 0; k < seats.Count; k++)
                {
                    var a = seats[i].Id;
                    var b = seats[k].Id;
                    if (string.CompareOrdinal(a, b) >= 0) continue;
                    lives[GenexSeatSeparation.PairKey(a, b)] = views[a].Epoch.ToString("R", System.Globalization.CultureInfo.InvariantCulture) + "/"
                        + views[b].Epoch.ToString("R", System.Globalization.CultureInfo.InvariantCulture);
                }
            }
            var prev = new Dictionary<string, GenexSeatSide>();
            foreach (var kv in lives)
            {
                if (sides.TryGetValue(kv.Key, out var last) && last.Lives == kv.Value && now - last.Side.At <= SideStaleMs) prev[kv.Key] = last.Side;
            }
            var next = new Dictionary<string, GenexSeatSide>();
            var drawn = separation.Seats(separateYou, seats, prev, now, next);
            sides.Clear();
            foreach (var kv in next) sides[kv.Key] = new DrawnSide { Side = kv.Value, Lives = lives.TryGetValue(kv.Key, out var life) ? life : "" };
            foreach (var kv in drawn)
            {
                if (!views.TryGetValue(kv.Key, out var v)) continue;
                v.X = kv.Value.X;
                v.Y = kv.Value.Y;
                v.Z = kv.Value.Z;
                if (predicted != null && predicted.TryGetValue(kv.Key, out var at))
                {
                    v.SeatCorrection = GenexSeatSeparation.Hypot(kv.Value.X - at.X, kv.Value.Y - at.Y, kv.Value.Z - at.Z);
                }
            }
        }

        /// <summary>
        /// <see cref="GenexSeatDrawing.Predicted"/> (session.ts <c>predictedPoses</c>): every other seat the seat prediction has, at
        /// the input your entity is drawn at, with its correction (<see cref="GenexSeatOffset.Next"/>): the views' x y z yaw
        /// overwritten and marked predicted, the predicted pose by id returned. Null (and SeatDrawTick NaN) without a pass.
        /// </summary>
        private Dictionary<string, GenexSeatPose> DrawPredictedSeats(Colyseus.Schema.MapSchema<AuthorityEntity> map, Colyseus.Schema.MapSchema<AuthorityPlayer> players, double now)
        {
            var drawnFrom = SeatWorldDrawn();
            var pass = drawnFrom.Current;
            if (pass == null)
            {
                SeatDrawTick = SeatDrawLead = double.NaN;
                return null;
            }
            var alpha = AngleRenderAvailable && RenderAlphaMethod.Invoke(own.Reconciler, null) is double a ? a : 1;
            var ack = SteppedAck();
            // Other seats are drawn on a smooth clock of their own (seat-predict.ts seatClock), on the throttled clock's share
            // of its lead (§17.11 *Input pacing*), so the drawing never jumps when an extra input goes out.
            var drawnPast = Math.Max(0, handle.SentCount - ack - 1 + alpha);
            var lead = GenexInputRepeat.SeatLeadClock(ack, drawnPast, throttle, handle.StepMs ?? 0, now);
            // §17.11 *Touching*: a seat touching your entity is drawn at the input your entity is drawn at exactly, blended in
            // and out, so a bump is drawn on both on the same frame.
            var exact = ack + drawnPast;
            seatDrawClock = GenexSeatClock.Next(seatDrawClock, lead.Raw, lead.At, TickHz());
            var seq = seatDrawClock.Value.Seq;
            var dtMs = double.IsNaN(seatOffsetsAt) ? 0 : now - seatOffsetsAt;
            seatOffsetsAt = now;
            var tick = pass.StateTick + (seq - pass.Ack);
            SeatDrawTick = tick;
            SeatDrawLead = GenexProjectile.TickInstant(tick + 1, TickOrigin(), TickHz()) - ServerNowDrawn();
            var snap = GenexSeatOffset.SeatSnapMetres * SeatUnitsPerMetre();
            var output = new Dictionary<string, GenexSeatPose>();
            foreach (var kv in map)
            {
                var e = kv.Value;
                if (e == null || kv.Key == own.Id || string.IsNullOrEmpty(e.owner) || e.t0 > 0 || IsBodyEntity(kv.Key)) continue;
                if (!players.TryGetValue(e.owner, out var player) || player == null || !views.TryGetValue(kv.Key, out var v)) continue;
                var motion = drawnFrom.MotionAt(kv.Key, seq);
                if (motion == null) continue;
                seatOffsets.TryGetValue(kv.Key, out var known);
                var change = known?.Pass != null && !ReferenceEquals(known.Pass, pass) ? drawnFrom.ChangeAt(kv.Key, seq, known.Pass) : null;
                var off = GenexSeatOffset.Next(known, pass, e.epoch, change, motion.Value, dtMs, drawnFrom.TouchingAt(kv.Key, seq), snap, drawnFrom.StateRate(kv.Key));
                seatOffsets[kv.Key] = off;
                var p = motion.Value.Pose;
                v.X = p.X + off.Dx;
                v.Y = p.Y + off.Dy;
                v.Z = p.Z + off.Dz;
                v.Yaw = p.Yaw + off.Dyaw;
                // §17.11 *Touching*: moved its share of the way from the seat clock's input to your exact one.
                double? shareKnown = touchShares.TryGetValue(kv.Key, out var had) ? had : (double?)null;
                var share = GenexSeatTouch.Share(shareKnown, drawnFrom.TouchAheadMs(kv.Key, exact).HasValue, dtMs);
                touchShares[kv.Key] = share;
                var there = share > 0 ? drawnFrom.MotionAt(kv.Key, exact) : null;
                if (there != null)
                {
                    var t = there.Value.Pose;
                    v.X += (t.X - p.X) * share;
                    v.Y += (t.Y - p.Y) * share;
                    v.Z += (t.Z - p.Z) * share;
                    v.Yaw += WrapAngle(t.Yaw - p.Yaw) * share;
                }
                v.Yaw = WrapAngle(v.Yaw);
                v.Epoch = e.epoch;
                v.IsPredicted = true;
                output[kv.Key] = p;
            }
            var gone = new List<string>();
            foreach (var id in seatOffsets.Keys) if (!output.ContainsKey(id)) gone.Add(id);
            foreach (var id in gone) seatOffsets.Remove(id);
            var untouched = new List<string>();
            foreach (var id in touchShares.Keys) if (!output.ContainsKey(id)) untouched.Add(id);
            foreach (var id in untouched) touchShares.Remove(id);
            return output;
        }

        /// <summary>Room units per metre: the state's, else the preset's implied one (vehicle 100, firstperson 39.37).</summary>
        private double SeatUnitsPerMetre()
        {
            var unit = room.State?.lengthUnit ?? 0;
            if (unit > 0 && !double.IsInfinity(unit)) return unit;
            var text = room.State?.preset ?? "";
            if (text != seatUnitPreset)
            {
                seatUnitPreset = text;
                var name = GenexJson.ParseObject(text) is Dictionary<string, object> o ? GenexJson.Str(o, "name") : "";
                seatUnitOfPreset = name == GenexPresets.Vehicle ? 100 : name == GenexPresets.Firstperson ? 39.37 : 1;
            }
            return seatUnitOfPreset;
        }

        /// <summary>The room's physDesc, cached per text (it never changes in a room's life); null when it has none.</summary>
        private GenexPhysDesc SeatDescNow()
        {
            var text = room.State?.physDesc ?? "";
            if (text != seatDescText)
            {
                seatDescText = text;
                seatDesc = GenexPhysDesc.Parse(text);
            }
            return seatDesc;
        }

        private (string Predict, double DecayMs) SeatRemote()
        {
            var desc = SeatDescNow();
            return (desc?.RemotePredict ?? GenexRemotePredict.Hold, desc?.RemoteDecayMs ?? GenexPhysicsKeyframe.DefaultRemoteDecayMs);
        }

        /// <summary>The room preset's step on another seat's body, cached per preset and world (the seat world steps every tick).</summary>
        private GenexRemoteStep SeatStep()
        {
            var text = room.State?.preset ?? "";
            if (text != seatStepPreset || world.Hash != seatStepWorld)
            {
                seatStepPreset = text;
                seatStepWorld = world.Hash;
                seatStep = RemoteStep();
            }
            return seatStep;
        }

        /// <summary>Every other seat in the latest state with its preset fields and its last applied input (session.ts <c>held</c>).</summary>
        private IList<GenexHeldSeat> HeldSeats()
        {
            var output = new List<GenexHeldSeat>();
            var map = EntityMap();
            var players = room.State?.players;
            if (map == null || players == null) return output;
            var fields = GenexPresets.PredictionFor(room.State?.preset, world)?.Fields;
            var declared = Declared() != null;
            foreach (var kv in map)
            {
                var e = kv.Value;
                if (e == null || kv.Key == own?.Id || string.IsNullOrEmpty(e.owner) || e.t0 > 0 || IsBodyEntity(kv.Key)) continue;
                if (!players.TryGetValue(e.owner, out var player) || player == null) continue;
                var seat = new GenexHeldSeat { Id = kv.Key, Epoch = e.epoch };
                foreach (var f in GenexSeatContacts.Fields) seat.Body[f] = NumberOf(e[f]);
                if (fields != null) foreach (var f in fields) seat.Body[f] = NumberOf(e[f]);
                if (declared) seat.Body["flags"] = e.flags;
                seat.Input = new GenexRemoteInput
                {
                    MoveX = player.inMoveX, MoveY = player.inMoveY, MoveZ = player.inMoveZ, Yaw = player.inYaw, Pitch = player.inPitch, Buttons = player.inButtons,
                };
                output.Add(seat);
            }
            return output;
        }

        /// <summary>A schema field's value as a double (a float32 widened; anything else 0).</summary>
        private static double NumberOf(object v) => v is double d ? d : v is float f ? f : 0;

        /// <summary>Another seat's entity after the tick of your input <paramref name="seq"/>, as the seat prediction has it (the client
        /// world poses its preset body there); null without one.</summary>
        private GenexRuleSeat? SeatPoseOf(string key, long seq)
        {
            var at = SeatWorldNow()?.PoseAt(key, seq);
            if (at == null) return null;
            var p = at.Value;
            return new GenexRuleSeat { Key = key, X = p.X, Y = p.Y, Z = p.Z, Vx = p.Vx, Vy = p.Vy, Vz = p.Vz };
        }

        /// <summary>A seat not drawn against yours for longer than this (ms: a stalled player) is separated afresh, not taken
        /// round your entity from where it was drawn then (session.ts SIDE_STALE_MS).</summary>
        private const double SideStaleMs = 250;

        private struct DrawnSide
        {
            public GenexSeatSide Side;
            /// <summary>The lives it was drawn in: yours and the seat's, or the pair's two.</summary>
            public string Lives;
        }

        /// <summary>The view of <paramref name="id"/>, its body fields reset (BodyView writes them again for a body).</summary>
        private GenexAuthorityEntity ViewFor(string id)
        {
            if (!views.TryGetValue(id, out var v))
            {
                v = new GenexAuthorityEntity { Id = id };
                views[id] = v;
            }
            if (v.IsBody)
            {
                // An entity whose body was removed is an ordinary entity again (§17.10 Bodies and entities).
                v.IsBody = false;
                v.Qx = v.Qy = v.Qz = 0;
                v.Qw = 1;
                v.Lvx = v.Lvy = v.Lvz = v.Avx = v.Avy = v.Avz = 0;
                v.Sleep = false;
                v.InView = true;
                v.BodyType = v.BodyKind = v.Colliders = "";
                v.BodyOffset = 0;
            }
            return v;
        }

        private void RefreshView(string id, AuthorityEntity e, double renderTime)
        {
            var v = ViewFor(id);
            v.Kind = e.kind ?? "";
            v.Owner = e.owner ?? "";
            v.IsMine = v.Owner == room.SessionId;
            // An older server has none of the projectile fields: they read 0, 0, "".
            v.T0 = e.t0;
            v.G = e.g;
            v.Src = e.src ?? "";
            v.IsPredicted = false;
            v.SeatCorrection = 0;
            v.VX = e.vx;
            v.VY = e.vy;
            v.VZ = e.vz;
            v.Hp = e.hp;
            v.Flags = e.flags;
            v.Data = e.data ?? "";
            v.ServerX = e.x;
            v.ServerY = e.y;
            v.ServerZ = e.z;
            v.ServerYaw = e.yaw;
            v.ServerEpoch = e.epoch;
            v.ServerPitch = e.pitch;
            v.Cap = e.cap;
            // Predict.Value is the reconciler's predicted pose for your own entity, the lerp for the others.
            if (own != null && own.Entity == e && own.Reconciler != null)
            {
                var snapped = RoomClock.GetNow() < own.SnapUntil ? SnapPose(own) : null;
                var pose = snapped ?? Interpolated(e);
                // Your own heading as an angle (the SDK's value read first above, as a render read).
                if (snapped == null)
                {
                    var yaw = OwnYaw(own);
                    if (!double.IsNaN(yaw)) pose.Yaw = yaw;
                }
                ShoveEased(own, ref pose);
                v.X = pose.X;
                v.Y = pose.Y;
                v.Z = pose.Z;
                v.Yaw = WrapAngle(pose.Yaw);
                v.Pitch = DrawnPitch(pose.Pitch);
                v.Duck = DrawnDuck(pose.Duck);
                // The movement bits as predicted (the server's when the prediction does not mirror them).
                v.Mstate = Array.IndexOf(own.Fields, "mstate") >= 0 ? own.Reconciler.State.mstate : e.mstate;
                // A vehicle's yaw rate and fuel as predicted (the server's when the prediction does not mirror them).
                v.Spin = Array.IndexOf(own.Fields, "spin") >= 0 ? own.Reconciler.State.spin : e.spin;
                v.Fuel = Array.IndexOf(own.Fields, "fuel") >= 0 ? own.Reconciler.State.fuel : e.fuel;
                v.Epoch = own.DrawnEpoch;
                return;
            }
            var respawn = PendingRespawn(id, e, renderTime);
            Pose drawn;
            double epoch;
            if (DrawsOnTicks() && ticked.At(id, renderTime, out var tp, out var life))
            {
                // §17.11 *Drawing other seats*: the tick timeline, which holds the old life until the new one's first sample.
                // The epoch drawn is the sample's life, so the output spring snaps on the very frame the pose changes life
                // (the respawn's patch stamp is up to a tick later than that keyframe's instant).
                drawn = new Pose { X = tp.X, Y = tp.Y, Z = tp.Z, Yaw = tp.Yaw, Pitch = tp.Pitch, Duck = tp.Duck };
                epoch = life;
            }
            else
            {
                drawn = respawn != null && respawn.History.Count > 0 ? Sample(respawn.History, renderTime) : Interpolated(e);
                epoch = respawn != null ? respawn.Epoch : e.epoch;
            }
            var shown = Smoothed(id, drawn, epoch);
            v.X = shown.X;
            v.Y = shown.Y;
            v.Z = shown.Z;
            v.Yaw = WrapAngle(shown.Yaw);
            v.Pitch = DrawnPitch(shown.Pitch);
            v.Duck = DrawnDuck(shown.Duck);
            v.Mstate = e.mstate;
            v.Spin = e.spin;
            v.Fuel = e.fuel;
            v.Epoch = epoch;
        }

        /// <summary>The SDK's pose for an entity: the reconciler's for your own predicted fields, the lerp for the rest.</summary>
        private Pose Interpolated(AuthorityEntity e) => new Pose
        {
            X = predict.Value(e, "x"), Y = predict.Value(e, "y"), Z = predict.Value(e, "z"), Yaw = predict.Value(e, "yaw"),
            Pitch = predict.Value(e, "pitch"), Duck = predict.Value(e, "duck"),
        };

        /// <summary>A drawn pitch: wrapped to [-π, π) and held to the room's pitchLimit (eased straight, it is already inside both).</summary>
        private double DrawnPitch(double v)
        {
            var text = room.State?.preset ?? "";
            if (pitchLimitText != text)
            {
                pitchLimitText = text;
                pitchLimit = GenexPresets.PitchLimit(text);
            }
            var wrapped = WrapAngle(v);
            return wrapped < -pitchLimit ? -pitchLimit : wrapped > pitchLimit ? pitchLimit : wrapped;
        }

        private static double DrawnDuck(double v) => double.IsNaN(v) ? 0 : v < 0 ? 0 : v > 1 ? 1 : v;

        /// <summary>
        /// The own entity's pose just after a respawn: its predicted state (no correction offset), eased from the
        /// previous fixed step to the latest over one step, as the reconciler's own render does. Fields the
        /// prediction does not mirror are drawn as usual.
        /// </summary>
        private Pose? SnapPose(Own tracked)
        {
            var cur = new double[tracked.Fields.Length];
            PredictedPose(tracked, cur);
            var now = RoomClock.GetNow();
            if (tracked.SnapCur == null || !cur.SequenceEqual(tracked.SnapCur))
            {
                tracked.SnapPrev = tracked.SnapCur ?? cur;
                tracked.SnapCur = cur;
                tracked.SnapAt = now;
            }
            var stepMs = handle.StepMs ?? 1000.0 / A.Timing.TickHz;
            var u = Math.Max(0, Math.Min(1, (now - tracked.SnapAt) / stepMs));
            var pose = Interpolated(tracked.Entity);
            for (var i = 0; i < tracked.Fields.Length; i++)
            {
                var a = tracked.SnapPrev[i];
                var b = tracked.SnapCur[i];
                switch (tracked.Fields[i])
                {
                    case "x": pose.X = a + (b - a) * u; break;
                    case "y": pose.Y = a + (b - a) * u; break;
                    case "z": pose.Z = a + (b - a) * u; break;
                    case "yaw": pose.Yaw = a + WrapAngle(b - a) * u; break;
                    case "pitch": pose.Pitch = a + (b - a) * u; break;
                    case "duck": pose.Duck = a + (b - a) * u; break;
                }
            }
            return pose;
        }

        private void RefreshPlayers()
        {
            var players = room.State?.players;
            gone.Clear();
            foreach (var id in playerViews.Keys) if (players == null || !players.ContainsKey(id)) gone.Add(id);
            foreach (var id in gone) playerViews.Remove(id);
            if (players == null) return;
            foreach (var kv in players)
            {
                var p = kv.Value;
                if (p == null) continue;
                if (!playerViews.TryGetValue(kv.Key, out var v))
                {
                    v = new GenexAuthorityPlayer { Id = kv.Key };
                    playerViews[kv.Key] = v;
                }
                v.Name = p.name ?? "";
                v.Uid = p.uid ?? "";
                v.Team = p.team ?? "";
                v.Connected = p.connected;
                v.AvatarUrl = p.avatarUrl ?? "";
                v.IsMe = kv.Key == room.SessionId;
            }
        }

        // ---------------- projectiles (§17.9): drawn from their flight, the shooter's own predicted ----------------
        // The room's tick rate is the input handshake's; a projectile is drawn at serverTick(now), from the room clock
        // the patches are stamped on.

        /// <summary>A prediction: its id, kind and launch (T0 the fractional tick it was fired at), when it was made on
        /// the room clock, and the input that fires it: its sequence on the input handle, under the handle's epoch.</summary>
        private sealed class Shot
        {
            public string Id, Kind;
            public GenexProjectileLaunch Launch;
            public double At;
            public int Seq, Epoch;
            public SpawnEntry<AuthorityEntity, Shot> Entry;
        }

        private double TickHz()
        {
            var stepMs = handle.StepMs;
            return stepMs.HasValue && stepMs.Value > 0 ? Math.Round(1000 / stepMs.Value) : A.Timing.TickHz;
        }

        private double TickOrigin() => room.State?.tickOrigin ?? 0;

        private double NowTick() => GenexProjectile.ServerTick(ServerNowDrawn(), TickOrigin(), TickHz());

        private double LaunchInstant(AuthorityEntity e) => GenexProjectile.TickInstant(e.t0, TickOrigin(), TickHz());

        private static GenexProjectileLaunch LaunchOf(AuthorityEntity e) =>
            new GenexProjectileLaunch { X = e.x, Y = e.y, Z = e.z, VX = e.vx, VY = e.vy, VZ = e.vz, G = e.g, T0 = e.t0 };

        /// <summary>The store's correlation: the server's projectile under this prediction's id confirms it.</summary>
        private bool Confirms(Shot local, AuthorityEntity server)
        {
            var map = EntityMap();
            if (map == null || !map.TryGetValue(local.Id, out var e) || e != server) return false;
            unsettled.Remove(local);
            telemetry.ProjectilesConfirmed++;
            telemetry.LastProjectileLeadMs = LaunchInstant(server) - local.At;
            return true;
        }

        /// <summary>Your predictions no server projectile has confirmed yet, by id (reused: read it before the next call).</summary>
        private Dictionary<string, Shot> PendingShots()
        {
            pendingById.Clear();
            foreach (var entry in shots.Entries()) if (!entry.Confirmed && entry.Local != null) pendingById[entry.Local.Id] = entry.Local;
            return pendingById;
        }

        private readonly Dictionary<string, Shot> pendingById = new Dictionary<string, Shot>();

        /// <summary>
        /// A state patch carries the server's acknowledgement of the inputs it consumed, with the state as of then: a
        /// prediction whose firing input is acknowledged and whose id that state lacks will never be confirmed. The
        /// server refused it, or launched it and removed it before a patch could carry it (a hit at point blank).
        /// Either way it is gone, now rather than after its TTL. An input of an earlier socket (another epoch) is never
        /// acknowledged on this one.
        /// </summary>
        /// <summary>
        /// The reconnect's first state is decoded: every prediction fired on an earlier socket that it did not confirm
        /// never will be (§17.9). The server consumed what it got of that socket's inputs before it sent this state, so
        /// a launch they made is in it (confirmed during its decode) or already removed; an input lost in the drop was
        /// never consumed, and its sequence is used again on this socket, so the new socket's shot reuses the lost
        /// one's id. Kept, the lost prediction would be the oldest pending one of that id and confirm the new shot with
        /// its own fire time (a lead of the whole reconnect), while the new prediction waited out its TTL. Dropped and
        /// counted rejected now; SettleShots never settles an earlier socket's input.
        /// </summary>
        private void DropEarlierSockets()
        {
            resyncFirstState = false;
            for (var i = unsettled.Count - 1; i >= 0; i--)
            {
                var shot = unsettled[i];
                if (shot.Epoch == handle.Epoch) continue;
                unsettled.RemoveAt(i);
                shot.Entry.Cancel();
                telemetry.ProjectilesRejected++;
            }
        }

        private void SettleShots()
        {
            if (unsettled.Count == 0) return;
            var map = EntityMap();
            // On the fast channel the snapshot's ack runs ahead of the WebSocket's list (§17.12 <i>Client</i>).
            var acked = fast.SettleAck();
            for (var i = unsettled.Count - 1; i >= 0; i--)
            {
                var shot = unsettled[i];
                if (shot.Epoch != handle.Epoch || shot.Seq > acked || (map != null && map.ContainsKey(shot.Id))) continue;
                unsettled.RemoveAt(i);
                shot.Entry.Cancel();
                telemetry.ProjectilesRejected++;
            }
        }

        /// <summary>A projectile at the server's present, your own confirmed ones `lead` further on, so the flight continues
        /// the prediction's instead of snapping back by lead × velocity.</summary>
        private void ProjectileView(string id, AuthorityEntity e, double tick)
        {
            var entry = shots.EntryFor(e);
            // Only your own projectile is drawn lead ahead: one the server re-launched (a bounce, src "") is a server
            // projectile from then on, drawn at the server's present like any other.
            var leadTicks = entry?.Local != null && e.src == room.SessionId ? entry.LeadMs * TickHz() / 1000 : 0;
            var at = GenexProjectile.At(LaunchOf(e), tick + leadTicks, TickHz());
            var v = ViewFor(id);
            v.Kind = e.kind ?? "";
            v.Owner = e.owner ?? "";
            v.IsMine = v.Owner == room.SessionId;
            v.X = at.X;
            v.Y = at.Y;
            v.Z = at.Z;
            v.VX = at.VX;
            v.VY = at.VY;
            v.VZ = at.VZ;
            v.Yaw = WrapAngle(e.yaw);
            v.Hp = e.hp;
            v.Flags = e.flags;
            v.Epoch = e.epoch;
            v.Data = e.data ?? "";
            v.ServerX = e.x;
            v.ServerY = e.y;
            v.ServerZ = e.z;
            v.ServerYaw = e.yaw;
            v.ServerEpoch = e.epoch;
            v.T0 = e.t0;
            v.G = e.g;
            v.Src = e.src ?? "";
            v.IsPredicted = false;
            v.Pitch = e.pitch;
            v.ServerPitch = e.pitch;
            v.Duck = e.duck;
            v.Mstate = e.mstate;
            v.Cap = e.cap;
            v.Spin = e.spin;
            v.Fuel = e.fuel;
        }

        /// <summary>A pending prediction as drawn at <paramref name="tick"/>.</summary>
        private void ShotView(Shot shot, double tick)
        {
            var at = GenexProjectile.At(shot.Launch, tick, TickHz());
            var v = ViewFor(shot.Id);
            v.Kind = shot.Kind;
            v.Owner = "";
            v.IsMine = false;
            v.X = at.X;
            v.Y = at.Y;
            v.Z = at.Z;
            v.VX = at.VX;
            v.VY = at.VY;
            v.VZ = at.VZ;
            v.Yaw = 0;
            v.Hp = 0;
            v.Flags = 0;
            v.Epoch = 0;
            v.Data = "";
            v.ServerX = shot.Launch.X;
            v.ServerY = shot.Launch.Y;
            v.ServerZ = shot.Launch.Z;
            v.ServerYaw = 0;
            v.ServerEpoch = 0;
            v.T0 = shot.Launch.T0;
            v.G = shot.Launch.G;
            v.Src = room.SessionId;
            v.IsPredicted = true;
            v.Pitch = 0;
            v.ServerPitch = 0;
            v.Duck = 0;
            v.Mstate = 0;
            v.Cap = 1;
            v.Spin = 0;
            v.Fuel = 0;
        }

        // ---------------- physics bodies (§17.10): drawn at the server's present, corrections eased ----------------
        // A body entity is an entity with a descriptor in RoomState.bodies. Each patch that changes one (or brings it back
        // into this client's view) hands its drawer a newer state at the patch's tick; every Frame draws it at
        // serverTick(now), extrapolated, with the decaying offset of the last correction (PhysicsDraw.cs). Interest
        // (§17.10): Colyseus deletes an entity that leaves this client's view, so an entity missing while its descriptor
        // exists is out of view and is held at its last state; an entity and descriptor deleted together are gone. A
        // descriptor whose entity never arrived draws nothing.

        /// <summary>One body as this client knows it: its entity and descriptor instances, its drawer and its last fields.</summary>
        private sealed class Body
        {
            public AuthorityEntity Entity;
            public AuthorityBody Descriptor;
            public readonly GenexBodyDrawer Drawer = new GenexBodyDrawer();
            /// <summary>§17.11 *Drawing*'s ease when the body moves between the predictor's drawing and §17.10's.</summary>
            public readonly GenexDrawHandoff Handoff = new GenexDrawHandoff();
            /// <summary>The fields last handed to the drawer (a patch that changes none of them is not a newer state).</summary>
            public double[] Last;
            /// <summary>The entity's module fields as last received, for the view while out of view.</summary>
            public string Kind = "", Owner = "", Data = "";
            public double Yaw, VX, VY, VZ, Hp, Flags, Epoch, Pitch, Duck, Mstate, Cap = 1, Spin, Fuel;
        }

        /// <summary>The room's length unit (room units per metre, §17.10): 1 in a room without physics.</summary>
        public double LengthUnit
        {
            get
            {
                var unit = room.State?.lengthUnit ?? 0;
                return unit > 0 && !double.IsInfinity(unit) ? unit : 1;
            }
        }

        private bool IsBodyEntity(string id)
        {
            var descriptors = room.State?.bodies;
            return id != null && descriptors != null && descriptors.ContainsKey(id);
        }

        /// <summary>A body out of view this client still draws (its descriptor lasts and it was received once).</summary>
        private bool HeldBody(string id) => bodies.TryGetValue(id, out var body) && body.Drawer.HasState && IsBodyEntity(id);

        private static double[] BodyFields(AuthorityEntity e) => new[]
        {
            e.x, e.y, e.z, e.qx, e.qy, e.qz, e.qw, e.lvx, e.lvy, e.lvz, e.avx, e.avy, e.avz, e.sleep ? 1 : 0, e.epoch,
        };

        private static bool SameFields(double[] a, double[] b)
        {
            if (a == null || b == null || a.Length != b.Length) return false;
            for (var i = 0; i < a.Length; i++) if (!a[i].Equals(b[i])) return false;
            return true;
        }

        /// <summary>The room tick now on the room clock, or NaN before its first sample (a state is then drawn as it came).</summary>
        private double BodyTick() => room.Clock.LastServerTime() > 0 ? NowTick() : double.NaN;

        /// <summary>Once per decoded patch: every body whose entity this patch changed, or brought back into view.</summary>
        private void NoteBodies()
        {
            var state = room.State;
            var descriptors = state?.bodies;
            var map = state?.entities;
            goneBodies.Clear();
            foreach (var kv in bodies) if (descriptors == null || !descriptors.ContainsKey(kv.Key)) goneBodies.Add(kv.Key);
            foreach (var id in goneBodies) bodies.Remove(id);
            if (descriptors == null || map == null) return;
            var at = GenexTime.Now() - FrameLag();
            var tick = BodyTick();
            var tickHz = TickHz();
            var unit = LengthUnit;
            foreach (var kv in descriptors)
            {
                if (kv.Value == null || !map.TryGetValue(kv.Key, out var e) || e == null) continue;
                if (!bodies.TryGetValue(kv.Key, out var body))
                {
                    body = new Body();
                    bodies[kv.Key] = body;
                }
                var fields = BodyFields(e);
                var newer = body.Entity != e || body.Descriptor != kv.Value || !SameFields(body.Last, fields);
                body.Entity = e;
                body.Descriptor = kv.Value;
                KeepModuleFields(body, e);
                if (!newer) continue;
                body.Last = fields;
                var snapsBefore = body.Drawer.Snaps;
                body.Drawer.Receive(StateOf(e, state.tick), kv.Value, at, tick, tickHz, unit);
                telemetry.BodyStates++;
                if (body.Drawer.Snaps > snapsBefore) telemetry.BodySnaps++;
                else if (body.Drawer.LastCorrection > telemetry.PeakBodyCorrection) telemetry.PeakBodyCorrection = body.Drawer.LastCorrection;
            }
        }

        /// <summary>A body entity's decoded state (the SDK has already dequantized q, lv and av; q is normalized here).</summary>
        private static GenexBodyState StateOf(AuthorityEntity e, double tick) => new GenexBodyState
        {
            Tick = tick,
            X = e.x, Y = e.y, Z = e.z,
            Q = new GenexQuat(e.qx, e.qy, e.qz, e.qw).Normalized(),
            Lvx = e.lvx, Lvy = e.lvy, Lvz = e.lvz,
            Avx = e.avx, Avy = e.avy, Avz = e.avz,
            Sleep = e.sleep,
            Epoch = e.epoch,
        };

        private static void KeepModuleFields(Body body, AuthorityEntity e)
        {
            body.Kind = e.kind ?? "";
            body.Owner = e.owner ?? "";
            body.Data = e.data ?? "";
            body.Yaw = e.yaw;
            body.VX = e.vx;
            body.VY = e.vy;
            body.VZ = e.vz;
            body.Hp = e.hp;
            body.Flags = e.flags;
            body.Epoch = e.epoch;
            body.Pitch = e.pitch;
            body.Duck = e.duck;
            body.Mstate = e.mstate;
            body.Cap = e.cap;
            body.Spin = e.spin;
            body.Fuel = e.fuel;
        }

        /// <summary>A body as drawn now: its pose from the drawer, everything else as the module last wrote it.</summary>
        private void BodyView(string id, Body body, bool inView)
        {
            var at = GenexTime.Now() - FrameLag();
            // A body the client world predicts is drawn from it at your present (§17.11 *Drawing*), else §17.10's way; a body the
            // room's kinematic rule poses is drawn by the rule even when the predictor does not draw it (§17.11 *Kinematic
            // rules*: §17.10's extrapolation would carry it past its stops). Moving between the two drawings eases from where
            // the body was drawn (GenexDrawHandoff), never across an epoch.
            var now = ServerNowDrawn();
            var predicted = physicsPrediction.Draw(id, now, out var pose);
            var ruled = !predicted && GenexPhysicsPredictor.RuledPoseAt(options.KinematicRule, id, now, TickHz(), TickOrigin(), out pose);
            if (!predicted && !ruled) pose = body.Drawer.Draw(at, BodyTick(), TickHz(), LengthUnit);
            var s = body.Drawer.State;
            var d = body.Descriptor;
            pose = body.Handoff.Draw(pose, predicted, s.Epoch, now, GenexPhysicsKeyframe.SnapMetresOf(d?.kind), LengthUnit);
            var v = ViewFor(id);
            v.Kind = body.Kind;
            v.Owner = body.Owner;
            v.IsMine = v.Owner == room.SessionId;
            v.X = pose.X;
            v.Y = pose.Y;
            v.Z = pose.Z;
            v.Qx = pose.Q.X;
            v.Qy = pose.Q.Y;
            v.Qz = pose.Q.Z;
            v.Qw = pose.Q.W;
            v.Lvx = s.Lvx;
            v.Lvy = s.Lvy;
            v.Lvz = s.Lvz;
            v.Avx = s.Avx;
            v.Avy = s.Avy;
            v.Avz = s.Avz;
            v.Sleep = s.Sleep;
            v.IsBody = true;
            v.InView = inView;
            v.BodyType = d?.type ?? "";
            v.BodyKind = d?.kind ?? "";
            v.Colliders = d?.colliders ?? "";
            v.BodyOffset = body.Drawer.Offset(at);
            // The module's own fields; a body's vx vy vz and yaw are the module's, never its motion (§17.10 State).
            v.Yaw = WrapAngle(body.Yaw);
            v.VX = body.VX;
            v.VY = body.VY;
            v.VZ = body.VZ;
            v.Hp = body.Hp;
            v.Flags = body.Flags;
            v.Data = body.Data;
            v.Epoch = body.Epoch;
            v.ServerX = s.X;
            v.ServerY = s.Y;
            v.ServerZ = s.Z;
            v.ServerYaw = body.Yaw;
            v.ServerEpoch = body.Epoch;
            v.T0 = 0;
            v.G = 0;
            v.Src = "";
            v.IsPredicted = predicted;
            v.Pitch = body.Pitch;
            v.ServerPitch = body.Pitch;
            v.Duck = body.Duck;
            v.Mstate = body.Mstate;
            v.Cap = body.Cap;
            v.Spin = body.Spin;
            v.Fuel = body.Fuel;
        }

        /// <summary>
        /// Hands the SDK the physicsHash (16 hex digits) of the physics world your client runs a copy of (§17.10). When the
        /// room runs physics with another hash, <see cref="Physics"/> reports <c>physics_mismatch</c>; in this release no SDK
        /// steps bodies, so the report is the whole effect. Returns the hash.
        /// </summary>
        public string SetPhysics(string hash)
        {
            physicsHash = hash ?? throw new ArgumentNullException(nameof(hash));
            return physicsHash;
        }

        /// <summary>Physics prediction (§17.11): whether this client predicts the room's bodies, and how its keyframes went.</summary>
        public GenexPhysicsPredictionStatus PhysicsPrediction => physicsPrediction.Status.Copy();

        /// <summary>Your own predicted position and velocity now (your preset body in the client world), or null.</summary>
        private GenexOwnState OwnPosition()
        {
            var state = own?.Reconciler?.State;
            return state == null ? null : new GenexOwnState(state.x, state.y, state.z, state.vx, state.vy, state.vz);
        }

        /// <summary>§17.11 <c>inputDecay</c>: a remote seat steps by the room's own movement preset (null: extrapolated).</summary>
        private GenexRemoteStep RemoteStep()
        {
            var prediction = GenexPresets.PredictionFor(room.State?.preset, world);
            var step = prediction?.Step;
            if (step == null) return null;
            var body = new GenexPredictedBody();
            var input = new GenexInput();
            return (fields, remote, dt) =>
            {
                double F(string name, double fallback = 0) => fields.TryGetValue(name, out var v) ? v : fallback;
                body.X = F("x");
                body.Y = F("y");
                body.Z = F("z");
                body.VX = F("vx");
                body.VY = F("vy");
                body.VZ = F("vz");
                body.Yaw = F("yaw");
                body.Pitch = F("pitch");
                body.Duck = F("duck");
                body.Mstate = F("mstate");
                body.Cap = F("cap", 1);
                body.Spin = F("spin");
                body.Fuel = F("fuel");
                GenexInput.SanitizeInto(remote.MoveX, remote.MoveY, remote.MoveZ, remote.Yaw, remote.Pitch, remote.Buttons, input);
                step(body, input, dt);
                fields["x"] = body.X;
                fields["y"] = body.Y;
                fields["z"] = body.Z;
                fields["vx"] = body.VX;
                fields["vy"] = body.VY;
                fields["vz"] = body.VZ;
                fields["yaw"] = body.Yaw;
                fields["pitch"] = body.Pitch;
                fields["duck"] = body.Duck;
                fields["mstate"] = body.Mstate;
                fields["spin"] = body.Spin;
                fields["fuel"] = body.Fuel;
            };
        }

        /// <summary>Whether your physics copy matches the room's (§17.10 <i>The resolved config</i>).</summary>
        public GenexPhysicsStatus Physics
        {
            get
            {
                var roomPhysics = room.State?.physics ?? "";
                var mismatch = roomPhysics != "" && roomPhysics != physicsHash;
                var pair = roomPhysics + "/" + physicsHash;
                if (mismatch && warnedPhysics != pair)
                {
                    warnedPhysics = pair;
                    ColyseusContext.Logger.LogWarning(
                        $"[genex] the room's physics world (hash {roomPhysics}) is not this client's (hash {(physicsHash == "" ? "none" : physicsHash)}): " +
                        "your copy is never stepped from the room's state. Pass your world's physicsHash to SetPhysics().");
                }
                return new GenexPhysicsStatus { Reason = mismatch ? "physics_mismatch" : "", Physics = physicsHash, RoomPhysics = roomPhysics };
            }
        }

        // ---------------- lifecycle (§8 order: state first, then re-seed, then Reconnected) ----------------

        private void OnStateChange(AuthorityRoomState state, bool isFirstState)
        {
            if (state == null) return;
            callbackDepth++;
            try
            {
                StateChanged(isFirstState);
            }
            finally
            {
                callbackDepth--;
            }
        }

        private void StateChanged(bool isFirstState)
        {
            if (decodingArrived) drainStates++;
            projectileTtl.NoteState(GenexTime.Now());
            NoteBodies();
            physicsPrediction.OnState(ServerNowArrived());
            NotePatches();
            SampleTicks();
            if (resyncFirstState) DropEarlierSockets();
            SettleShots();
            fast.StateArrived();
            if (firstState.TrySetResult(true))
            {
                warmDeadline = GenexTime.Now() + ClockWarmupTimeoutMs;
                RefreshViews();
            }
            if (isFirstState && awaitingResync) FinishResync();
        }

        private void OnDrop(int code)
        {
            if (ended) return;
            fast.Dropped();
            connected = false;
            awaitingResync = false; // a drop during the post-reconnect sequence abandons it (§8)
            resyncFirstState = true;
            watchdog.Reset();
            var r = room.Reconnection;
            if (r.IsReconnecting && r.RetryCount >= r.MaxRetries) return; // the SDK gives up next (4003)
            Reconnecting?.Invoke(++reconnectAttempt, code);
        }

        private void OnReconnect()
        {
            if (ended)
            {
                // Leave() ran while the socket was down, where the consented leave could not reach the server:
                // leave now, or the seat stays taken (and metered) with nobody behind it.
                _ = room.Leave(true);
                return;
            }
            awaitingResync = true;
            resyncDeadline = GenexTime.Now() + P.Reconnection.FirstStateTimeoutMs;
        }

        private void FinishResync()
        {
            awaitingResync = false;
            if (ended) return;
            // Normally done at the first state's decode; here too when that state never came (the deadline).
            if (resyncFirstState) DropEarlierSockets();
            // The server allocated a fresh input buffer: nothing in flight before the drop will be acked. The
            // SDK's handle reset already bumped its epoch; re-seed explicitly as the TS session does, and drop
            // the pacing baseline. A re-decoded entity is found again by TrackOwn.
            if (own?.Reconciler != null)
            {
                own.Reconciler.Reset();
                telemetry.Reseeds++;
            }
            entitiesChanged = true;
            paceFrom = double.NaN;
            reconnectAttempt = 0;
            connected = true;
            Reconnected?.Invoke();
        }

        private void OnLeave(int code)
        {
            if (ended) return;
            End();
            firstState.TrySetException(new GenexJoinException(code, "room closed before its first state"));
            Disconnected?.Invoke(code);
        }

        private void End()
        {
            physicsPrediction.Dispose();
            fast.Dispose();
            ended = true;
            connected = false;
            awaitingResync = false;
            DisposeOwn();
            unsettled.Clear();
            predict.Dispose();
        }

        /// <summary>Leave on purpose. Never reconnects; raises no <see cref="Disconnected"/>.</summary>
        public Task Leave()
        {
            if (ended) return Task.CompletedTask;
            End();
            // Mid-reconnect the leave cannot reach the server: stop further retries. One already in flight may
            // still land, and OnReconnect leaves at once.
            room.Reconnection.Enabled = false;
            return room.Leave(true);
        }
    }

    /// <summary>Timer-free waits: WebGL has no thread-pool timers, so a wait on the main thread yields frame by frame.</summary>
    internal static class GenexTime
    {
        public static double Now() => GenexSession.Now();

        public static async Task Delay(double ms)
        {
            if (SynchronizationContext.Current == null)
            {
                await Task.Delay(TimeSpan.FromMilliseconds(Math.Max(0, ms)));
                return;
            }
            var until = Now() + ms;
            while (Now() < until) await Task.Yield();
        }
    }
}
