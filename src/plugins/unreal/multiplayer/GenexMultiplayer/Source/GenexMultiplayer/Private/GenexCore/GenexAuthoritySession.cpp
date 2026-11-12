// Source of truth: sdks/godot/addons/genex_multiplayer/authority_native.gd (the same C predict API
// through the GDExtension), cross-checked with sdks/unity/Runtime/Core/Authority/GenexAuthoritySession.cs
// and packages/multiplayer/src/authority/session.ts. See GenexAuthoritySession.h. Every place where the
// three disagree names the one followed and why.
#include "GenexCore/GenexAuthoritySession.h"

#include "GenexCore/AuthoritySchema.h"
#include "GenexCore/GenexAuthorityRejoin.h"
#include "GenexCore/GenexClock.h"
#include "GenexCore/GenexColyseus.h"
#include "GenexCore/GenexContactSession.h"
#include "GenexCore/GenexFastLine.h"
#include "GenexCore/GenexFastSeat.h"
#include "GenexCore/GenexInputRepeat.h"
#include "GenexCore/GenexLog.h"
#include "GenexCore/GenexMsgpack.h"
#include "GenexCore/GenexNoDelay.h"
#include "GenexCore/GenexOwnPredict.h"
#include "GenexCore/GenexProtocol.h"
#include "GenexCore/GenexTickDrawing.h"
#include "GenexCore/GenexUrl.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <deque>
#include <limits>
#include <unordered_set>
#include <utility>

namespace genex::authority_session_detail {

namespace aw = ::genex::authority_wire;
namespace rc = ::genex::protocol::reconnection;
namespace je = ::genex::protocol::join_error;
namespace cc = ::genex::protocol::close_code;

/** A reconcile that moves the own entity more than this (world units) counts as a visible correction. */
constexpr double kVisibleCorrectionMetres = 0.05;
/** Without a reconciler the session paces inputs itself; a stalled frame catches up at most this many. */
constexpr int kMaxCatchUpSteps = 8;
/** A shove's ease (ShoveRepredict) is done once what is left of it is under this, world units (session.ts). */
constexpr double kShoveEaseDone = 0.01;
/** The most a frame's work (the pump's poll: decodes, keyframe replays; Frame's reconcile) is taken to have moved the clock
 *  past the frame's instant, ms; past it (or below 0) the instant is another clock's, and nothing is taken off. */
constexpr double kMaxFrameLagMs = 250.0;
/** Adoption time between two frames past which a keyframe waits for the next frame, the newest of the rest
 *  adopted then (§17.11 *A burst of keyframes*): one 60 Hz frame, ms (TypeScript ADOPT_FRAME_BUDGET_MS). */
constexpr double kAdoptFrameBudgetMs = 1000.0 / 60.0;
/** The most a keyframe decoded in a frame's poll is taken to have arrived before the frame's instant, ms (half a 20 fps
 *  frame), as the Unity session's MaxArrivalLagMs. */
constexpr double kMaxArrivalLagMs = 25.0;
/** The spawn store's own TTL, ms: never (the session keeps §17.9's, which waits out a stall: ExpireShots). */
constexpr double kShotStoreNeverMs = 1.0e12;
/** How long past its scheduled start a reconnect attempt may stall before it is dropped (Godot
 *  HANDSHAKE_STALL_MS: the C core's handshake stall, see UnstickReconnect). */
constexpr double kHandshakeStallMs = 1000.0;
/** The longest the views wait for the room clock's first round trip (see BecameReady). */
constexpr double kClockWarmupTimeoutMs = 2000.0;
/** After an own respawn the predicted state is drawn for this many patch intervals (the reconciler's
 *  correction offset for the jump has then decayed to e^-8 of it); the fallback tau without a patch rate. */
constexpr double kRespawnSnapTaus = 8.0;
constexpr double kRespawnSnapFallbackTauMs = 50.0;
/** How much of an entity's patch record is kept: render delay plus half the worst round trip, with room. */
constexpr double kRemoteHistoryMs = 1000.0;
/** A patch stamped this far before the newest noted one restarts the record (a clock axis change). */
constexpr double kHistoryBackJumpMs = 500.0;
/** Session events the session raises itself: a module event of the same name is not delivered. */
constexpr const char* kSessionEvents[] = {"reconnecting", "reconnected", "disconnect", "draining", "rejoining", "rejoined"};
constexpr double kJsPi = 3.141592653589793;
constexpr double kTwoPi = 2.0 * kJsPi;
/** The close code TestDrop and the stall drop close with (Godot's test_drop: 4010). Reconnectable, so the
 *  core reconnects; and a valid close-frame code (1006 may not be sent: ws refuses the frame). */
constexpr int kDropClose = cc::kMayTryReconnect;
/** How long a room a regroup moved out of may take to confirm its leave before it is freed anyway (§17.1
 *  *Regrouping*): a consented leave lets the server drop the seat at once, where a closed socket keeps it for the
 *  reconnect grace. */
constexpr double kRegroupLeaveSettleMs = 5000.0;

double NaN() { return std::numeric_limits<double>::quiet_NaN(); }

/** The shadow input handle's transport (§17.11 *Input pacing*): it is never sent anywhere, and always
 *  open, so every input mirrored onto it is recorded in its replay ring. */
void ShadowSend(const std::uint8_t* /*data*/, std::size_t /*length*/, void* /*userdata*/) {}
bool ShadowOpen(void* /*userdata*/) { return true; }

std::string Str(const char* p) { return p == nullptr ? std::string() : std::string(p); }

double ShortArc(double from, double to) { return std::atan2(std::sin(to - from), std::cos(to - from)); }

double Clamp01(double v) { return v < 0.0 ? 0.0 : v > 1.0 ? 1.0 : v; }

/** An input's tick field as a fast-channel slot carries it (§17.12: modulo 65536; not a tick, 0). */
double InputTickField(double tick) { return std::isfinite(tick) && tick >= 0.0 ? std::fmod(std::floor(tick), 65536.0) : 0.0; }

enum class RawKind { JoinError, Joined, State, Message, Drop, Reconnect, Leave, RoomError, Latency, Probe };

struct Raw {
  RawKind kind = RawKind::Joined;
  std::uint32_t gen = 0;
  colyseus_room_t* room = nullptr;
  int code = 0;
  std::string text;
  bool hasText = false;
  /** A probe sample's latency, ms (RawKind::Probe). */
  double number = 0.0;
  Json data;
};

struct Impl;

/** Userdata of one join attempt (and of the room it produced) or of one latency race. */
struct Ctx {
  Impl* impl = nullptr;
  std::uint32_t gen = 0;
  /** The room this join attempt produced (null before it arrives). */
  colyseus_room_t* room = nullptr;
  /** A request is out whose callback has not arrived: never freed while true. */
  bool inFlight = true;
};

struct Respawn {
  double at = 0.0;
  double epoch = 0.0;
  std::vector<AuthorityPose> history;
};

/** Every entity's noted patches (session.ts notePatch; Godot _remotes; Unity Remote). */
struct Remote {
  colyseus_schema_t* entity = nullptr;
  int refId = 0;
  double epoch = 0.0;
  std::vector<AuthorityPose> history;
  std::vector<Respawn> respawns;
};

struct Spring {
  AuthorityPose pose;
  double epoch = 0.0;
  double at = 0.0;
};

/** A projectile this seat predicted (PredictProjectile): its id and kind, its launch (`t0` the fractional
 *  tick it was fired at), the server-clock instant it was fired (`at`), and the input that fires it: its
 *  sequence on the input handle, under the handle's epoch. The spawn store's local (session.ts Shot). */
struct Shot {
  std::string id;
  std::string kind;
  ProjectileLaunch launch;
  double at = 0.0;
  int seq = 0;
  int epoch = 0;
  /** Its entry in the spawn store. */
  int spawnId = 0;
  /** When it was made, on the room clock's `now` (its age against ProjectileTtl). */
  double madeAt = 0.0;
};

/** One physics body as this client draws it (§17.10): its descriptor, the entity instance and fields it
 *  was last read from, and its drawing (latest state, offset). Kept while its descriptor exists, so a
 *  body whose entity left this client's view is held at its last state. */
struct BodyTrack {
  colyseus_schema_t* descriptor = nullptr;
  int descriptorRef = 0;
  std::string type;
  std::string kind;
  std::string colliders;
  /** The next state is the body's first since it got this descriptor (a snap). */
  bool spawnPending = true;
  bool hasFields = false;
  /** §17.11 *Drawing*'s ease when the body moves between the predictor's drawing and §17.10's. */
  physics::DrawHandoff handoff;
  bodies::BodyFields fields;
  bodies::BodyDrawer drawer;
};

/** The body fields of an entity as decoded (the quantized ones already dequantized by the decoder). */
bodies::BodyFields BodyFieldsOf(const aw::AuthorityEntity& e) {
  bodies::BodyFields f;
  f.x = static_cast<double>(e.x);
  f.y = static_cast<double>(e.y);
  f.z = static_cast<double>(e.z);
  f.qx = e.qx;
  f.qy = e.qy;
  f.qz = e.qz;
  f.qw = e.qw;
  f.lvx = e.lvx;
  f.lvy = e.lvy;
  f.lvz = e.lvz;
  f.avx = e.avx;
  f.avy = e.avy;
  f.avz = e.avz;
  f.sleep = e.sleep;
  f.epoch = e.epoch;
  return f;
}

/** Whether two decoded body states are the same, field for field (a patch that changed none of them
 *  carried no newer state). */
bool SameBodyFields(const bodies::BodyFields& a, const bodies::BodyFields& b) {
  return a.x == b.x && a.y == b.y && a.z == b.z && a.qx == b.qx && a.qy == b.qy && a.qz == b.qz && a.qw == b.qw &&
         a.lvx == b.lvx && a.lvy == b.lvy && a.lvz == b.lvz && a.avx == b.avx && a.avy == b.avy && a.avz == b.avz &&
         a.sleep == b.sleep && a.epoch == b.epoch;
}

/** Whether an entity is a projectile (§17.9 `t0 > 0`). */
bool IsProjectile(const aw::AuthorityEntity& e) { return e.t0 > 0.0; }

/** The entity this seat owns, predicted. */
struct Own {
  std::string id;
  aw::AuthorityEntity* entity = nullptr;
  int refId = 0;
  /** The server's life; drawnEpoch is the one drawn (it changes at the snap). */
  double epoch = 0.0;
  double drawnEpoch = 0.0;
  /** An epoch bump arrived and the reconcile that adopts the new life has not yet. */
  bool respawning = false;
  /** Until then (Clock ms) the entity is drawn by SnapPose; snapPrev/snapCur are its last two steps. */
  double snapUntil = -std::numeric_limits<double>::infinity();
  std::vector<double> snapPrev;
  std::vector<double> snapCur;
  double snapAt = 0.0;
  colyseus_reconciler_t* reconciler = nullptr;
  /** Re-seeded (a new prediction, its in-flight inputs replayed onto the mirror) and not stepped live
   *  since: drawn from the mirror as is, since the reconciler's render still eases from the server's
   *  pose until its first live step (session.ts `reseeded`). */
  bool reseeded = false;
  /** Your drawn pose less your re-predicted one when a missed contact re-predicted it (ShoveRepredict), and
   *  when (Clock ms): eased out over kSeatTauMs (session.ts shoveEase). */
  bool shoveEasing = false;
  double shoveDx = 0.0;
  double shoveDy = 0.0;
  double shoveDz = 0.0;
  double shoveAt = 0.0;
  Prediction prediction;
  std::vector<std::string> fields;
  std::vector<double> before;
  std::vector<double> after;
  /** Your own heading as drawn, kept as an angle (YawRender): the C reconciler renders every field as a
   *  plain number, `prev + (cur + err − prev) · α`, which across the ±π seam of a heading that wraps (a
   *  vehicle's, a turning player's) sweeps the long way round for one step and decays a seam-crossing
   *  correction of ~2π through every heading. This replays that render (reconciler.c: snapshot_prev at
   *  each live step, the render clock `acc`, the error rebased at a reconcile and decayed by
   *  1 − e^(−dt/smooth)) with the differences taken along the short arc (session.ts ownYaw and
   *  foldYawCorrection). */
  bool yawMirrored = false;
  double yawPrev = 0.0;
  double yawErr = 0.0;
  double yawAcc = 0.0;
  double yawSmoothMs = 50.0;
  double yawLastTick = NaN();
  int yawHandleEpoch = 0;
};

aw::AuthorityRoomState* StateOf(colyseus_room_t* room) {
  return room == nullptr ? nullptr : static_cast<aw::AuthorityRoomState*>(colyseus_room_get_state(room));
}

/** Visit every (key, value) of a decoded map. */
template <typename Fn>
void ForEach(colyseus_map_schema_t* map, Fn fn) {
  if (map == nullptr) return;
  colyseus_map_schema_foreach(
      map, [](const char* key, void* value, void* userdata) { (*static_cast<Fn*>(userdata))(Str(key), value); }, &fn);
}

AuthorityPose PoseOf(const aw::AuthorityEntity& e, double t) {
  AuthorityPose p;
  p.t = t;
  p.x = static_cast<double>(e.x);
  p.y = static_cast<double>(e.y);
  p.z = static_cast<double>(e.z);
  p.yaw = static_cast<double>(e.yaw);
  p.pitch = static_cast<double>(e.pitch);
  p.duck = static_cast<double>(e.duck);
  return p;
}

double FieldOf(const aw::AuthorityEntity& e, const std::string& field) { return AuthorityEntityField(e, field); }

/** Writes a mirrored field by its schema name (FieldOf's inverse; any other name is ignored). */
void SetEntityField(aw::AuthorityEntity& e, const std::string& field, double value) { SetAuthorityEntityField(e, field, value); }

/** Mirrored fields that are not a place: a change in them is never a correction (session.ts NOT_A_PLACE;
 *  a yaw rate that was off shows as the heading it turned to, which is counted). */
bool NotAPlace(const std::string& field) { return field == "mstate" || field == "cap" || field == "spin" || field == "fuel"; }

/** Mirrored fields that are headings: a correction or an ease across ±π takes the short arc. A pitch is
 *  a bounded angle (±pitchLimit): straight (AuthorityIsHeading). */
bool IsAngle(const std::string& field) { return AuthorityIsHeading(field); }

void SetPoseField(AuthorityPose& pose, const std::string& field, double value) {
  if (field == "x") pose.x = value;
  else if (field == "y") pose.y = value;
  else if (field == "z") pose.z = value;
  else if (field == "yaw") pose.yaw = value;
  else if (field == "pitch") pose.pitch = value;
  else if (field == "duck") pose.duck = value;
}

void CbRoom(colyseus_room_t* room, void* ud);
void CbJoinError(int code, const char* message, void* ud);
void CbJoin(void* ud);
void CbState(void* ud);
void CbMessage(const char* type, const std::uint8_t* data, std::size_t length, void* ud);
void CbDrop(int code, const char* reason, void* ud);
void CbReconnect(void* ud);
void CbLeave(int code, const char* reason, void* ud);
void CbRoomError(int code, const char* message, void* ud);
void CbLatency(const char* best, double latencyMs, void* ud);
void CbProbe(const char* best, double latencyMs, void* ud);

/** What a pool join's probe found, kept for §17.1 *Regrouping*: the regions, each url's best sample and the join's
 *  region settings, from which the regions listed before the seat's own are asked (regions::PlanRegroup). */
struct RegroupBasis {
  std::vector<regions::Region> regions;
  std::vector<std::vector<std::optional<double>>> best;
  regions::SearchOptions options;
};

struct Impl {
  explicit Impl(AuthorityOptions o) : options(std::move(o)) {
    world = options.world != nullptr ? options.world : FirstpersonWorld::Empty();
    physicsHash = options.physics;
    // §17.11 *Seat contacts*: the room's rule (the module's, or a declared policy's) against every other seat,
    // after each of your inputs; used only while the room has seat contacts (HasContacts).
    contacts = std::make_unique<SeatContacts>([this](ContactBody& a, ContactBody& b) { ContactRuleNow(a, b); }, [this] { return OtherSeats(); });
    // `predicted` (the default): every other seat predicted on your clock (seat-predict.ts), while the room has
    // seat contacts; your contacts and the physics replay's seats come from it whatever the drawing.
    if (!options.seatDrawing || *options.seatDrawing == SeatDrawing::Predicted) seatWorld = std::make_unique<SeatWorld>(SeatWorldOptionsNow());
    if (options.fast) fastSeat = std::make_unique<fast::FastSeat>(FastSeatHostNow());
  }

  // ---------------- the fast channel (§17.12, GenexFastSeat.h) ----------------

  /** The fast seat's view of this session. */
  fast::FastSeatHost FastSeatHostNow() {
    fast::FastSeatHost h;
    h.open = options.fast;
    h.now = options.fastClock ? options.fastClock : std::function<double()>([] { return Clock::NowMs(); });
    h.tickHz = [this] { return TickHz(); };
    h.sentCount = [this] { return handle != nullptr ? colyseus_input_handle_sent_count(handle) : 0; };
    h.lastProcessed = [this] { return handle != nullptr ? colyseus_input_handle_last_processed(handle) : 0; };
    h.seqBase = [this] { return SeqBase(); };
    h.sessionId = [this] { return sid; };
    h.stateCurrent = [this] { return joined && connected && !awaitingResync && State() != nullptr; };
    h.state = [this] { return State(); };
    h.send = [this](const char* type, const Json& payload) {
      if (room == nullptr) return;
      std::vector<std::uint8_t> bytes;
      if (EncodeMsgpack(payload, bytes)) colyseus_room_send_encoded(room, type, bytes.data(), bytes.size());
    };
    h.sample = [this](double sent, double rtt) {
      if (room == nullptr) return;
      colyseus_room_clock_sample(colyseus_room_get_clock(room), sent, rtt);
    };
    h.statePass = [this] { FastStatePass(); };
    return h;
  }

  /** What a decoded patch runs (CbState, then the queued State), for a snapshot written into the state. */
  void FastStatePass() {
    if (room == nullptr || State() == nullptr) return;
    NotePatches();
    NoteBodies();
    NotePhysicsKeyframe();
    SampleTicks();
    projectileTtl.NoteState(colyseus_room_clock_now(colyseus_room_get_clock(room)));
    SettleShots();
    RefreshPlayers();
  }

  /** Your inputs' ack, handle-counted: the fast channel's while it is live (GenexFastSeat.h), else the
   *  server's WebSocket ack. */
  int OwnAck() const {
    if (handle == nullptr) return 0;
    return fastSeat != nullptr ? fastSeat->Ack() : colyseus_input_handle_last_processed(handle);
  }

  /** Before the C core's poll: the held fields show the WebSocket's values to its decoder. */
  void BeforePoll() {
    if (fastSeat != nullptr && fastSeat->Guard().HeldRefs() > 0) fastSeat->Guard().Expose(State());
  }

  /** After a decode (and after the poll): the channel's values go back over the WebSocket's. */
  void CoverFast() {
    if (fastSeat != nullptr) fastSeat->Guard().Cover(State(), fastSeat->Client());
  }

  AuthorityOptions options;
  double renderDelay = protocol::authority_timing::kRenderDelayMs;
  std::shared_ptr<int> alive = std::make_shared<int>(0);

  colyseus_settings_t* settings = nullptr;
  colyseus_client_t* client = nullptr;
  std::uint16_t port = 0;
  std::string url;
  std::uint32_t gen = 0;
  std::vector<std::unique_ptr<Ctx>> ctxs;
  colyseus_room_t* room = nullptr;
  /** Rooms asked to leave, waiting for their on_leave; then freed from the graveyard. */
  std::vector<colyseus_room_t*> leavingRooms;
  /** Rooms freed at the start of the next Update, never inside their own callback. */
  std::vector<colyseus_room_t*> graveyard;
  std::deque<Raw> raw;
  std::vector<AuthorityEvent> events;

  std::string sid;
  std::string roomId;
  std::string preset;
  AuthorityStatus status = AuthorityStatus::Joining;
  bool joined = false;  // the first state arrived
  bool ready = false;   // ...and the room clock has its first round trip
  double readyDeadline = 0.0;
  bool closed = false;
  bool leaving = false;
  bool connected = false;  // false from a drop until the reconnect's first state
  /** Where a join stands in its capacity walk over `targets` (§17.1 *Regions*). */
  regions::CapacityState capacity;
  double retryAt = -1.0;
  bool selecting = false;
  /** The servers a join tries, nearest region first (empty: the one url picked without regions). */
  std::vector<std::string> targets;
  /** §17.1 *Finding players*: the servers a pool join asks for a room that already exists, nearest first, before it
   *  tries `targets`, and the one being asked; the search runs while searchAt < search.size(). */
  std::vector<std::string> search;
  std::size_t searchAt = 0;
  /** §17.1 *Regrouping*: set by a pool join's probe when the join may regroup, until the session takes it
   *  (AuthoritySession::DriveRegroup). */
  std::optional<RegroupBasis> regroupBasis;
  /** A regroup's ask: Colyseus's plain join (a room that already exists), never a create. */
  bool joinOnly = false;
  /** A region picker's probe (AuthorityRegionMeter): the probe's answer goes to `measured`, and nothing is joined. */
  bool measureOnly = false;
  std::optional<std::vector<regions::RegionPing>> measured;
  /** The region probe in flight (§17.1 *Regions*), until the choice is made. */
  struct RegionProbe {
    std::vector<regions::Region> regions;
    std::vector<std::vector<std::optional<double>>> best;
    std::size_t pending = 0;
    /** Set on the first Update after the probe starts (the session's clock): the latest the choice is made. */
    double ceiling = -1.0;
    double grace = -1.0;
  };
  std::optional<RegionProbe> probe;
  /** Clients of regions a capacity walk left: freed with the session. */
  std::vector<std::pair<colyseus_settings_t*, colyseus_client_t*>> oldClients;

  // §8 reconnection bookkeeping
  int attempt = 0;
  bool awaitingResync = false;
  double resyncDeadline = 0.0;
  int stallKicks = 0;
  double stallRef = 0.0;
  bool noDelayWarned = false;

  // prediction
  /** The firstperson collision world this client predicts through (SetWorld). */
  FirstpersonWorldPtr world;
  /** Why the own entity is not predicted (AuthorityPredictionStatus.reason) while it is not. */
  std::string blocked = "no_entity";
  /** The (room world, client world) pair last warned about, so a mismatch is explained once. */
  std::string warnedMismatch;
  /** The pitch limit drawn pitches are held to, cached per preset text (it never changes in a room). */
  std::string pitchLimitText;
  double pitchLimitValue = kJsPi;
  colyseus_input_handle_t* handle = nullptr;
  /** §17.11 *Input pacing*: the input handle your reconciler reads, a local copy of `handle`'s inputs
   *  (never sent) whose ack is the input your entity in the state was stepped through (SteppedAck), and
   *  the epoch of `handle` it last followed. The stock reconciler polls its handle's ack itself, and
   *  only the room sets the real one. */
  colyseus_input_handle_t* shadow = nullptr;
  int shadowEpoch = -1;
  /** §17.11 *The reconciler's ack*: what the shadow was last acknowledged up to, and since when held back. */
  input_repeat::ReconcilerAckHold ackHold;
  /** Every input `handle` sent after your inputs' ack (OwnAck), in sequence order, and the epoch of `handle` they
   *  were sent on: a replay's last copy (ReplayInput). The state is stepped at least through the ack, which never
   *  moves back on one socket, so no replay needs an input this has let go of. */
  std::deque<std::pair<int, aw::AuthorityInput>> sentSinceAck;
  int sentSinceAckEpoch = -1;
  /** The upstream throttle (§17.11 *Input pacing*) and the frame instant it last paid at. */
  input_repeat::InputThrottle throttle;
  /** The room's input repeat setting (§17.11 *Input pacing*), cached per preset text (RoomRepeat). */
  mutable std::string repeatText = std::string(1, '\0');
  mutable input_repeat::InputRepeat repeatNow = input_repeat::InputRepeat::On;
  double throttleAt = NaN();
  colyseus_predict_t* predict = nullptr;
  std::optional<Own> own;
  std::map<std::string, Remote> remotes;
  std::map<std::string, Spring> springs;
  double paceFrom = NaN();
  AuthorityTelemetry telemetry;
  /** The fast channel's seat, when the game gave a socket opener. */
  std::unique_ptr<fast::FastSeat> fastSeat;
  /** The transport line's state (GenexFastLine.h): its announcer, the newest line, this socket's first state
   *  and the session's snapshots before this socket. */
  fast::FastLineAnnouncer fastLine;
  std::string transportLine;
  std::optional<double> fastJoinedAt;
  int fastSnapshotsBefore = 0;
  int fastReturnsSaid = 0;

  /** Says the transport line this instant owes. */
  void AnnounceTransport(double now) {
    if (!fastJoinedAt && connected && !awaitingResync) fastJoinedAt = now;
    const fast::FastSeatStatus none;
    const fast::FastSeatStatus& seat = fastSeat != nullptr ? fastSeat->Status() : none;
    // A return may say every line again: this socket is back on UDP, and may fall back again.
    if (seat.returns != fastReturnsSaid) {
      fastReturnsSaid = seat.returns;
      fastLine.Reset();
    }
    fast::FastLineObservation o;
    o.asked = fastSeat != nullptr;
    if (fastJoinedAt) o.joinedMs = now - *fastJoinedAt;
    if (fastSeat != nullptr && !fastSeat->BoundUrl().empty()) o.url = fastSeat->BoundUrl();
    o.snapshots = seat.snapshots - fastSnapshotsBefore;
    if (seat.fallback) o.fallback = fast::FallbackReasonName(*seat.fallback);
    const std::optional<std::string> line = fastLine.Observe(o);
    if (!line) return;
    transportLine = *line;
    if (options.fastLog) options.fastLog(*line);
    else std::fprintf(stderr, "%s\n", line->c_str());
  }

  std::map<std::string, AuthorityEntityView> views;
  std::map<std::string, AuthorityPlayerView> playerViews;
  std::map<std::string, AuthorityRemoteProbe> probes;

  // projectiles (§17.9): the C core's predicted-spawn store, fed the `entities` collection by the
  // Predict (rebound to each new one; the store and its locals outlive a reconnect's rebuild, as the
  // TS session's do), and the predictions no server projectile has confirmed yet.
  // physics bodies (§17.10): every descriptor's drawing, by body key; the physics copy's hash.
  std::map<std::string, BodyTrack> bodyTracks;
  std::string physicsHash;
  /** The close a rejoin should come back from (§17.13), set by Terminal for the session to pick up. */
  std::optional<int> lostCode;
  std::string lostReason;
  /** The room's key, read at its first state: what a seat that joined by code knows of it (§17.13). */
  std::string seatMatchKey;
  /** This seat came by a rejoin: the game hears Rejoined, not a second Ready. */
  bool rejoinedSeat = false;
  std::string warnedPhysics;

  // physics prediction (§17.11, physics-predict-session.ts): the client world, made at the first state
  // that carries keyframes; your predicted positions by input sequence; where out-of-view bodies were.
  std::unique_ptr<physics::PhysicsPredictor> predictor;
  physics::PredictStatus predictStatus = physics::PredictStatus::Loading;
  /** physicsCoreLoader was called (once: a load that failed is `unavailable` for the session's life). */
  bool physicsLoadTried = false;
  AuthorityPhysicsPrediction predictCounts;
  bool predictSelfTested = false;
  double predictKeyframe = 0.0;
  /** A keyframe held from its arrival to the next frame: the state, your inputs sent then and the instant. */
  struct PendingKeyframe {
    physics::PredictKeyframe keyframe;
    int sent = 0;
    double now = 0.0;
  };
  /** The newest keyframe held for the next frame, if any. */
  std::optional<PendingKeyframe> pendingKeyframe;
  /** Adoption time since the last frame began, ms. */
  double adoptSpentMs = 0.0;
  int predictEpoch = -1;
  /** Your predicted position and velocity after each input sent (physics-predict-session.ts `own`),
   *  refreshed from OwnPath at every keyframe. */
  OwnRing ownRing;
  std::map<std::string, bodies::Vec3> predictLastSeen;
  /** §17.11 *Seat contacts*: the room's contact rule against the other seats (ContactRuleNow). */
  std::unique_ptr<SeatContacts> contacts;
  /** §17.11 *Contact policy*: the policy the state's preset text declares, cached per text and world (Declared). */
  mutable std::string declaredText = std::string(1, '\0');
  mutable std::uint32_t declaredWorld = 0;
  mutable std::shared_ptr<const DeclaredContacts> declaredNow;
  /** §17.11 *Drawing other seats*, `separate`: where each other seat was drawn against yours last frame,
   *  with the lives it was drawn in (a new life on either side starts afresh). */
  struct DrawnSide {
    SeatSide side;
    /** The lives it was drawn in: yours and the seat's, or the pair's two. */
    std::string lives;
  };
  std::map<std::string, DrawnSide> sides;
  /** SeatDrawing::Predicted: the seat prediction, each other seat's drawn correction and when it was last
   *  decayed, and where other seats were last drawn (the tick, and ms ahead of the server's present). */
  std::unique_ptr<SeatWorld> seatWorld;
  std::map<std::string, SeatOffset> seatOffsets;
  /** Each other seat's share of your entity's exact input (SeatTouchShare), by its key. */
  std::map<std::string, double> touchShares;
  std::optional<SeatClock> seatDrawClock;
  double seatOffsetsAt = std::numeric_limits<double>::quiet_NaN();
  double drawTick = std::numeric_limits<double>::quiet_NaN();
  double drawLead = std::numeric_limits<double>::quiet_NaN();
  /** The room preset's step for other seats, cached per preset text and world (SeatWorld calls it every tick). */
  std::string seatStepPreset = std::string(1, '\0');
  std::uint32_t seatStepWorld = 0;
  SeatStep seatStep;
  std::string seatDescText = std::string(1, '\0');
  std::optional<physics::PhysDesc> seatDesc;
  /** §17.11 *Drawing other seats*: other entities' keyframe samples on the tick timeline, by id
   *  (forgotten when the id's entity is replaced or removed), and the room's K, cached per physDesc. */
  TickDrawing ticked;
  std::string keyframeTicksText;
  int keyframeTicks = 1;

  colyseus_spawns_t* shots = nullptr;
  colyseus_room_t* shotsRoom = nullptr;
  std::vector<Shot*> unsettled;
  /** Inside Frame, and the instant of the frame last made (FrameLag, ArrivalLag). */
  bool framing = false;
  double frameAt = std::numeric_limits<double>::quiet_NaN();
  /** §17.9's TTL for them, a stalled link's silence not counted (its clock: the room clock's `now`). */
  ProjectileTtl projectileTtl;
  /** A reconnect happened and its first state is not decoded yet (set and read in the C callbacks). */
  bool resyncFirstState = false;
  /** The input being staged and the predictions made against it (session.ts `staged`). */
  int stagedEpoch = -1;
  int stagedSeq = 0;
  int stagedN = 0;

  // ---------------- connection ----------------

  void Start() {
    if (!(options.renderDelayMs >= 0.0) || !std::isfinite(options.renderDelayMs)) {
      renderDelay = protocol::authority_timing::kRenderDelayMs;
    } else {
      renderDelay = options.renderDelayMs;
    }
    if (!options.extra.IsObject()) options.extra = Json::MakeObject();
    if (options.gameId.empty()) {
      Refuse(0, "genex: AuthorityOptions.gameId is required");
      return;
    }
    if (options.url.empty()) {
      std::vector<regions::Region> regs = regions::Normalize(options.regions, options.urls);
      if (regs.size() > 1) {
        ProbeRegions(std::move(regs));
        return;
      }
      if (regs.size() == 1) {
        targets = {regs[0].urls[0]};
        UseUrl(targets[0]);
        return;
      }
    }
    const UrlPick pick = options.environmentAuthorityUrl
                             ? PickAuthorityUrl(options.url, options.urls, options.environmentAuthorityUrl)
                             : PickAuthorityUrlFromEnv(options.url, options.urls);
    switch (pick.kind) {
      case UrlPickKind::Direct:
        UseUrl(pick.url);
        return;
      case UrlPickKind::Race:
        ProbeRegions(regions::Normalize(std::vector<regions::Region>{}, pick.urls));
        return;
      case UrlPickKind::Refused:
        Refuse(0, "genex: no authority url (pass url or urls, or set GENEX_AUTHORITY_URL): " + pick.error);
        return;
    }
  }

  /** Starts the region probe (§17.1 *Regions*): every sample of every region at once, one url each, through the
   *  core's latency call over a single endpoint. The choice is made in Update (FinishProbe). */
  void ProbeRegions(std::vector<regions::Region> regs) {
    selecting = true;
    RegionProbe p;
    std::vector<std::string> calls;
    for (const regions::Region& r : regs) {
      p.best.emplace_back(r.urls.size());
      for (std::string& u : regions::ProbePlan(r.urls, regions::kProbeSamples)) calls.push_back(std::move(u));
    }
    p.regions = std::move(regs);
    p.pending = calls.size();
    probe = std::move(p);
    for (const std::string& u : calls) {
      const char* ptrs[] = {u.c_str()};
      colyseus_latency_options_t lo{};
      lo.ping_count = 1;
      lo.timeout_ms = regions::kProbeTimeoutMs;
      lo.use_secure = u.rfind("wss", 0) == 0;
      lo.tls_skip_verification = false;
      lo.ca_pem_data = nullptr;
      lo.ca_pem_len = 0;
      colyseus_select_by_latency(ptrs, 1, &lo, CbProbe, NewCtx());
    }
  }

  /** A probe sample arrived (or failed): recorded against every region url it names. */
  void ProbeAnswered(const Raw& item, double now) {
    if (!probe) return;
    if (probe->pending > 0) probe->pending -= 1;
    if (!item.hasText || !std::isfinite(item.number) || item.number < 0.0) return;
    for (std::size_t i = 0; i < probe->regions.size(); ++i) {
      for (std::size_t j = 0; j < probe->regions[i].urls.size(); ++j) {
        if (probe->regions[i].urls[j] != item.text) continue;
        std::optional<double>& slot = probe->best[i][j];
        slot = slot ? std::min(*slot, item.number) : item.number;
      }
    }
    if (probe->grace < 0.0) probe->grace = now + regions::kProbeGraceMs;
  }

  /** Makes the region choice once every sample settled, the grace after the first answer ran out or the ceiling
   *  passed; then a pool join asks the regions in reach for players (§17.1 *Finding players*), and any other joins
   *  the nearest region. */
  void FinishProbe(double now) {
    if (!probe || closed) return;
    if (probe->ceiling < 0.0) probe->ceiling = now + regions::kProbeTimeoutMs;
    const bool due = probe->pending == 0 || now >= probe->ceiling || (probe->grace >= 0.0 && now >= probe->grace);
    if (!due) return;
    selecting = false;
    if (measureOnly) {
      measured = regions::Pings(probe->regions, probe->best);
      probe.reset();
      return;
    }
    regions::SearchPlan plan = regions::PlanSearch(probe->regions, probe->best, SearchOptionsNow());
    // §17.1 *Regrouping* uses this join's own probe: no second probe while the player plays.
    if (MayRegroup()) regroupBasis = RegroupBasis{probe->regions, probe->best, SearchOptionsNow()};
    probe.reset();
    targets.clear();
    for (regions::Pick& p : plan.create) targets.push_back(std::move(p.url));
    search.clear();
    for (regions::Pick& p : plan.search) search.push_back(std::move(p.url));
    searchAt = 0;
    UseUrl(Searching() ? search[0] : targets[0]);
  }

  /** What this join may do about regions (session.ts joinTargets): only a pool join searches, and a join by code
   *  walks every region, pinned or not. */
  regions::SearchOptions SearchOptionsNow() const {
    const room_key::JoinMethod method =
        room_key::PlanAuthorityJoin({options.matchKey, options.createPrivate, options.joinCode}).method;
    regions::SearchOptions o;
    o.rule = method == room_key::JoinMethod::JoinOrCreate ? options.regionRule : regions::RegionRule::Nearest;
    o.maxPingMs = options.maxPingMs;
    if (method != room_key::JoinMethod::JoinById) o.region = options.region;
    return o;
  }

  /** A pool join is still asking the regions in reach for a room that already exists. */
  bool Searching() const { return searchAt < search.size(); }

  /** Whether a player alone in this join's room may move (§17.1 *Regrouping*): a pool join of a game that left
   *  regrouping and rejoining on. A private room and a room joined by code are where the player asked to be. */
  bool MayRegroup() const {
    const room_key::JoinMethod method =
        room_key::PlanAuthorityJoin({options.matchKey, options.createPrivate, options.joinCode}).method;
    return options.regroup && options.rejoin && method == room_key::JoinMethod::JoinOrCreate;
  }

  /** Left and nothing of it is still out: its rooms are all freed. */
  bool Settled() const { return closed && room == nullptr && leavingRooms.empty() && graveyard.empty(); }

  Ctx* NewCtx() {
    std::unique_ptr<Ctx> ctx(new Ctx());
    ctx->impl = this;
    ctx->gen = gen;
    Ctx* raw_ = ctx.get();
    ctxs.push_back(std::move(ctx));
    return raw_;
  }

  void UseUrl(const std::string& target) {
    std::string why;
    const std::optional<ParsedUrl> parsed = ParseUrl(target, &why);
    if (!parsed || (parsed->scheme != "ws" && parsed->scheme != "wss")) {
      Refuse(0, "genex: unsupported authority URL `" + target + "` (expected ws:// or wss://)" +
                    (why.empty() ? std::string() : ": " + why));
      return;
    }
    url = target;
    port = static_cast<std::uint16_t>(parsed->port);
    Pump::EnsurePolled();
    if (client != nullptr) {
      // A capacity walk moved to another region: the old client stays until the session ends.
      oldClients.emplace_back(settings, client);
      client = nullptr;
      settings = nullptr;
    }
    settings = colyseus_settings_create();
    colyseus_settings_set_address(settings, parsed->host.c_str());
    const std::string portText = std::to_string(parsed->port);
    colyseus_settings_set_port(settings, portText.c_str());
    colyseus_settings_set_secure(settings, parsed->secure);
    client = colyseus_client_create(settings);
    JoinRoom();
  }

  /** One join attempt with FRESH options (§3.2: never cache a token). `protocol` goes last. */
  void JoinRoom() {
    room_key::JoinPlan plan = room_key::PlanAuthorityJoin({options.matchKey, options.createPrivate, options.joinCode});
    if (plan.refused != room_key::TargetRefusal::None) {
      Refuse(0, "genex: this room cannot be asked for (a bad matchKey or joinCode, or a joinCode beside either)");
      return;
    }
    // §17.1 *Finding players*: a region asked for players is asked for a room that already exists, with the options
    // the join-or-create would send, and never opens one.
    if (Searching() || joinOnly) plan.method = room_key::JoinMethod::Join;
    JoinSpec spec;
    spec.gameId = options.gameId;
    spec.name = options.name;
    spec.extra = options.extra;
    // §17.1: counted, so a protocol bump can see whom it would strand. Never refused.
    if (spec.extra.IsObject()) spec.extra.Set("sdk", Json("unreal/0.1.0"));
    // §17.10 *Joining*: this client decodes and draws physics bodies (GenexBodies.h, held to
    // physics-draw.json), so a physics room may seat it.
    // §17.11 *Joining*: with the game's physics core and prediction on, it predicts a predicting room too.
    std::vector<std::string> caps{protocol::caps::kPhysics};
    if (PredictsPhysics()) caps.push_back(protocol::caps::kPhysicsPredict);
    // §17.11 *Input pacing*: this client reconciles a predicting room's repeated inputs (SteppedAck).
    caps.push_back(protocol::caps::kInputRepeat);
    // §17.12: a client that can open the fast channel's socket asks for it.
    if (options.fast) {
      caps.push_back(protocol::caps::kFast);
      caps.push_back(protocol::caps::kFastReturn);
    }
    spec.caps = options.capsOverride ? *options.capsOverride : caps;
    std::weak_ptr<int> weak = alive;
    const std::uint32_t attemptGen = ++gen;
    // The identity provider may be slow (an HTTP refresh): Leave() can run meanwhile, and a seat
    // taken after it would be a connected ghost (Godot _join_room).
    RequestJoinOptions(RoomProtocol::Authority, spec, url, options.tokenProvider,
                       [this, weak, attemptGen, plan](std::optional<Json> joinOptions, const IdentityError& error) {
                         if (weak.expired() || closed || leaving || attemptGen != gen) return;
                         if (!joinOptions) {
                           Refuse(error.status, "genex: the authority join options could not be built: " +
                                                    error.Describe());
                           return;
                         }
                         if (options.protocolOverride) {
                           joinOptions->Set(protocol::join_option::kProtocol, *options.protocolOverride);
                         }
                         if (!plan.matchKey.empty()) joinOptions->Set(protocol::join_option::kMatchKey, Json(plan.matchKey));
                         if (plan.privateRoom) joinOptions->Set(protocol::join_option::kPrivate, Json(true));
                         const std::string text = joinOptions->Dump();
                         switch (plan.method) {
                           case room_key::JoinMethod::JoinOrCreate:
                             colyseus_client_join_or_create(client, protocol::room_type::kAuthority, text.c_str(), CbRoom,
                                                            CbJoinError, NewCtx());
                             break;
                           case room_key::JoinMethod::Create:
                             colyseus_client_create_room(client, protocol::room_type::kAuthority, text.c_str(), CbRoom,
                                                         CbJoinError, NewCtx());
                             break;
                           case room_key::JoinMethod::JoinById:
                             colyseus_client_join_by_id(client, plan.roomId.c_str(), text.c_str(), CbRoom, CbJoinError, NewCtx());
                             break;
                           case room_key::JoinMethod::Join:
                             colyseus_client_join(client, protocol::room_type::kAuthority, text.c_str(), CbRoom, CbJoinError, NewCtx());
                             break;
                         }
                       });
  }

  void Leave() {
    if (closed) return;
    leaving = true;
    End(AuthorityStatus::Closed);
    if (room != nullptr) {
      // Mid-reconnect the leave cannot reach the server: colyseus_room_leave also cancels the retries
      // (and reports on_leave at once). A reconnect already landing is left in OnReconnect.
      colyseus_room_leave(room, true);
      leavingRooms.push_back(room);
      room = nullptr;
    }
  }

  /** Before a seat: the join is over. `JoinFailed` carries the code; the 426 and 402 are explained. */
  void Refuse(int code, const std::string& message) {
    if (closed) return;
    Explain(code, message);
    End(AuthorityStatus::Closed);
    AuthorityEvent e;
    e.type = AuthorityEventType::JoinFailed;
    e.code = code;
    e.message = message;
    events.push_back(std::move(e));
  }

  /** The refusals a developer must act on (PROTOCOL.md §17.2). Logged once per refusal. */
  static void Explain(int code, const std::string& message) {
    if (code == je::kProtocolUnsupported && message.find(protocol::caps::kPhysics) != std::string::npos) {
      Log(LogLevel::Error, "genex: the authority room runs physics and refused this client (426): " + message +
                               ": a physics room seats only a client that sends caps ['" + protocol::caps::kPhysics +
                               "'] (PROTOCOL.md §17.10)");
    } else if (code == je::kProtocolUnsupported) {
      Log(LogLevel::Error, "genex: the authority server refused protocol " +
                               std::to_string(protocol::kAuthorityProtocolVersion) + " (426): " + message +
                               ": this game needs an updated Genex plugin");
    } else if (code == je::kNotEntitled) {
      Log(LogLevel::Error,
          "genex: server-authoritative rooms are not available for this game (402): its owner is not entitled to "
          "them. Final; not retried.");
    }
  }

  /** After a seat: terminal. Not raised after Leave(). */
  void Terminal(int code, const std::string& reason) {
    if (closed) return;
    const bool wasJoined = joined;
    End(AuthorityStatus::Closed);
    if (wasJoined && options.rejoin && !leaving && rejoin::ComesBackAfter(code)) {
      // §17.13: the session starts its rejoin at this Update's end (AuthoritySession::DriveRejoin).
      lostCode = code;
      lostReason = reason;
      status = AuthorityStatus::Reconnecting;
      return;
    }
    if (!wasJoined) {
      // The socket closed before the first state: the join failed (Godot _terminal's error).
      AuthorityEvent e;
      e.type = AuthorityEventType::JoinFailed;
      e.code = code;
      e.message = reason.empty() ? "genex: the authority room closed before its first state" : reason;
      events.push_back(std::move(e));
      return;
    }
    AuthorityEvent e;
    e.type = AuthorityEventType::Disconnected;
    e.code = code;
    e.message = reason;
    events.push_back(std::move(e));
  }

  void End(AuthorityStatus next) {
    closed = true;
    status = next;
    joined = false;
    ready = false;
    connected = false;
    awaitingResync = false;
    retryAt = -1.0;
    DisposePrediction();
    DisposeShots();
    // physics-predict-session.ts dispose: the client world is freed and the session says `off`.
    FailPhysics(physics::PredictStatus::Off);
    views.clear();
    springs.clear();
    probes.clear();
  }

  void DisposeOwn() {
    if (own && own->reconciler != nullptr) colyseus_reconciler_free(own->reconciler);
    own.reset();
  }

  void DisposePrediction() {
    DisposeOwn();
    // Unbinds the spawn store (its collection callbacks) too; the store itself stays.
    if (predict != nullptr) colyseus_predict_free(predict);
    predict = nullptr;
    if (shadow != nullptr) colyseus_input_handle_free(shadow);
    shadow = nullptr;
    shadowEpoch = -1;
    ackHold = input_repeat::ReconcilerAckHold{};
    sentSinceAck.clear();
    sentSinceAckEpoch = -1;
    handle = nullptr;
    remotes.clear();
    ticked.Clear();
  }

  /** The spawn store and every prediction in it (after DisposePrediction: nothing feeds it then). */
  void DisposeShots() {
    unsettled.clear();
    if (shots != nullptr) colyseus_spawns_free(shots);  // frees every local (FreeShot)
    shots = nullptr;
    shotsRoom = nullptr;
  }

  /** TEST ONLY: an unclean close, as a network cut. */
  void Drop() {
    if (room == nullptr || room->transport == nullptr) return;
    colyseus_transport_close(room->transport, kDropClose, "genex: dropped");
  }

  void ApplyNoDelayNow() {
    // The C core never sets TCP_NODELAY (GenexNoDelay.h, measured on the relay): Nagle holds a small
    // input back until the previous one is acknowledged, bunching the 30 Hz input stream.
    if (port == 0) return;
    const std::optional<std::size_t> set = ApplyNoDelay(port);
    if (!set && !noDelayWarned) {
      noDelayWarned = true;
      Warn("TCP_NODELAY cannot be set on this platform's authority socket: inputs may leave in bursts");
    }
  }

  void Warn(std::string message) {
    AuthorityEvent e;
    e.type = AuthorityEventType::Warning;
    e.message = std::move(message);
    events.push_back(std::move(e));
  }

  // ---------------- callbacks (queued by the C callbacks, handled in Update) ----------------

  void Process(Raw& item, double now) {
    switch (item.kind) {
      case RawKind::Probe:
        ProbeAnswered(item, now);
        return;
      case RawKind::Latency:
        selecting = false;
        if (closed) return;
        if (!item.hasText) {
          Refuse(0, "genex: no authority server answered the latency race");
          return;
        }
        UseUrl(item.text);
        return;
      case RawKind::JoinError:
        if (item.gen != gen) return;
        if (item.room != nullptr) {
          // The room's connection failed before JOIN_ROOM (room_connect's on_error).
          if (item.room != room) return;
          Retire(room);
          room = nullptr;
        }
        OnRefused(item.code, item.text, now);
        return;
      case RawKind::Joined:
        if (closed || item.room != room) return;
        sid = Str(colyseus_room_get_session_id(room));
        roomId = Str(colyseus_room_get_id(room));
        // §8 settings, applied again at `joined` (Godot: a binding may reset options set before).
        SetReconnection(room);
        ApplyNoDelayNow();
        return;
      case RawKind::State:
        if (closed || item.room != room || StateOf(room) == nullptr) return;
        if (!joined) {
          joined = true;
          connected = true;
          seatMatchKey = options.matchKey;
          if (const authority_wire::AuthorityRoomState* st = State(); st != nullptr && st->matchKey != nullptr) seatMatchKey = st->matchKey;
          status = AuthorityStatus::Connected;
          capacity = regions::CapacityState{};
          // Seated: the search is over (a region asked for players seated it, or the walk did).
          search.clear();
          searchAt = 0;
          readyDeadline = now + kClockWarmupTimeoutMs;
          if (sid.empty()) sid = Str(colyseus_room_get_session_id(room));
          BuildPrediction();
        } else if (awaitingResync) {
          FinishResync();
        }
        RefreshPlayers();
        if (fastSeat != nullptr) fastSeat->OnState();
        return;
      case RawKind::Message: {
        if (item.room != room || closed) return;
        // §17.12: the fast channel's reliable messages (reserved names), never a game event.
        if (item.text == fast::kBindMessage) {
          if (fastSeat != nullptr) fastSeat->OnBind(item.data);
          return;
        }
        if (item.text == fast::kOffMessage) {
          if (fastSeat != nullptr) fastSeat->OnServerOff();
          return;
        }
        for (const char* reserved : kSessionEvents) {
          if (item.text == reserved) return;
        }
        if (item.text == protocol::server_message::kServerRestart) {
          AuthorityEvent restart;
          restart.type = AuthorityEventType::ServerRestart;
          events.push_back(std::move(restart));
          AuthorityEvent notice;
          notice.type = AuthorityEventType::Draining;
          const Json* drainMs = item.data.Find("drainMs");
          notice.ms = drainMs != nullptr && drainMs->IsNumber() ? drainMs->AsNumber() : rejoin::kUnknownCloseMs;
          events.push_back(std::move(notice));
        }
        AuthorityEvent e;
        e.type = AuthorityEventType::Message;
        e.name = item.text;
        e.data = std::move(item.data);
        events.push_back(std::move(e));
        return;
      }
      case RawKind::RoomError:
        if (item.room != room) return;
        if (joined) {
          Warn("genex: authority room error " + std::to_string(item.code) + ": " + item.text);
          return;
        }
        // The connection failed before the seat: a refusal like a matchmaking one.
        Retire(room);
        room = nullptr;
        OnRefused(item.code, item.text, now);
        return;
      case RawKind::Drop:
        if (item.room != room || closed) return;
        connected = false;
        status = AuthorityStatus::Reconnecting;
        awaitingResync = false;  // a drop during the post-reconnect sequence abandons it (§8)
        if (fastSeat != nullptr) fastSnapshotsBefore = fastSeat->Status().snapshots;
        if (fastSeat != nullptr) fastSeat->Dropped();
        fastLine.Reset();
        fastJoinedAt.reset();
        stallKicks = 0;
        stallRef = now;
        attempt += 1;
        {
          AuthorityEvent e;
          e.type = AuthorityEventType::Reconnecting;
          e.attempt = attempt;
          e.code = item.code;
          events.push_back(std::move(e));
        }
        return;
      case RawKind::Reconnect:
        if (item.room != room || closed) return;
        ApplyNoDelayNow();
        // §8 step 1: wait for the first full-state decode (at most 2 s), then finish.
        awaitingResync = true;
        resyncDeadline = now + rc::kFirstStateTimeoutMs;
        return;
      case RawKind::Leave: {
        Retire(item.room);
        if (item.room != room) return;
        room = nullptr;
        Terminal(item.code, item.text);
        return;
      }
    }
  }

  /** Move a room we no longer use to the graveyard (freed next Update). */
  void Retire(colyseus_room_t* target) {
    if (target == nullptr) return;
    leavingRooms.erase(std::remove(leavingRooms.begin(), leavingRooms.end(), target), leavingRooms.end());
    if (std::find(graveyard.begin(), graveyard.end(), target) == graveyard.end()) graveyard.push_back(target);
  }

  void OnRefused(int code, const std::string& message, double now) {
    if (closed) return;
    // §17.1 *Finding players*: no room in a region asked for players (Colyseus's 521), a dead path or a full region
    // asks the next one, and once none had a room the join itself walks `targets` from the nearest. An answer about
    // this player or game ends the join: every region would repeat it, and no room is opened.
    if (Searching() && !leaving) {
      if (regions::KindOfSearchRefusal(code) == regions::SearchRefusal::Final) {
        Refuse(code, message);
        return;
      }
      searchAt += 1;
      capacity = regions::CapacityState{};
      UseUrl(Searching() ? search[searchAt] : targets[0]);
      return;
    }
    // §17.2 *Choosing a room*: a join by code walks the regions, because the room is in exactly one of them.
    if (options.joinCode && !leaving) {
      const auto region = room_key::NextCodeRegion(code, capacity.region, std::max<std::size_t>(targets.size(), 1));
      if (!region || *region >= targets.size()) {
        Refuse(code, message);
        return;
      }
      capacity = regions::CapacityState{*region, 0, 0};
      UseUrl(targets[*region]);
      return;
    }
    // §17.1 *Regions*: a second refusal on a region moves to the next-best one at once; otherwise the schedule's
    // next wait on the same region.
    const regions::RefusalKind kind = regions::KindOfRefusal(code);
    if (kind == regions::RefusalKind::NextRegion && !leaving && capacity.region + 1 < targets.size()) {
      capacity = regions::CapacityState{capacity.region + 1, 0, capacity.step};
      UseUrl(targets[capacity.region]);
      return;
    }
    const bool capacityRefused = kind == regions::RefusalKind::Capacity && !leaving;
    const auto next = capacityRefused ? regions::NextAttempt(capacity, std::max<std::size_t>(targets.size(), 1), options.capacityRetryMs)
                                      : std::nullopt;
    if (!next) {
      Refuse(code, message);
      return;
    }
    const bool moved = next->second.region != capacity.region;
    capacity = next->second;
    if (moved && next->first.region < targets.size()) {
      UseUrl(targets[next->first.region]);
      return;
    }
    retryAt = now + next->first.waitMs;
  }

  static void SetReconnection(colyseus_room_t* target) {
    colyseus_reconnection_options_t o{};
    o.enabled = rc::kEnabled;
    o.max_retries = rc::kMaxRetries;
    o.min_delay_ms = rc::kMinDelayMs;
    o.max_delay_ms = rc::kMaxDelayMs;
    o.min_uptime_ms = rc::kMinUptimeMs;
    o.delay_ms = rc::kDelayMs;
    o.max_enqueued_messages = rc::kMaxEnqueuedMessages;
    colyseus_room_set_reconnection_options(target, &o);
  }

  /** Works around the C core's stalled reconnect attempt (Godot _unstick_reconnect; the same core):
   *  when the server closes a reconnect attempt's socket during the WebSocket handshake, the transport
   *  never reports it ("Connection closed during WebSocket handshake", native-core v0.18.10) and the
   *  retry waits forever. Once an attempt is kHandshakeStallMs past its scheduled start on the §8 ladder
   *  and the socket is still not open, closing the transport ends it: the core counts a failed attempt
   *  and runs the next one on its own ladder, inside the same retry budget. Never on an open socket.
   *  (The relay session instead re-takes the seat itself, as the Rust crate does; the authority session
   *  keeps Godot's rule, which its edge run measured.) */
  void UnstickReconnect(double now) {
    if (room == nullptr || room->transport == nullptr) return;
    if (room->transport->is_open != nullptr && room->transport->is_open(room->transport)) return;
    const int k = stallKicks + 1;
    const double grown = static_cast<double>(rc::kDelayMs) * std::pow(2.0, static_cast<double>((std::min)(k, 30)));
    const double delay =
        (std::min)((std::max)(grown, static_cast<double>(rc::kMinDelayMs)), static_cast<double>(rc::kMaxDelayMs));
    if (now < stallRef + delay + kHandshakeStallMs) return;
    stallKicks = k;
    stallRef = now;
    telemetry.reconnectKicks += 1;
    Drop();
  }

  void FinishResync() {
    awaitingResync = false;
    if (closed) return;
    // Normally done at the first state's decode (CbState); here too when that state never came.
    DropEarlierSockets();
    // The server allocated a fresh input buffer (the core reset the handle): rebuild prediction from the
    // server's state, so nothing sent before the drop replays (Godot _finish_resync).
    BuildPrediction();
    telemetry.reseeds += 1;
    paceFrom = NaN();
    attempt = 0;
    connected = true;
    status = AuthorityStatus::Connected;
    AuthorityEvent e;
    e.type = AuthorityEventType::Reconnected;
    events.push_back(std::move(e));
  }

  /** `Ready` waits for the room clock's first round trip (the first acknowledged input), at most
   *  kClockWarmupTimeoutMs. Before it the render time lacks rtt/2, so a remote drawn before the first ack
   *  steps back once when it lands (Godot 0.3-0.55 units at 150 ms; Unity 0.59). Inputs already flow. */
  void BecameReady(double now) {
    if (ready || !joined || closed) return;
    colyseus_room_clock_t* clock = colyseus_room_get_clock(room);
    if (colyseus_room_clock_smoothed_rtt(clock) <= 0.0 && now < readyDeadline) return;
    ready = true;
    if (rejoinedSeat) return;
    AuthorityEvent e;
    e.type = AuthorityEventType::Ready;
    e.message = sid;
    events.push_back(std::move(e));
  }

  // ---------------- state ----------------

  aw::AuthorityRoomState* State() const { return StateOf(room); }

  // ---- §17.11 *Input pacing*: the reconciler's shadow input handle ----

  /** The shadow handle beside `handle`: the same input schema and rates, a transport that sends nothing,
   *  no lag-comp stamps (the real handle carries them), and every input `handle` sent mirrored. */
  void CreateShadow() {
    if (handle == nullptr) return;
    colyseus_schema_t* data = aw::AuthorityInput_vtable.create();
    data->__vtable = &aw::AuthorityInput_vtable;
    colyseus_input_encoder_t* encoder = colyseus_input_encoder_create(data, &aw::AuthorityInput_vtable, false, 0);
    if (encoder == nullptr) {
      aw::AuthorityInput_vtable.destroy(data);
      return;
    }
    shadow = colyseus_input_handle_create(data, &aw::AuthorityInput_vtable, encoder, false, false, nullptr,
                                          colyseus_input_handle_tick_rate(handle), colyseus_input_handle_patch_rate(handle),
                                          colyseus_input_handle_sub_steps(handle), ShadowSend, ShadowOpen, nullptr, nullptr);
    shadowEpoch = colyseus_input_handle_epoch(handle);
    MirrorShadow();
  }

  /** The repeats the state says your seat owes (`inRep`, 0 when the room writes none). */
  double OwnInRep() const {
    aw::AuthorityRoomState* st = State();
    if (st == nullptr || st->players == nullptr || sid.empty()) return 0.0;
    const aw::AuthorityPlayer* p = static_cast<const aw::AuthorityPlayer*>(colyseus_map_schema_get(st->players, sid.c_str()));
    return p != nullptr ? p->inRep : 0.0;
  }

  /** The room's input repeat setting as its preset text publishes it (session.ts roomRepeat). */
  input_repeat::InputRepeat RoomRepeat() const {
    aw::AuthorityRoomState* st = State();
    const std::string text = st != nullptr ? Str(st->preset) : std::string();
    if (text != repeatText) {
      repeatText = text;
      repeatNow = input_repeat::InputRepeatOf(text);
    }
    return repeatNow;
  }

  /** The input your entity in the state was stepped through (input-repeat.ts steppedThrough): your
   *  prediction is compared with the state there, replays the inputs after it and times them from it. */
  int SteppedAck() const {
    if (handle == nullptr) return 0;
    return input_repeat::SteppedThrough(OwnAck(), OwnInRep(),
                                        colyseus_input_handle_sent_count(handle), RoomRepeat());
  }

  /** The shadow follows `handle`: reset with it (a reconnect's new socket counts from 1 again), every input
   *  it sent copied and sent on, then acknowledged up to what ReconcilerAck tells (input-repeat.ts
   *  reconcilerAck, which never falls between resets: a repeat adds one, an absorb trades one ack for one
   *  repeat; past the inputs sent, a hitch, it waits; past the ring it holds). */
  void MirrorShadow() {
    if (shadow == nullptr || handle == nullptr) return;
    const int epoch = colyseus_input_handle_epoch(handle);
    if (epoch != shadowEpoch) {
      colyseus_input_handle_reset(shadow);
      shadowEpoch = epoch;
    }
    const int sent = colyseus_input_handle_sent_count(handle);
    aw::AuthorityInput* into = reinterpret_cast<aw::AuthorityInput*>(colyseus_input_handle_data(shadow));
    const aw::AuthorityInput* staged = reinterpret_cast<const aw::AuthorityInput*>(colyseus_input_handle_data(handle));
    while (colyseus_input_handle_sent_count(shadow) < sent) {
      const int seq = colyseus_input_handle_sent_count(shadow) + 1;
      // An input already acknowledged is out of the real ring, which only a shadow made after it was sent can see:
      // the mirror runs in the frame an input goes, before any ack of it. Then any copy counts it.
      const aw::AuthorityInput* real = reinterpret_cast<const aw::AuthorityInput*>(colyseus_input_handle_at(handle, seq));
      const aw::AuthorityInput& from = real != nullptr ? *real : *staged;
      into->moveX = from.moveX;
      into->moveY = from.moveY;
      into->moveZ = from.moveZ;
      into->yaw = from.yaw;
      into->pitch = from.pitch;
      into->buttons = from.buttons;
      if (colyseus_input_handle_send(shadow) <= 0) break;
    }
    // §17.11 *The reconciler's ack*: waits past the inputs sent (a hitch), held back while the shadow's
    // ring no longer holds every input after it (the reconciler replays only from it: no other copy is read).
    const int through = input_repeat::StateThrough(OwnAck(), OwnInRep(), RoomRepeat());
    const int told = input_repeat::ReconcilerAck(ackHold, through, sent, colyseus_input_handle_replay_buffer_size(shadow), false);
    if (told > colyseus_input_handle_last_processed(shadow)) colyseus_input_handle_ack_input(shadow, told);
  }

  /** This frame's extra inputs from the upstream throttle (session.ts throttleExtra): the keyframe's
   *  `inStarve`/`inBuf` for your seat read, then the frame's share of the owed lead paid. */
  int ThrottleExtra(double now) {
    aw::AuthorityRoomState* st = State();
    const aw::AuthorityPlayer* me = st != nullptr && st->players != nullptr && !sid.empty()
                                        ? static_cast<const aw::AuthorityPlayer*>(colyseus_map_schema_get(st->players, sid.c_str()))
                                        : nullptr;
    const double stepMs = handle != nullptr && colyseus_input_handle_tick_rate(handle) > 0 ? StepMs() : 0.0;
    if (me != nullptr) input_repeat::ThrottleState(throttle, me->inStarve, me->inBuf, stepMs, RoomRepeat());
    const double dt = std::isnan(throttleAt) ? 0.0 : now - throttleAt;
    throttleAt = now;
    return input_repeat::ThrottleSteps(throttle, dt, stepMs);
  }

  /** A fresh Predict over the room: remote records restarted, the own entity found again. */
  void BuildPrediction() {
    DisposePrediction();
    colyseus_input_options_t io{};
    io.unreliable = false;
    // Lag compensation rewinds to what this player was rendering: the handle carries the delay, as the
    // TS session does (an explicit value here wins over the predict layer's binding).
    io.render_delay = renderDelay;
    // One input handle per room, kept (and reset, options intact) across an in-place reconnect: a
    // rebuild takes it back without options, as Godot's `_room.input()` does. Options on a second
    // call are ignored, and the C core warns on stderr about it.
    const bool first = room->input_handle == nullptr;
    handle = colyseus_room_input(room, &aw::AuthorityInput_vtable, first ? &io : nullptr);
    CreateShadow();
    predict = colyseus_predict_for_room(room);
    if (predict != nullptr && options.probeCoreLerp) AttachCoreLerp();
    BindShots();
    NotePatches();
  }

  // ---------------- projectiles (§17.9) ----------------

  /** The room's tick rate (the input handshake's; AuthorityTiming.TICK_HZ before it). */
  double TickHz() const {
    const int rate = handle != nullptr ? colyseus_input_handle_tick_rate(handle) : 0;
    return rate > 0 ? static_cast<double>(rate) : static_cast<double>(protocol::authority_timing::kTickHz);
  }

  double TickOrigin() const {
    aw::AuthorityRoomState* st = State();
    return st != nullptr ? st->tickOrigin : 0.0;
  }

  double ServerNow() const { return colyseus_room_clock_server_now(colyseus_room_get_clock(room)); }

  /** The instant of the frame being made (the pump's `nowMs` while it polls, Frame's `now` inside Frame), NaN outside
   *  one. */
  double FrameInstant() const {
    if (framing) return frameAt;
    return Pump::FrameNowMs();
  }

  /** How far the clock has moved past the frame's instant (0 outside a frame): the pump stamps a frame before its poll,
   *  whose decodes and keyframe replays (with Frame's own reconcile) took a millisecond in some frames and over ten in
   *  others (a burst of patches after a loss stall). Drawn at the clock after them, a rocket was a frame's flight ahead of
   *  its frame and back the next (Blast Yard rtt-200-loss-2 rocket.popMax 19-21 u, the Unity session's FrameLag 6). */
  double FrameLag() const {
    const double instant = FrameInstant();
    if (std::isnan(instant)) return 0.0;
    const double lag = Clock::NowMs() - instant;
    return lag >= 0.0 && lag <= kMaxFrameLagMs ? lag : 0.0;
  }

  /** The room clock at the instant being drawn: the frame's inside one, else now (the Unity session's ServerNowDrawn). */
  double ServerNowDrawn() const { return ServerNow() - FrameLag(); }

  /** How long before the frame's instant a state the pump's poll decodes is taken to have arrived, ms: half the time
   *  since the previous frame, at most kMaxArrivalLagMs (0 for any other decode). A keyframe adopted at the frame's own
   *  instant, with the world held at the lead cap, would be drawn where the world before it was: a frame without progress
   *  at every keyframe (the Unity session's ArrivalLag). */
  double ArrivalLag() const {
    if (framing || std::isnan(Pump::FrameNowMs()) || std::isnan(frameAt)) return 0.0;
    const double since = Pump::FrameNowMs() - frameAt;
    return since <= 0.0 ? 0.0 : (std::min)(since / 2.0, kMaxArrivalLagMs);
  }

  /** The room clock when the state being decoded arrived (see ArrivalLag). */
  double ServerNowArrived() const { return ServerNowDrawn() - ArrivalLag(); }

  /** A server projectile's launch instant on the room clock (the store's spawn_time). */
  double LaunchInstant(const aw::AuthorityEntity& e) const { return presets::TickInstant(e.t0, TickOrigin(), TickHz()); }

  static ProjectileLaunch LaunchOf(const aw::AuthorityEntity& e) {
    ProjectileLaunch l;
    l.x = static_cast<double>(e.x);
    l.y = static_cast<double>(e.y);
    l.z = static_cast<double>(e.z);
    l.vx = static_cast<double>(e.vx);
    l.vy = static_cast<double>(e.vy);
    l.vz = static_cast<double>(e.vz);
    l.g = static_cast<double>(e.g);
    l.t0 = e.t0;
    return l;
  }

  // The store's callbacks (userdata = this Impl). They run inside a patch's decode (add, correlate) or
  // the Predict's tick (prune, reject).
  /** Only your own projectiles are offered a prediction to confirm. */
  static bool ShotOwned(colyseus_schema_t* server, void* ud) {
    const Impl* impl = static_cast<const Impl*>(ud);
    const aw::AuthorityEntity* e = reinterpret_cast<const aw::AuthorityEntity*>(server);
    return IsProjectile(*e) && !impl->sid.empty() && Str(e->src) == impl->sid;
  }

  /** Correlation is by id: the server's projectile `<seat>.<seq>.<n>` confirms the prediction made under
   *  that id, and no other. */
  static bool ShotCorrelate(void* local, colyseus_schema_t* server, void* ud) {
    Impl* impl = static_cast<Impl*>(ud);
    Shot* shot = static_cast<Shot*>(local);
    const aw::AuthorityEntity* listed = impl->EntityById(shot->id);
    if (listed == nullptr || &listed->__base != server) return false;
    impl->Unsettle(shot);
    impl->telemetry.projectilesConfirmed += 1;
    impl->telemetry.lastProjectileLeadMs =
        impl->LaunchInstant(*reinterpret_cast<const aw::AuthorityEntity*>(server)) - shot->at;
    return true;
  }

  static double ShotSpawnTime(colyseus_schema_t* server, void* ud) {
    return static_cast<const Impl*>(ud)->LaunchInstant(*reinterpret_cast<const aw::AuthorityEntity*>(server));
  }

  /** The TTL fallback dropped it: no acknowledgement settled it first (its input was lost to a drop). */
  static void ShotRejected(void* local, int id, void* ud) {
    (void)id;
    Impl* impl = static_cast<Impl*>(ud);
    impl->Unsettle(static_cast<Shot*>(local));
    impl->telemetry.projectilesRejected += 1;
  }

  static void FreeShot(void* local) { delete static_cast<Shot*>(local); }

  void Unsettle(const Shot* shot) { unsettled.erase(std::remove(unsettled.begin(), unsettled.end(), shot), unsettled.end()); }

  /** The store, created once per room and fed by every Predict built over it. */
  void BindShots() {
    aw::AuthorityRoomState* st = State();
    if (predict == nullptr || st == nullptr) return;
    if (shots != nullptr && shotsRoom != room) DisposeShots();
    if (shots == nullptr) {
      colyseus_spawns_options_t so{};
      so.owned = ShotOwned;
      so.correlate = ShotCorrelate;
      so.spawn_time = ShotSpawnTime;
      so.has_spawn_time = true;
      // The store's TTL is fixed (max(2·RTT, 600 ms)); §17.9's waits out a stall, so the session keeps its own
      // (ExpireShots) and the store never evicts on its own.
      so.ttl_ms = kShotStoreNeverMs;
      so.on_reject = ShotRejected;
      so.local_free = FreeShot;
      so.userdata = this;
      shots = colyseus_spawns_create(&so, colyseus_room_get_clock(room));
      shotsRoom = room;
    }
    colyseus_predict_bind_spawns(predict, shots, &st->__base, "entities", nullptr);
  }

  /** §17.9's TTL fallback, the session's own (ProjectileTtl: a stalled link's silence not counted): a prediction
   *  nothing settled within it is dropped and counted rejected. Run each frame at the room clock's `now`. */
  void ExpireShots(double now) {
    if (unsettled.empty() || shots == nullptr || room == nullptr) return;
    const double ttl = projectileTtl.Ms(colyseus_room_clock_smoothed_rtt(colyseus_room_get_clock(room)), connected, now);
    std::vector<int> dropped;
    for (auto it = unsettled.begin(); it != unsettled.end();) {
      if (now - (*it)->madeAt <= ttl) {
        ++it;
        continue;
      }
      dropped.push_back((*it)->spawnId);
      it = unsettled.erase(it);
      telemetry.projectilesRejected += 1;
    }
    for (int id : dropped) colyseus_spawns_cancel(shots, id);  // frees the Shot
  }

  /** A state patch carries the server's acknowledgement of the inputs it consumed, with the state as of
   *  then: a prediction whose firing input is acknowledged and whose id that state lacks will never be
   *  confirmed (refused, or launched and removed before a patch could carry it). Dropped now rather than
   *  after its TTL. An input of an earlier socket (another handle epoch) is never acknowledged on this
   *  one. Runs in the C state callback, right after the patch decoded (session.ts settleShots). */
  void SettleShots() {
    if (unsettled.empty() || handle == nullptr || shots == nullptr) return;
    // On the fast channel the snapshot's ack runs ahead of the WebSocket's list (§17.12 *Client*).
    const int acked = fastSeat != nullptr ? fastSeat->SettleAck() : OwnAck();
    const int epoch = colyseus_input_handle_epoch(handle);
    std::vector<int> dropped;
    for (auto it = unsettled.begin(); it != unsettled.end();) {
      const Shot* shot = *it;
      if (shot->epoch != epoch || shot->seq > acked || EntityById(shot->id) != nullptr) {
        ++it;
        continue;
      }
      dropped.push_back(shot->spawnId);
      it = unsettled.erase(it);
      telemetry.projectilesRejected += 1;
    }
    for (int id : dropped) colyseus_spawns_cancel(shots, id);  // frees the Shot
  }

  /** The reconnect's first state is decoded: every prediction fired on an earlier socket that it did
   *  not confirm never will be. The server consumed what it got of that socket's inputs before it sent
   *  this state, so a launch they made is in it (confirmed during its decode) or already removed; an
   *  input lost in the drop was never consumed, and its sequence number is used again on this socket,
   *  so the next socket's shot reuses the lost one's id. Kept, the lost prediction would be the oldest
   *  pending one of that id and confirm the new shot with its own fire time (a lead of the whole
   *  reconnect), while the new prediction waited out its TTL. Dropped and counted rejected now; the
   *  acknowledgement rule (SettleShots) never sees an earlier socket's input. */
  void DropEarlierSockets() {
    resyncFirstState = false;
    if (unsettled.empty() || handle == nullptr || shots == nullptr) return;
    const int epoch = colyseus_input_handle_epoch(handle);
    std::vector<int> dropped;
    for (auto it = unsettled.begin(); it != unsettled.end();) {
      if ((*it)->epoch == epoch) {
        ++it;
        continue;
      }
      dropped.push_back((*it)->spawnId);
      it = unsettled.erase(it);
      telemetry.projectilesRejected += 1;
    }
    for (int id : dropped) colyseus_spawns_cancel(shots, id);  // frees the Shot
  }

  /** The seqBase the server gave this socket (§17.9; 0 from an older server or before the seat is listed). */
  double SeqBase() const {
    aw::AuthorityRoomState* st = State();
    if (st == nullptr || st->players == nullptr || sid.empty()) return 0.0;
    const aw::AuthorityPlayer* p = static_cast<const aw::AuthorityPlayer*>(colyseus_map_schema_get(st->players, sid.c_str()));
    return p != nullptr ? p->seqBase : 0.0;
  }

  /** Whether a projectile staged now could be keyed: seated, with an input handle and the store. */
  bool CanPredictProjectile() const {
    // Not while the socket is down: no input staged then is ever sent (SendSteps drops it), and the
    // handle's count and the seat's seqBase are not this socket's yet (they are at its first state).
    return !closed && joined && connected && handle != nullptr && shots != nullptr && room != nullptr && !sid.empty();
  }

  /** The id PredictProjectile would give a projectile staged now ("" when it would refuse). */
  std::string NextProjectileId() const {
    if (!CanPredictProjectile()) return std::string();
    const int seq = colyseus_input_handle_sent_count(handle) + 1;
    const int epoch = colyseus_input_handle_epoch(handle);
    const int n = stagedEpoch == epoch && stagedSeq == seq ? stagedN : 0;
    return AuthorityProjectileId(sid, SeqBase(), seq, n);
  }

  std::string PredictProjectile(const ProjectilePrediction& projectile) {
    if (!CanPredictProjectile()) return std::string();
    // The input being staged goes out as the next send: its sequence is one past what was sent, counted
    // on from the seqBase the server gave this socket.
    const int seq = colyseus_input_handle_sent_count(handle) + 1;
    const int epoch = colyseus_input_handle_epoch(handle);
    if (stagedEpoch != epoch || stagedSeq != seq) {
      stagedEpoch = epoch;
      stagedSeq = seq;
      stagedN = 0;
    }
    std::unique_ptr<Shot> shot(new Shot());
    shot->id = AuthorityProjectileId(sid, SeqBase(), seq, stagedN++);
    shot->kind = projectile.kind;
    shot->at = ServerNow();
    shot->launch.x = presets::LaunchNumber(projectile.x);
    shot->launch.y = presets::LaunchNumber(projectile.y);
    shot->launch.z = presets::LaunchNumber(projectile.z);
    shot->launch.vx = presets::LaunchNumber(projectile.vx);
    shot->launch.vy = presets::LaunchNumber(projectile.vy);
    shot->launch.vz = presets::LaunchNumber(projectile.vz);
    shot->launch.g = presets::LaunchGravity(projectile.g);
    shot->launch.t0 = presets::ServerTick(shot->at, TickOrigin(), TickHz());
    shot->seq = seq;
    shot->epoch = epoch;
    shot->madeAt = colyseus_room_clock_now(colyseus_room_get_clock(room));
    Shot* raw_ = shot.release();
    raw_->spawnId = colyseus_spawns_spawn(shots, raw_);  // the store owns it from here (FreeShot)
    unsettled.push_back(raw_);
    telemetry.projectilesPredicted += 1;
    const std::string id = raw_->id;
    // Drawn at once, at the instant it was fired: listed from now, not from the next Frame.
    if (ready) views[id] = ShotView(*raw_, raw_->launch.t0, TickHz());
    return id;
  }

  /** The clock projectiles are drawn by, read once: the room clock's serverNow and the tick at it. */
  AuthorityServerClock ReadClock() const {
    AuthorityServerClock c;
    c.serverNow = ServerNowDrawn();
    c.tickHz = TickHz();
    c.serverTick = presets::ServerTick(c.serverNow, TickOrigin(), c.tickHz);
    return c;
  }

  /** Whether that clock is the server's yet: a timed patch arrived and the input handshake gave the rate. */
  bool ClockTimed() const {
    if (room == nullptr || closed || handle == nullptr || State() == nullptr) return false;
    return colyseus_room_clock_last_server_time(colyseus_room_get_clock(room)) > 0.0 &&
           colyseus_input_handle_tick_rate(handle) > 0;
  }

  std::optional<AuthorityServerClock> ClockNow() const {
    if (!ClockTimed()) return std::nullopt;
    return ReadClock();
  }

  /** A projectile at the server's present, your own confirmed ones `lead` further on, so the flight
   *  continues the prediction's instead of snapping back by lead × velocity (session.ts projectileView).
   *  Only your own: one the server re-launched (a bounce, src '') is a server projectile from then on. */
  AuthorityEntityView ProjectileView(const std::string& id, aw::AuthorityEntity& e, double tick, double hz) const {
    const colyseus_spawn_entry_t* entry = shots != nullptr ? colyseus_spawns_entry_for(shots, &e.__base) : nullptr;
    const std::string src = Str(e.src);
    const double leadTicks =
        entry != nullptr && entry->local != nullptr && !sid.empty() && src == sid ? AuthorityLeadTicks(entry->lead_ms, hz) : 0.0;
    const ProjectileLaunch launch = LaunchOf(e);
    const ProjectileState at = presets::ProjectileAt(launch, tick + leadTicks, hz);
    AuthorityEntityView v;
    v.id = id;
    v.kind = Str(e.kind);
    v.owner = Str(e.owner);
    v.isMine = false;  // never your own entity (§17.9), even one a server wrongly gave an owner
    v.x = at.x;
    v.y = at.y;
    v.z = at.z;
    v.vx = at.vx;
    v.vy = at.vy;
    v.vz = at.vz;
    v.yaw = AuthorityWrapAngle(static_cast<double>(e.yaw));
    v.hp = e.hp;
    v.flags = e.flags;
    v.epoch = e.epoch;
    v.data = Str(e.data);
    v.t0 = e.t0;
    v.g = static_cast<double>(e.g);
    v.src = src;
    v.pitch = static_cast<double>(e.pitch);
    v.duck = static_cast<double>(e.duck);
    v.mstate = e.mstate;
    v.cap = static_cast<double>(e.cap);
    v.spin = static_cast<double>(e.spin);
    v.fuel = static_cast<double>(e.fuel);
    v.serverX = launch.x;
    v.serverY = launch.y;
    v.serverZ = launch.z;
    v.serverYaw = static_cast<double>(e.yaw);
    v.serverEpoch = e.epoch;
    return v;
  }

  /** A pending prediction as drawn at `tick` (session.ts shotView). */
  AuthorityEntityView ShotView(const Shot& shot, double tick, double hz) const {
    const ProjectileState at = presets::ProjectileAt(shot.launch, tick, hz);
    AuthorityEntityView v;
    v.id = shot.id;
    v.kind = shot.kind;
    v.x = at.x;
    v.y = at.y;
    v.z = at.z;
    v.vx = at.vx;
    v.vy = at.vy;
    v.vz = at.vz;
    v.t0 = shot.launch.t0;
    v.g = shot.launch.g;
    v.src = sid;
    v.serverX = shot.launch.x;
    v.serverY = shot.launch.y;
    v.serverZ = shot.launch.z;
    return v;
  }

  /** Every projectile view drawn again at `clock`: the server's (t0 > 0) and the pending predictions. */
  void DrawProjectileViews(aw::AuthorityRoomState* st, const AuthorityServerClock& clock) {
    for (auto it = views.begin(); it != views.end();) {
      if (it->second.IsProjectile()) {
        it = views.erase(it);
      } else {
        ++it;
      }
    }
    if (st == nullptr || st->entities == nullptr) return;
    const double hz = clock.tickHz;
    const double tick = clock.serverTick;
    ForEach(st->entities, [&](const std::string& id, void* value) {
      if (value == nullptr) return;
      aw::AuthorityEntity& e = *static_cast<aw::AuthorityEntity*>(value);
      if (IsProjectile(e)) views[id] = ProjectileView(id, e, tick, hz);
    });
    if (shots == nullptr) return;
    for (const colyseus_spawn_entry_t* entry = colyseus_spawns_first(shots); entry != nullptr;
         entry = colyseus_spawns_next(shots, entry)) {
      if (entry->confirmed || entry->local == nullptr) continue;
      const Shot& shot = *static_cast<const Shot*>(entry->local);
      if (views.find(shot.id) == views.end()) views[shot.id] = ShotView(shot, tick, hz);
    }
  }

  void AttachCoreLerp() {
    aw::AuthorityRoomState* st = State();
    if (st == nullptr) return;
    colyseus_predict_field_options_t position{};
    position.mode = COLYSEUS_PREDICT_LERP;
    position.delay = renderDelay;
    position.smooth_ms = -1.0;  // explicit 0: the exact interpolation, no output spring
    colyseus_predict_field_options_t angle = position;
    angle.angle = true;
    const colyseus_attach_field_t config[] = {{"x", &position}, {"y", &position}, {"yaw", &angle}};
    colyseus_predict_attach_all(predict, &st->__base, "entities", config, 3, nullptr, nullptr);
  }

  /** The patch's time on the server-stamped timeline the render time is on. */
  double PatchTime() const {
    colyseus_room_clock_t* clock = colyseus_room_get_clock(room);
    const double last = colyseus_room_clock_last_server_time(clock);
    return last > 0.0 ? last : colyseus_room_clock_now(clock);
  }

  /** The render time an input sent now carries on the fast channel: the stamp the handle's WebSocket frame
   *  carries (§17.12 *Render-time stamp*), on the room clock and the handle's render delay. */
  double FastRenderStamp() const {
    colyseus_room_clock_t* clock = colyseus_room_get_clock(room);
    const bool synced = colyseus_room_clock_last_server_time(clock) > 0.0;
    const std::optional<double> now = synced ? std::optional<double>(ServerNow()) : std::nullopt;
    const double delay = handle != nullptr ? colyseus_input_handle_render_delay(handle) : renderDelay;
    return fast::RenderStamp(now, delay, colyseus_room_clock_smoothed_rtt(clock));
  }

  /** Where the other entities are drawn on that timeline (the TS session's and the server rewind's). */
  double RenderTime() const {
    colyseus_room_clock_t* clock = colyseus_room_get_clock(room);
    if (colyseus_room_clock_last_server_time(clock) > 0.0) {
      return ServerNowDrawn() - renderDelay - colyseus_room_clock_smoothed_rtt(clock) / 2.0;
    }
    return colyseus_room_clock_now(clock) - renderDelay;
  }

  /** Once per patch, right after it decoded (the C state callback): note every entity's pose and time,
   *  and every epoch bump. The port of session.ts notePatch, Godot _note_patches, Unity NotePatches. */
  void NotePatches() {
    aw::AuthorityRoomState* st = State();
    if (st == nullptr || st->entities == nullptr) return;
    const double at = PatchTime();
    std::unordered_set<std::string> present;
    ForEach(st->entities, [&](const std::string& id, void* value) {
      if (value == nullptr) return;
      aw::AuthorityEntity* e = static_cast<aw::AuthorityEntity*>(value);
      // A projectile is drawn from its flight, never from patch history (§17.9); a physics body at the
      // server's present from its latest state (§17.10, NoteBodies).
      if (IsProjectile(*e) || IsBody(id)) return;
      present.insert(id);
      colyseus_schema_t* instance = &e->__base;
      auto it = remotes.find(id);
      if (it == remotes.end() || it->second.entity != instance || it->second.refId != instance->__refId) {
        Remote fresh;
        fresh.entity = instance;
        fresh.refId = instance->__refId;
        fresh.epoch = e->epoch;
        fresh.history.push_back(PoseOf(*e, at));
        remotes[id] = std::move(fresh);
        ticked.Forget(id);
        return;
      }
      Remote& known = it->second;
      if (e->epoch != known.epoch) {
        // The own entity's bump is not held (session.ts): its new life starts a fresh record.
        if (Str(e->owner) != sid) {
          Respawn r;
          r.at = at;
          r.epoch = known.epoch;
          r.history = std::move(known.history);
          known.respawns.push_back(std::move(r));
        }
        known.history.clear();
        known.epoch = e->epoch;
      }
      std::vector<AuthorityPose>& history = known.history;
      // Deviation (none of the sources has it): a stamp far behind the newest one is a change of clock
      // axis (local arrival before the first TIMED sample, then server time), never a patch to drop.
      if (!history.empty() && at < history.back().t - kHistoryBackJumpMs) history.clear();
      if (history.empty() || at > history.back().t) history.push_back(PoseOf(*e, at));
      while (history.size() > 2 && history[1].t < at - kRemoteHistoryMs) history.erase(history.begin());
    });
    for (auto it = remotes.begin(); it != remotes.end();) {
      if (present.count(it->first) == 0) {
        ticked.Forget(it->first);
        it = remotes.erase(it);
      } else {
        ++it;
      }
    }
  }

  // ---- other entities on the tick timeline (§17.11 *Drawing other seats*, tick-drawing.ts) ----
  // In a predicting room each patch is one keyframe: its entities are sampled at that keyframe's tick,
  // after the whole patch decoded (the state's tick is then the keyframe's), and drawn at the render time
  // from those samples instead of the patch stamps. Never across an epoch: TickDrawing holds the old life
  // until the new one's first sample.

  /** Whether other entities are drawn on the tick timeline: a predicting room (physDesc set), unless
   *  RemoteSamples::Patch. */
  bool DrawsOnTicks() const {
    aw::AuthorityRoomState* st = State();
    return options.remoteSamples != RemoteSamples::Patch && st != nullptr && st->physDesc != nullptr && st->physDesc[0] != '\0';
  }

  /** The room's K (keyframe interval in ticks; 1 when its physDesc does not parse), cached per text. */
  int KeyframeTicksOf(const std::string& text) {
    if (text != keyframeTicksText) {
      keyframeTicksText = text;
      const std::optional<physics::PhysDesc> desc = physics::ParsePhysDesc(text);
      keyframeTicks = desc && desc->keyframeTicks > 0 ? desc->keyframeTicks : 1;
    }
    return keyframeTicks;
  }

  /** Once a patch is decoded whole (CbState): in a predicting room whose state holds a keyframe (tick ==
   *  keyframe), every entity but a projectile or a body is sampled at that keyframe's instant on the room
   *  clock, tickOrigin + tick · 1000 / tickHz, in its life (epoch). The TypeScript samples only the
   *  entities the patch changed; an unchanged one here repeats its held pose at the keyframe, which draws
   *  the same (Unity does the same). Not before the room's tick rate is known (the input handshake's):
   *  a sample timed at the protocol's default rate would sit far ahead of every true one after it. */
  void SampleTicks() {
    aw::AuthorityRoomState* st = State();
    if (st == nullptr || st->entities == nullptr || !DrawsOnTicks() || st->tick != st->keyframe) return;
    if (handle == nullptr || colyseus_input_handle_tick_rate(handle) <= 0) return;
    const double hz = TickHz();
    const double at = presets::TickInstant(st->tick, TickOrigin(), hz);
    const double period = 1000.0 / hz * static_cast<double>(KeyframeTicksOf(Str(st->physDesc)));
    telemetry.tickKeyframes += 1;
    ForEach(st->entities, [&](const std::string& id, void* value) {
      if (value == nullptr) return;
      const aw::AuthorityEntity& e = *static_cast<const aw::AuthorityEntity*>(value);
      if (IsProjectile(e) || IsBody(id)) return;
      TickPose pose;
      pose.x = static_cast<double>(e.x);
      pose.y = static_cast<double>(e.y);
      pose.z = static_cast<double>(e.z);
      pose.yaw = static_cast<double>(e.yaw);
      pose.pitch = static_cast<double>(e.pitch);
      pose.duck = static_cast<double>(e.duck);
      ticked.Push(id, at, pose, period, e.epoch);
    });
  }

  void RefreshPlayers() {
    aw::AuthorityRoomState* st = State();
    std::vector<std::string> present;
    if (st != nullptr && st->players != nullptr) {
      ForEach(st->players, [&](const std::string& id, void* value) {
        if (value == nullptr) return;
        const aw::AuthorityPlayer* p = static_cast<const aw::AuthorityPlayer*>(value);
        present.push_back(id);
        AuthorityPlayerView& v = playerViews[id];
        v.id = id;
        v.name = Str(p->name);
        v.uid = Str(p->uid);
        v.team = Str(p->team);
        v.connected = p->connected;
        v.avatarUrl = Str(p->avatarUrl);
        v.isMe = id == sid;
      });
    }
    for (auto it = playerViews.begin(); it != playerViews.end();) {
      if (std::find(present.begin(), present.end(), it->first) == present.end()) {
        it = playerViews.erase(it);
      } else {
        ++it;
      }
    }
  }

  // ---------------- physics bodies (§17.10 *Drawing*) ----------------
  // A body exists for this client exactly while its descriptor (the state's `bodies`) does, and is drawn
  // once its entity has been received. Each patch that changed a body's fields is a newer state: the
  // patch's tick t means the body at tick t + 1, and it arrives at the room clock's present. It is drawn
  // at the server's present on the same clock (GenexBodies.h); an entity that left this client's view is
  // held at its last state while the descriptor stays.

  /** Whether `id` is a physics body entity: its key has a descriptor. */
  bool IsBody(const std::string& id) const {
    aw::AuthorityRoomState* st = State();
    return st != nullptr && st->bodies != nullptr && colyseus_map_schema_get(st->bodies, id.c_str()) != nullptr;
  }

  /** The room as bodies are drawn in it; a lengthUnit never received (0) reads as 1 (session.ts). */
  bodies::BodyRoom BodyRoomNow() const {
    bodies::BodyRoom r;
    aw::AuthorityRoomState* st = State();
    r.tickHz = TickHz();
    const double unit = st != nullptr ? static_cast<double>(st->lengthUnit) : 0.0;
    r.lengthUnit = unit > 0.0 ? unit : 1.0;
    r.tickOrigin = TickOrigin();
    return r;
  }

  /** Called on every decoded patch (CbState): descriptors added and removed, and each body's newer state. */
  void NoteBodies() {
    aw::AuthorityRoomState* st = State();
    if (st == nullptr || room == nullptr) return;
    if (st->bodies == nullptr) {
      bodyTracks.clear();
      return;
    }
    const bodies::BodyRoom r = BodyRoomNow();
    const double at = ServerNowArrived();
    const double tick = st->tick;
    std::unordered_set<std::string> present;
    ForEach(st->bodies, [&](const std::string& key, void* value) {
      if (value == nullptr) return;
      present.insert(key);
      const aw::AuthorityBody* d = static_cast<const aw::AuthorityBody*>(value);
      colyseus_schema_t* instance = static_cast<colyseus_schema_t*>(value);
      BodyTrack& track = bodyTracks[key];
      if (track.descriptor != instance || track.descriptorRef != instance->__refId) {
        // A new descriptor (a body spawned, or removed and spawned again under the key): a new body.
        track = BodyTrack();
        track.descriptor = instance;
        track.descriptorRef = instance->__refId;
      }
      track.type = Str(d->type);
      track.kind = Str(d->kind);
      track.colliders = Str(d->colliders);
      aw::AuthorityEntity* e = EntityById(key);
      if (e == nullptr) return;  // out of view, or never received: held, or not drawn yet
      const bodies::BodyFields fields = BodyFieldsOf(*e);
      if (track.hasFields && SameBodyFields(track.fields, fields)) return;
      track.fields = fields;
      track.hasFields = true;
      const bool snapped = track.drawer.Receive(bodies::StateOf(tick, fields), at, track.spawnPending, r);
      track.spawnPending = false;
      telemetry.bodyStates += 1;
      if (snapped) {
        telemetry.bodySnaps += 1;
      } else {
        const bodies::Vec3& dp = track.drawer.Offset();
        const double moved = std::sqrt(dp.x * dp.x + dp.y * dp.y + dp.z * dp.z);
        telemetry.peakBodyCorrection = (std::max)(telemetry.peakBodyCorrection, moved);
      }
    });
    for (auto it = bodyTracks.begin(); it != bodyTracks.end();) {
      if (present.count(it->first) == 0) {
        it = bodyTracks.erase(it);
      } else {
        ++it;
      }
    }
  }

  // ---------------- physics prediction (§17.11): physics-predict-session.ts ----------------

  /** Whether this session predicts physics at all: prediction on and a core (or its loader) given
   *  (session.ts `enabled`). Without one it is `off` and never claims physics@2. */
  bool PredictsPhysics() const {
    return options.predictPhysics && (options.physicsCore != nullptr || static_cast<bool>(options.physicsCoreLoader));
  }

  physics::PredictStatus PredictStatusNow() const {
    if (!PredictsPhysics()) return physics::PredictStatus::Off;
    return predictStatus;
  }

  void FailPhysics(physics::PredictStatus why) {
    predictStatus = why;
    if (predictor) predictor->Stop(why);
    predictor.reset();
  }

  /** The room's static world as the client world takes it: the session's world (SetWorld). */
  physics::StaticWorld PhysicsStatic() const {
    physics::StaticWorld out;
    if (world == nullptr) return out;
    for (const FirstpersonWorld::Box& b : world->Boxes()) out.boxes.emplace_back(b.begin(), b.end());
    for (const FirstpersonWorld::Ramp& r : world->Ramps()) out.ramps.emplace_back(r.begin(), r.end());
    return out;
  }

  /** `inputDecay`: a remote seat steps by the room's own movement preset (session.ts remoteStep). */
  physics::RemoteStep PhysicsRemoteStep() const {
    aw::AuthorityRoomState* st = State();
    const Prediction roomStep = PredictionFor(st != nullptr && st->preset != nullptr ? std::string_view(st->preset) : std::string_view(), world);
    if (!roomStep.Known()) return physics::RemoteStep();
    return [roomStep](std::map<std::string, double>& body, const physics::RemoteInput& in, double dt) {
      aw::AuthorityEntity mirror;
      std::memset(&mirror, 0, sizeof mirror);
      const char* const* fields = roomStep.Fields();
      for (int i = 0; i < roomStep.FieldCount(); ++i) SetEntityField(mirror, fields[i], body[fields[i]]);
      SetEntityField(mirror, "x", body["x"]);
      SetEntityField(mirror, "y", body["y"]);
      SetEntityField(mirror, "z", body["z"]);
      roomStep.Step(mirror, Input::FromRaw(in.moveX, in.moveY, in.moveZ, in.yaw, in.pitch, in.buttons).Sanitized(), dt);
      for (int i = 0; i < roomStep.FieldCount(); ++i) body[fields[i]] = FieldOf(mirror, fields[i]);
      body["x"] = FieldOf(mirror, "x");
      body["y"] = FieldOf(mirror, "y");
      body["z"] = FieldOf(mirror, "z");
    };
  }

  /** Makes the client world once a room sends keyframes (session.ts load). */
  void LoadPhysics(aw::AuthorityRoomState& st) {
    // The core loads only once a room sends keyframes (§17.11 *Fallback levels*), once.
    if (!options.physicsCore && options.physicsCoreLoader && !physicsLoadTried) {
      physicsLoadTried = true;
      options.physicsCore = options.physicsCoreLoader();
    }
    if (!options.physicsCore) {
      predictStatus = physics::PredictStatus::Unavailable;
      return;
    }
    if (!predictSelfTested) {
      predictSelfTested = true;
      if (!physics::SelfTestPredictCore(*options.physicsCore)) return FailPhysics(physics::PredictStatus::SelfTest);
    }
    std::optional<physics::PhysDesc> desc = physics::ParsePhysDesc(Str(st.physDesc));
    if (!desc) return FailPhysics(physics::PredictStatus::Mismatch);
    physics::PredictorOptions o;
    o.desc = std::move(*desc);
    o.staticWorld = PhysicsStatic();
    o.physicsHash = Str(st.physics);
    o.tickHz = TickHz();
    o.budgetMs = AuthorityEffectiveBudgetMs(options.physicsBudgetMs, options.physicsResimBudgetMs);
    o.remoteStep = PhysicsRemoteStep();
    // §17.11 *Body rules*, *Seat rules*: the module's rules, run in the client world.
    o.bodyRule = options.bodyRule;
    o.seatRule = options.seatRule;
    // §17.11 *Kinematic rules*: the module's kinematic bodies posed by its own schedule in the client world.
    o.kinematicRule = options.kinematicRule;
    // §17.11 *Contact policy*: a declared policy's pass runs in the replay on ticks no seat prediction posed.
    o.contactPass = [this](std::vector<ContactBody>& seats) {
      if (const DeclaredContacts* d = Declared()) d->Pass(seats);
    };
    // `predicted`: the client world poses other seats' preset bodies where the seat prediction has them.
    if (seatWorld != nullptr) {
      o.seatPose = [this](const std::string& key, double seq) -> std::optional<physics::RuleSeat> {
        SeatWorld* seats = SeatWorldNow();
        if (seats == nullptr) return std::nullopt;
        const std::optional<SeatPose> at = seats->PoseAt(key, seq);
        if (!at) return std::nullopt;
        physics::RuleSeat out;
        out.key = key;
        out.x = at->x;
        out.y = at->y;
        out.z = at->z;
        out.vx = at->vx;
        out.vy = at->vy;
        out.vz = at->vz;
        return out;
      };
    }
    predictor = std::make_unique<physics::PhysicsPredictor>(options.physicsCore, std::move(o));
    if (!predictor->Predicting()) return FailPhysics(predictor->Status());
    predictStatus = predictor->Status();
  }

  /** A canonical descriptor's text with its shapes inlined from the state's `shapes` (physics-keyframe.ts
   *  inlineShapes); none when it is not one or names a shape the state lacks. */
  std::optional<Json> InlineShapes(const std::string& text, aw::AuthorityRoomState& st) const {
    std::optional<Json> desc = Json::Parse(text);
    if (!desc || !desc->IsObject()) return std::nullopt;
    Json* colliders = desc->Find("colliders");
    if (colliders == nullptr || !colliders->IsArray()) return std::nullopt;
    for (std::size_t i = 0; i < colliders->Size(); ++i) {
      Json* collider = colliders->AtMut(i);
      Json* shape = collider != nullptr && collider->IsObject() ? collider->Find("shape") : nullptr;
      if (shape == nullptr || !shape->IsObject()) return std::nullopt;
      const Json* ref = shape->Find("ref");
      if (ref == nullptr) continue;
      if (!ref->IsString() || st.shapes == nullptr) return std::nullopt;
      const aw::AuthorityShape* data = static_cast<const aw::AuthorityShape*>(colyseus_map_schema_get(st.shapes, ref->AsString().c_str()));
      if (data == nullptr) return std::nullopt;
      std::optional<Json> inlined = Json::Parse(Str(data->data));
      if (!inlined) return std::nullopt;
      collider->Set("shape", std::move(*inlined));
    }
    return desc;
  }

  /** The keyframe the state holds now: bodies in view, out of view, joints, seats (session.ts keyframeOf). */
  physics::PredictKeyframe KeyframeNow(aw::AuthorityRoomState& st, const physics::RemoteStep& remoteStep) {
    physics::PredictKeyframe kf;
    kf.tick = st.keyframe;
    kf.ack = handle != nullptr ? static_cast<double>(SteppedAck()) : 0.0;
    if (st.bodies != nullptr) {
      ForEach(st.bodies, [&](const std::string& key, void* value) {
        if (value == nullptr) return;
        const aw::AuthorityBody* d = static_cast<const aw::AuthorityBody*>(value);
        const std::string text = Str(d->desc);
        const std::optional<Json> desc = text.empty() ? std::nullopt : InlineShapes(text, st);
        const aw::AuthorityEntity* e = EntityById(key);
        std::optional<bodies::Vec3> listed;
        if (e != nullptr) listed = bodies::Vec3{static_cast<double>(e->x), static_cast<double>(e->y), static_cast<double>(e->z)};
        const auto seen = predictLastSeen.find(key);
        const std::optional<bodies::Vec3> lastSeen =
            seen != predictLastSeen.end() ? std::optional<bodies::Vec3>(seen->second) : std::nullopt;
        // §17.12: on the fast channel a body is in a keyframe only while the newest snapshot carries it.
        const bool motionKnown = fastSeat == nullptr || fastSeat->MotionKnown(key);
        if (const std::optional<bodies::Vec3> out = physics::OutOfViewAt(listed, motionKnown, lastSeen)) {
          physics::KeyframeOutside o;
          o.key = key;
          o.x = out->x;
          o.y = out->y;
          o.z = out->z;
          o.radius = desc ? physics::BodyRadiusOf(*desc) : 0.0;
          kf.outside.push_back(std::move(o));
          return;
        }
        const bodies::Vec3 at = *listed;
        predictLastSeen[key] = at;
        physics::KeyframeBody b;
        b.key = key;
        b.desc = desc;
        b.row = physics::WireRowOfFields(BodyFieldsOf(*e), std::isfinite(e->rest) ? e->rest : 0.0);
        b.epoch = e->epoch;
        kf.bodies.push_back(std::move(b));
      });
    }
    for (auto it = predictLastSeen.begin(); it != predictLastSeen.end();) {
      const bool known = st.bodies != nullptr && colyseus_map_schema_get(st.bodies, it->first.c_str()) != nullptr;
      it = known ? std::next(it) : predictLastSeen.erase(it);
    }
    if (st.joints != nullptr) {
      ForEach(st.joints, [&](const std::string& key, void* value) {
        if (value == nullptr) return;
        const aw::AuthorityJoint* j = static_cast<const aw::AuthorityJoint*>(value);
        // A joint whose text does not parse is left out: its island is then incomplete for no one.
        std::optional<Json> desc = Json::Parse(Str(j->desc));
        if (!desc) return;
        physics::KeyframeJoint joint;
        joint.key = key;
        joint.desc = std::move(*desc);
        const std::string motor = Str(j->motor);
        if (!motor.empty()) {
          std::optional<Json> parsed = Json::Parse(motor);
          if (!parsed) return;
          joint.motor = std::move(*parsed);
        }
        kf.joints.push_back(std::move(joint));
      });
    }
    std::unordered_set<std::string> taken;
    const std::string ownId = own ? own->id : std::string();
    const Prediction roomStep = remoteStep ? PredictionFor(st.preset != nullptr ? std::string_view(st.preset) : std::string_view(), world) : Prediction();
    if (st.entities != nullptr) {
      ForEach(st.entities, [&](const std::string& id, void* value) {
        if (value == nullptr) return;
        const aw::AuthorityEntity& e = *static_cast<const aw::AuthorityEntity*>(value);
        const std::string owner = Str(e.owner);
        if (owner.empty() || taken.count(owner) != 0 || IsProjectile(e) || IsBody(id)) return;
        const aw::AuthorityPlayer* player =
            st.players != nullptr ? static_cast<const aw::AuthorityPlayer*>(colyseus_map_schema_get(st.players, owner.c_str())) : nullptr;
        if (player == nullptr) return;
        taken.insert(owner);
        physics::KeyframeSeat seat;
        seat.key = id;
        seat.x = static_cast<double>(e.x);
        seat.y = static_cast<double>(e.y);
        seat.z = static_cast<double>(e.z);
        seat.vx = static_cast<double>(e.vx);
        seat.vy = static_cast<double>(e.vy);
        seat.vz = static_cast<double>(e.vz);
        seat.epoch = e.epoch;
        seat.own = id == ownId;
        // The room writes a seat's input with its keyframes (§17.11 *State*); a remote step reads it.
        physics::RemoteInput in;
        in.moveX = static_cast<double>(player->inMoveX);
        in.moveY = static_cast<double>(player->inMoveY);
        in.moveZ = static_cast<double>(player->inMoveZ);
        in.yaw = static_cast<double>(player->inYaw);
        in.pitch = static_cast<double>(player->inPitch);
        in.buttons = player->inButtons;
        seat.input = in;
        const char* const* fields = roomStep.Fields();
        for (int i = 0; i < roomStep.FieldCount(); ++i) seat.body[fields[i]] = FieldOf(e, fields[i]);
        kf.seats.push_back(std::move(seat));
      });
    }
    return kf;
  }

  /** Called on every decoded patch (CbState): makes the client world, holds a new keyframe for the frame. */
  void NotePhysicsKeyframe() {
    if (!PredictsPhysics() || closed) return;
    aw::AuthorityRoomState* st = State();
    if (st == nullptr || st->keyframe == 0.0 || Str(st->physDesc).empty()) return;
    // The client world steps at the room's tick rate, which the input handle carries (the join
    // handshake's): the first states are decoded before the handle exists, and a world made then took
    // the protocol default (30 Hz) for a 60 or 120 Hz room: its lead cap a quarter of the room's and
    // its seats extrapolated four times too far, so the ball was drawn up to 180 ms behind the server.
    if (handle == nullptr) return;
    SyncPhysicsSocket();
    if (!predictor) {
      if (predictStatus == physics::PredictStatus::Loading) LoadPhysics(*st);
      return;
    }
    // Only a tick-aligned patch holds a keyframe whole (§17.11 *Keyframes*).
    if (st->keyframe == predictKeyframe || st->tick != st->keyframe) return;
    predictKeyframe = st->keyframe;
    const physics::RemoteStep remoteStep = PhysicsRemoteStep();
    // §17.11 *A burst of keyframes*: adopted as it arrives until the adoptions since the last frame have
    // taken a frame's time; past it held for the next frame, the newest of the rest replacing the older
    // (after a stall the socket hands over a second of states at once: one adoption each, your path stepped
    // again for each, was one frame of 151-171 ms on the 250 ms seam). What it is adopted with is taken now.
    PendingKeyframe held{KeyframeNow(*st, remoteStep), colyseus_input_handle_sent_count(handle), ServerNowArrived()};
    if (adoptSpentMs >= kAdoptFrameBudgetMs) {
      pendingKeyframe = std::move(held);
      return;
    }
    const auto started = std::chrono::steady_clock::now();
    AdoptPhysicsKeyframe(held);
    adoptSpentMs += std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
  }

  /** A frame begins: adopts the keyframe held for it, if any, and opens the next frame's budget
   *  (AfterPhysicsSend and the body drawing settle too). */
  void SettlePhysicsKeyframe() {
    adoptSpentMs = 0.0;
    if (!pendingKeyframe) return;
    PendingKeyframe held = std::move(*pendingKeyframe);
    pendingKeyframe.reset();
    AdoptPhysicsKeyframe(held);
  }

  void NoteReplayMiss(physics::AdoptReport::Miss miss) {
    using Miss = physics::AdoptReport::Miss;
    if (miss == Miss::NoPrediction) predictCounts.missNoPrediction += 1;
    if (miss == Miss::Rows) predictCounts.missRows += 1;
    if (miss == Miss::BodySet) predictCounts.missBodySet += 1;
    if (miss == Miss::AckLate) predictCounts.missAckLate += 1;
    if (miss == Miss::Joints) predictCounts.missJoints += 1;
    if (miss == Miss::Seats) predictCounts.missSeats += 1;
  }

  /** Adopts `held`: your path stepped again from its state, then the predictor's adoption. */
  void AdoptPhysicsKeyframe(const PendingKeyframe& held) {
    if (!predictor || closed) return;
    // The ring held your positions as predicted when each input left; a correction since then moved
    // them: the replay poses your preset body from your inputs stepped again from this state.
    ownRing.Refresh(OwnPathNow());
    const physics::OwnPoseOf ownPose = [this](double seq) { return ownRing.Pose(seq); };
    const physics::OwnPoseOf ownVelocity = [this](double seq) { return ownRing.Velocity(seq); };
    const physics::AdoptReport report = predictor->Adopt(held.keyframe, held.sent, ownPose, held.now, ownVelocity);
    if (report.kind == physics::AdoptReport::Kind::Match) predictCounts.matched += 1;
    if (report.kind == physics::AdoptReport::Kind::Replay) predictCounts.replayed += 1;
    NoteReplayMiss(report.miss);
    predictCounts.peakResimMs = (std::max)(predictCounts.peakResimMs, report.ms);
    predictCounts.fallbacks = predictor->Fallbacks();
    predictCounts.recoveries = predictor->Recoveries();
    // `cpu` is not the end: the predictor keeps its world and probes its way back (§17.11 *Budgets*).
    if (predictor->Stopped()) {
      FailPhysics(predictor->Status());
    } else {
      predictStatus = predictor->Status();
    }
    ownRing.SetStepped(held.sent);
  }

  /** A new socket counts its inputs from 1 again: your positions by sequence start over, and the next
   *  keyframe is adopted whole (its ack is not where the old socket's prediction put it: a replay). */
  void SyncPhysicsSocket() {
    if (handle == nullptr) return;
    const int epoch = colyseus_input_handle_epoch(handle);
    if (predictEpoch == -1) predictEpoch = epoch;
    if (epoch == predictEpoch) return;
    predictEpoch = epoch;
    predictKeyframe = 0.0;
    // A keyframe held from the old socket counted the old socket's inputs.
    pendingKeyframe.reset();
    ownRing.Restart(colyseus_input_handle_sent_count(handle));
  }

  /** Your predicted position and velocity now (your preset body in the client world; a body rule reads
   *  your velocity), from the reconciler's mirror, or none. */
  std::optional<OwnState> OwnPosition() const {
    if (!own || own->reconciler == nullptr) return std::nullopt;
    const aw::AuthorityEntity* mirror = reinterpret_cast<const aw::AuthorityEntity*>(colyseus_reconciler_state(own->reconciler));
    if (mirror == nullptr) return std::nullopt;
    OwnState s;
    s.p.x = static_cast<double>(mirror->x);
    s.p.y = static_cast<double>(mirror->y);
    s.p.z = static_cast<double>(mirror->z);
    s.v.x = static_cast<double>(mirror->vx);
    s.v.y = static_cast<double>(mirror->vy);
    s.v.z = static_cast<double>(mirror->vz);
    return s;
  }

  /** The inputs this frame sent: their positions (eased from the last one to `pose`; one frame may send
   *  several) with `pose`'s velocity, and one predicted tick each (session.ts afterSend). */
  void AfterPhysicsSend(const std::optional<OwnState>& pose) {
    if (handle == nullptr) return;
    SyncPhysicsSocket();
    SettlePhysicsKeyframe();
    const double now = ServerNowDrawn();
    ownRing.AfterSend(colyseus_input_handle_sent_count(handle), pose, [this, now](double seq) {
      if (predictor) predictor->Advance(seq, now);
    });
  }

  /** Draws `track` into its view at room-clock `at`; `e` is its entity (null while held). */
  void RefreshBodyView(const std::string& id, BodyTrack& track, const aw::AuthorityEntity* e, double at,
                       const bodies::BodyRoom& r) {
    AuthorityEntityView& v = views[id];
    v.id = id;
    if (e != nullptr) {
      v.kind = Str(e->kind);
      v.owner = Str(e->owner);
      v.hp = e->hp;
      v.flags = e->flags;
      v.data = Str(e->data);
    }
    v.isMine = !sid.empty() && v.owner == sid;
    // The host never writes vx vy vz on a body entity: a body's velocity is its own linear velocity in room
    // units per second (lv · lengthUnit, as session.ts draws it). `yaw` is whatever the module wrote,
    // never used to draw the body.
    const bodies::BodyState& latest = track.drawer.State();
    v.vx = latest.lv.x * r.lengthUnit;
    v.vy = latest.lv.y * r.lengthUnit;
    v.vz = latest.lv.z * r.lengthUnit;
    if (e != nullptr) v.yaw = AuthorityWrapAngle(static_cast<double>(e->yaw));
    v.pitch = 0.0;
    v.duck = 0.0;
    v.t0 = 0.0;
    v.isBody = true;
    v.held = e == nullptr;
    v.bodyType = track.type;
    v.bodyKind = track.kind;
    v.colliders = track.colliders;
    // A body the predictor steps is drawn at your present (§17.11 *Drawing*), every other as §17.10 says; a body
    // the room's kinematic rule poses is drawn by the rule even when the predictor does not draw it (§17.11
    // *Kinematic rules*: §17.10's extrapolation would carry it past its stops). Moving between the two drawings
    // eases from where the body was drawn (DrawHandoff), never across an epoch.
    SettlePhysicsKeyframe();
    const std::optional<bodies::Pose> predictedPose = predictor && predictor->Draws(id) ? predictor->Draw(id, at) : std::nullopt;
    const std::optional<bodies::Pose> ruled =
        predictedPose ? std::nullopt : physics::RuledPoseAt(options.kinematicRule, id, at, r.tickHz, r.tickOrigin);
    const bodies::Pose source = predictedPose ? *predictedPose : (ruled ? *ruled : track.drawer.Draw(at, r));
    const bodies::Pose pose = track.handoff.Draw(source, predictedPose.has_value(), latest.epoch, at,
                                                 physics::SnapMetresOf(&track.kind), r.lengthUnit);
    v.predicted = predictedPose.has_value();
    v.x = pose.p.x;
    v.y = pose.p.y;
    v.z = pose.p.z;
    v.qx = pose.q.x;
    v.qy = pose.q.y;
    v.qz = pose.q.z;
    v.qw = pose.q.w;
    v.lvx = latest.lv.x;
    v.lvy = latest.lv.y;
    v.lvz = latest.lv.z;
    v.avx = latest.av.x;
    v.avy = latest.av.y;
    v.avz = latest.av.z;
    v.sleep = latest.sleep;
    v.bodyTick = latest.tick;
    v.epoch = latest.epoch;
    v.serverX = latest.p.x;
    v.serverY = latest.p.y;
    v.serverZ = latest.p.z;
    v.serverYaw = 0.0;
    v.serverEpoch = latest.epoch;
  }

  /** Every body with a received state, drawn at the room clock's present; their ids into `present`. */
  void DrawBodyViews(std::unordered_set<std::string>* present) {
    if (bodyTracks.empty()) return;
    const bodies::BodyRoom r = BodyRoomNow();
    const double at = ServerNowDrawn();
    for (auto& entry : bodyTracks) {
      BodyTrack& track = entry.second;
      if (!track.drawer.HasState()) continue;
      if (present != nullptr) present->insert(entry.first);
      RefreshBodyView(entry.first, track, EntityById(entry.first), at, r);
    }
  }

  AuthorityPhysicsStatus PhysicsNow() {
    AuthorityPhysicsStatus out;
    aw::AuthorityRoomState* st = State();
    out.physics = physicsHash;
    out.roomPhysics = st != nullptr ? Str(st->physics) : std::string();
    out.lengthUnit = st != nullptr ? static_cast<double>(st->lengthUnit) : 0.0;
    const bool mismatch = !out.roomPhysics.empty() && out.roomPhysics != physicsHash;
    out.reason = mismatch ? "physics_mismatch" : "";
    const std::string pair = out.roomPhysics + "/" + physicsHash;
    if (mismatch && warnedPhysics != pair) {
      warnedPhysics = pair;
      Log(LogLevel::Warning, "genex: the room's physics world (hash " + out.roomPhysics +
                                 ") is not this client's (hash " + (physicsHash.empty() ? std::string("none") : physicsHash) +
                                 "): your copy is never stepped from the room's state. Pass your world's physicsHash "
                                 "to SetPhysics().");
    }
    return out;
  }

  // ---------------- own-entity prediction ----------------

  aw::AuthorityEntity* EntityById(const std::string& id) const {
    aw::AuthorityRoomState* st = State();
    if (st == nullptr || st->entities == nullptr) return nullptr;
    return static_cast<aw::AuthorityEntity*>(colyseus_map_schema_get(st->entities, id.c_str()));
  }

  /** A projectile is never your own entity (§17.9), even one a server wrongly gave an owner; nor is a
   *  physics body entity (§17.10: the first owned entity that is neither), so owning a body never makes
   *  it predicted. */
  bool Ownable(const std::string& id, const aw::AuthorityEntity& e) const {
    return !sid.empty() && Str(e.owner) == sid && !IsProjectile(e) && !IsBody(id);
  }

  bool StillOwned(const Own& tracked) const {
    aw::AuthorityEntity* e = EntityById(tracked.id);
    return e != nullptr && e == tracked.entity && e->__base.__refId == tracked.refId && Ownable(tracked.id, *e);
  }

  /** Re-seeds the own entity on its epoch bump and finds (or re-finds) the entity this seat owns. */
  void TrackOwn() {
    if (own && StillOwned(*own)) {
      if (own->entity->epoch != own->epoch) {
        own->epoch = own->entity->epoch;
        if (own->reconciler != nullptr) RespawnOwn();
      }
      return;
    }
    DisposeOwn();  // no longer ours: drawn on the render timeline like any other
    aw::AuthorityRoomState* st = State();
    if (st == nullptr || st->entities == nullptr || sid.empty()) return;
    std::string foundId;
    aw::AuthorityEntity* found = nullptr;
    ForEach(st->entities, [&](const std::string& id, void* value) {
      if (found != nullptr || value == nullptr) return;
      aw::AuthorityEntity* e = static_cast<aw::AuthorityEntity*>(value);
      if (Ownable(id, *e)) {
        found = e;
        foundId = id;
      }
    });
    if (found == nullptr) return;
    Own next;
    next.id = foundId;
    next.entity = found;
    next.refId = found->__base.__refId;
    next.epoch = found->epoch;
    next.drawnEpoch = found->epoch;
    own = std::move(next);
    PredictOwn();
  }

  /** A respawn (an epoch bump on the own entity, §17.3). The server applies every input after the ack
   *  that came with the bump to the NEW life, so those inputs must replay on the new pose, which the
   *  reconciler's next reconcile does (engine-sdks.md "An own respawn is the next reconcile"):
   *  colyseus_reconciler_reset would drop them as a prior life's (20/39/60 visible corrections at
   *  50/150/300 ms in Godot). With nothing in flight there is nothing to replay, so reset is exact. */
  void RespawnOwn() {
    telemetry.reseeds += 1;
    if (colyseus_input_handle_sent_count(handle) - OwnAck() <= 0) {
      colyseus_reconciler_reset(own->reconciler);
      ResetYawRender();
      own->respawning = false;
      own->drawnEpoch = own->entity->epoch;
      return;
    }
    own->respawning = true;  // the snap is the next reconcile: see NoteCorrection
  }

  /** The room's preset as this client knows it, stepping through this client's world. */
  Prediction RoomPrediction() const {
    aw::AuthorityRoomState* st = State();
    return PredictionFor(st != nullptr && st->preset != nullptr ? std::string_view(st->preset) : std::string_view(), world);
  }

  /** The own-entity prediction this client can run now: the game's own (a preset with its parameters,
   *  through this client's world, used as given), else the room's preset when its world (if it has one)
   *  is this client's; unknown otherwise, with why in `blocked`. */
  Prediction PredictionInUse() {
    if (!options.predict) {
      blocked = "off";
      return Prediction();
    }
    if (options.prediction) {
      blocked.clear();
      return options.prediction->WithWorld(world);
    }
    Prediction prediction = RoomPrediction();
    if (!prediction.Known()) {
      blocked = "no_preset";
      return Prediction();
    }
    if (!prediction.WorldMatches()) {
      blocked = "world_mismatch";
      const std::string pair = std::to_string(*prediction.RoomWorld()) + "/" + std::to_string(world->Hash());
      if (warnedMismatch != pair) {
        warnedMismatch = pair;
        Warn(std::string("the room's ") + prediction.Name() + " world (hash " + std::to_string(*prediction.RoomWorld()) +
             ") is not this client's (hash " + std::to_string(world->Hash()) +
             "): your own entity is drawn from the server without prediction. Pass the room module's world to SetWorld().");
      }
      return Prediction();
    }
    blocked.clear();
    return prediction;
  }

  void PredictOwn() {
    if (handle == nullptr || predict == nullptr) return;
    Prediction prediction = PredictionInUse();
    if (!prediction.Known()) return;
    colyseus_reconciler_options_t ro{};
    ro.smooth_ms = -1.0;  // the default: one patch interval
    ro.snap = 0.0;
    ro.fields = prediction.Fields();
    ro.field_count = prediction.FieldCount();
    // Manual pump: the session drains the due steps itself (Drain), calling GenexPresets' step on the
    // mirror; no C-to-C++ callback.
    ro.manual_step = true;
    // On the shadow handle (§17.11 *Input pacing*): it compares your prediction with the state at SteppedAck.
    MirrorShadow();
    colyseus_input_handle_t* input = shadow != nullptr ? shadow : handle;
    colyseus_reconciler_t* r = colyseus_predict_reconciler(predict, &own->entity->__base, &aw::AuthorityEntity_vtable,
                                                           input, nullptr, &ro);
    if (r == nullptr) {
      blocked = "no_preset";
      return;  // drawn on the render timeline like any other
    }
    colyseus_input_handle_set_render_delay(handle, renderDelay);
    own->reconciler = r;
    own->prediction = prediction;
    own->fields.clear();
    for (int i = 0; i < prediction.FieldCount(); ++i) own->fields.emplace_back(prediction.Fields()[i]);
    own->before.assign(own->fields.size(), 0.0);
    own->after.assign(own->fields.size(), 0.0);
    own->yawMirrored = std::find(own->fields.begin(), own->fields.end(), "yaw") != own->fields.end();
    const int patchMs = colyseus_input_handle_patch_rate(handle);
    own->yawSmoothMs = patchMs > 0 ? static_cast<double>(patchMs) : 50.0;  // reconciler.c's default smooth_ms
    own->yawLastTick = NaN();
    own->yawHandleEpoch = colyseus_input_handle_epoch(handle);
    ReplayInFlight();
    ResetYawRender();
  }

  // ---- your own heading, drawn as an angle (Own::yawMirrored; see Own) ----

  double MirrorYaw() const {
    return static_cast<double>(reinterpret_cast<const aw::AuthorityEntity*>(colyseus_reconciler_state(own->reconciler))->yaw);
  }

  /** colyseus_reconciler_reset's render half: prev = the state, no error, the render clock at 0. */
  void ResetYawRender() {
    own->yawPrev = MirrorYaw();
    own->yawErr = 0.0;
    own->yawAcc = 0.0;
  }

  /** reconciler_tick's render half, at the instant colyseus_predict_tick was given: the render clock
   *  advances, and a handle epoch change (the C core resets the handle at a drop) resets. A reset is a
   *  snap, as colyseus_reconciler_reset draws every other field: `yawBefore` becomes the reset's heading,
   *  so SettleYawRender rebases nothing across it (rebasing the reset's jump into the error swung the
   *  drawn heading back toward the pre-drop one and forward again while the car itself was held).
   *  Returns the tick's dt (0 on the first). */
  double TickYawRender(double tickNow, double& yawBefore) {
    const double dt = std::isnan(own->yawLastTick) ? 0.0 : tickNow - own->yawLastTick;
    own->yawLastTick = tickNow;
    if (dt > 0 && colyseus_reconciler_step_ms(own->reconciler) > 0) own->yawAcc += dt;
    const int epoch = colyseus_input_handle_epoch(handle);
    if (epoch != own->yawHandleEpoch) {
      own->yawHandleEpoch = epoch;
      ResetYawRender();
      yawBefore = MirrorYaw();
    }
    return dt > 0 ? dt : 0.0;
  }

  /** The error after this frame's reconcile (if any), rebased so the drawn heading is unchanged at this
   *  instant and folded to the short arc, then decayed by the tick's dt (reconciler.c's order). With no
   *  reconcile, or a matched one, `before` and `after` are the same heading. */
  void SettleYawRender(double beforeYaw, double afterYaw, double dt) {
    own->yawErr = AuthorityWrapAngle(own->yawErr + (beforeYaw - afterYaw));
    if (dt > 0) {
      const double k = own->yawSmoothMs <= 0 ? 1.0 : 1.0 - std::exp(-dt / own->yawSmoothMs);
      own->yawErr -= own->yawErr * k;
    }
  }

  /** Your own heading as the reconciler would render it, interpolated along the short arc. */
  double OwnYaw() const {
    const double stepMs = colyseus_reconciler_step_ms(own->reconciler);
    const double a = stepMs <= 0 ? 1.0 : own->yawAcc / stepMs;
    const double alpha = a < 0 ? 0.0 : a > 1 ? 1.0 : a;
    const double smoothed = MirrorYaw() + own->yawErr;
    return own->yawPrev + AuthorityWrapAngle(smoothed - own->yawPrev) * alpha;
  }

  /** A fresh prediction is the server's pose (the mirror is seeded from it) with the inputs still in
   *  flight replayed on top: the server applies them after the ack that came with that pose, so without
   *  them the prediction would be a round trip behind until the next reconcile, which would then correct
   *  it by all of them at once (session.ts repredict). The reconciler replays the same inputs onto the
   *  next truth at its first reconcile (it counts every input sent before it was made as predicted), so
   *  an exact step makes that reconcile a zero correction. */
  /** Your entity's drawn place now (x y z), as OwnView draws it. */
  std::array<double, 3> OwnDrawnPlace(double now) const {
    const aw::AuthorityEntity* mirror = reinterpret_cast<const aw::AuthorityEntity*>(colyseus_reconciler_state(own->reconciler));
    const auto field = [&](const char* f, double server) {
      if (std::find(own->fields.begin(), own->fields.end(), f) == own->fields.end()) return server;
      return own->reseeded ? FieldOf(*mirror, f) : colyseus_reconciler_value(own->reconciler, f);
    };
    const std::array<double, 3> place{field("x", own->entity->x), field("y", own->entity->y), field("z", own->entity->z)};
    return ShoveEased(place, now);
  }

  /** `place` with what is left of the shove's ease (session.ts timelinePose). */
  std::array<double, 3> ShoveEased(std::array<double, 3> place, double now) const {
    if (!own->shoveEasing) return place;
    const double k = std::exp(-(now - own->shoveAt) / kSeatTauMs);
    return {place[0] + own->shoveDx * k, place[1] + own->shoveDy * k, place[2] + own->shoveDz * k};
  }

  /** Your inputs predicted again from the state after a missed contact (SeatWorld::TakeMissed), the drawing
   *  kept where it was and eased to the new prediction (session.ts shoveRepredict). */
  void ShoveRepredict(double now) {
    const std::array<double, 3> before = OwnDrawnPlace(now);
    colyseus_reconciler_free(own->reconciler);
    own->reconciler = nullptr;
    own->shoveEasing = false;
    PredictOwn();
    if (own->reconciler == nullptr) return;
    ReplayInFlight();
    const std::array<double, 3> after = OwnDrawnPlace(now);
    own->shoveDx = before[0] - after[0];
    own->shoveDy = before[1] - after[1];
    own->shoveDz = before[2] - after[2];
    own->shoveAt = now;
    own->shoveEasing = true;
  }

  void ReplayInFlight() {
    colyseus_reconciler_t* r = own->reconciler;
    aw::AuthorityEntity* mirror = reinterpret_cast<aw::AuthorityEntity*>(colyseus_reconciler_state(r));
    const double dt = OwnStepSeconds();
    const int sent = colyseus_input_handle_sent_count(handle);
    const int ack = SteppedAck();
    const OwnRules rules = OwnRulesNow();
    reseedMissing = 0;
    for (int seq = ack + 1; seq <= sent; ++seq) {
      const aw::AuthorityInput* command = ReplayInput(seq);
      if (command != nullptr) {
        StepOwnInput(own->prediction, *mirror, *command, dt, seq, StateTick(), ack, rules);
      } else {
        reseedMissing += 1;
      }
    }
    own->reseeded = true;
  }

  // ---- the room module's rules in your own prediction (§17.11 *Seat rules*, *Seat contacts*) ----

  /** The step length the reconciler's own steps take (reconciler.c: 1 / the handshake's tick rate, the
   *  server's dt), never stepMs / 1000, which is another double (1000 / 30 / 1000 ≠ 1 / 30). */
  double OwnStepSeconds() const {
    const int rate = colyseus_input_handle_tick_rate(handle);
    return rate > 0 ? 1.0 / static_cast<double>(rate) : colyseus_reconciler_step_ms(own->reconciler) / 1000.0;
  }

  /** The latest state's tick (a seat rule's tick is counted from it). */
  double StateTick() const {
    aw::AuthorityRoomState* st = State();
    return st != nullptr ? st->tick : 0.0;
  }

  /** What one own step needs: the module's seat rule, the seat contacts, your id, the room's tick rate. */
  OwnRules OwnRulesNow() const {
    OwnRules rules;
    rules.seatRule = options.seatRule;
    rules.contacts = HasContacts() ? contacts.get() : nullptr;
    rules.seatWorld = SeatWorldNow();
    rules.ownId = own ? own->id : std::string();
    if (Declared() != nullptr && own && own->entity != nullptr) rules.ownFlags = static_cast<double>(own->entity->flags);
    rules.tickHz = TickHz();
    return rules;
  }

  // ---- `predicted`: other seats predicted on your clock (§17.11 *Drawing other seats*, seat-predict.ts) ----

  /** The room's physDesc, cached per text (it never changes in a room's life); none when it has none. */
  const std::optional<physics::PhysDesc>& SeatDescNow() {
    aw::AuthorityRoomState* st = State();
    const std::string text = st != nullptr ? Str(st->physDesc) : std::string();
    if (text != seatDescText) {
      seatDescText = text;
      seatDesc = physics::ParsePhysDesc(text);
    }
    return seatDesc;
  }

  /** The room preset's step on another seat's body (cached per preset and world), or none. */
  SeatStep SeatStepNow() {
    aw::AuthorityRoomState* st = State();
    const std::string text = st != nullptr ? Str(st->preset) : std::string();
    if (text != seatStepPreset || world->Hash() != seatStepWorld) {
      seatStepPreset = text;
      seatStepWorld = world->Hash();
      const physics::RemoteStep step = PhysicsRemoteStep();
      seatStep = step ? SeatStep(step) : SeatStep();
    }
    return seatStep;
  }

  /** Every other seat in the latest state with its preset fields and its last applied input (session.ts held). */
  std::vector<HeldSeat> HeldSeats() const {
    std::vector<HeldSeat> out;
    aw::AuthorityRoomState* st = State();
    if (st == nullptr || st->entities == nullptr || st->players == nullptr) return out;
    const std::string ownId = own ? own->id : std::string();
    const Prediction roomStep = PredictionFor(st->preset != nullptr ? std::string_view(st->preset) : std::string_view(), world);
    const bool declared = Declared() != nullptr;
    ForEach(st->entities, [&](const std::string& id, void* value) {
      if (value == nullptr || id == ownId) return;
      const aw::AuthorityEntity& e = *static_cast<const aw::AuthorityEntity*>(value);
      const std::string owner = Str(e.owner);
      if (owner.empty() || IsProjectile(e) || IsBody(id)) return;
      const aw::AuthorityPlayer* player = static_cast<const aw::AuthorityPlayer*>(colyseus_map_schema_get(st->players, owner.c_str()));
      if (player == nullptr) return;
      HeldSeat h;
      h.id = id;
      h.epoch = e.epoch;
      for (const char* field : {"x", "y", "z", "vx", "vy", "vz", "yaw", "spin"}) h.body[field] = AuthorityEntityField(e, field);
      if (roomStep.Known()) {
        const char* const* fields = roomStep.Fields();
        for (int i = 0; i < roomStep.FieldCount(); ++i) h.body[fields[i]] = AuthorityEntityField(e, fields[i]);
      }
      if (declared) h.body["flags"] = static_cast<double>(e.flags);
      physics::RemoteInput in;
      in.moveX = static_cast<double>(player->inMoveX);
      in.moveY = static_cast<double>(player->inMoveY);
      in.moveZ = static_cast<double>(player->inMoveZ);
      in.yaw = static_cast<double>(player->inYaw);
      in.pitch = static_cast<double>(player->inPitch);
      in.buttons = player->inButtons;
      h.input = in;
      out.push_back(std::move(h));
    });
    return out;
  }

  SeatWorldOptions SeatWorldOptionsNow() {
    SeatWorldOptions o;
    o.rule = [this](ContactBody& a, ContactBody& b) { ContactRuleNow(a, b); };
    // The module's pass, else (no module rule either) the declared policy's (session.ts contactPassOf).
    if (options.contactPass) {
      o.pass = options.contactPass;
    } else if (!options.contacts) {
      o.pass = [this](std::vector<ContactBody>& seats) {
        if (const DeclaredContacts* d = Declared()) d->Pass(seats);
      };
    }
    o.others = [this] { return HeldSeats(); };
    o.step = [this] { return SeatStepNow(); };
    o.seatRule = options.seatRule;
    o.remote = [this] {
      const std::optional<physics::PhysDesc>& desc = SeatDescNow();
      SeatRemote r;
      r.predict = desc ? desc->remotePredict : physics::RemotePredict::Hold;
      r.decayMs = desc ? desc->remoteDecayMs : 50.0;
      return r;
    };
    o.maxAheadMs = [this] {
      const std::optional<physics::PhysDesc>& desc = SeatDescNow();
      return (desc ? desc->leadMs : 250.0) + kStallPredictMs;
    };
    return o;
  }

  /** Room units per metre: the state's, else the preset's implied one (vehicle 100, firstperson 39.37). */
  double UnitsPerMetre() const {
    aw::AuthorityRoomState* st = State();
    if (st != nullptr && st->lengthUnit > 0) return static_cast<double>(st->lengthUnit);
    const Prediction p = PredictionFor(st != nullptr && st->preset != nullptr ? std::string_view(st->preset) : std::string_view(), world);
    if (p.Known() && std::strcmp(p.Name(), "vehicle") == 0) return 100.0;
    if (p.Known() && std::strcmp(p.Name(), "firstperson") == 0) return 39.37;
    return 1.0;
  }

  /** The input your entity is drawn at, counted from the ack (session.ts drawnInput): between your last two inputs
   *  by the reconciler's render fraction. */
  double DrawnInput() const {
    const double stepMs = colyseus_reconciler_step_ms(own->reconciler);
    const double a = stepMs <= 0 ? 1.0 : own->yawAcc / stepMs;
    // A re-seeded prediction is drawn at its newest input as is (session.ts drawnInput).
    const double alpha = own->reseeded ? 1.0 : a < 0 ? 0.0 : a > 1 ? 1.0 : a;
    const double ack = SteppedAck();
    const double sent = colyseus_input_handle_sent_count(handle);
    return (std::max)(0.0, sent - ack - 1 + alpha);
  }

  /** Every other seat the seat prediction has, drawn at the input your entity is drawn at with its correction
   *  (session.ts predictedPoses): the views' x y z yaw overwritten, `seatPredicted` set, the predicted pose by id
   *  returned. Empty (and DrawTick NaN) when there is no prediction to draw from. */
  std::map<std::string, SeatPose> DrawPredictedSeats(aw::AuthorityRoomState* st, double now) {
    std::map<std::string, SeatPose> out;
    SeatWorld* drawnFrom = SeatWorldDrawn();
    const std::shared_ptr<const SeatPass> pass = drawnFrom != nullptr ? drawnFrom->Current() : nullptr;
    if (pass == nullptr || !own || own->reconciler == nullptr || handle == nullptr) {
      drawTick = drawLead = std::numeric_limits<double>::quiet_NaN();
      return out;
    }
    // Other seats are drawn on a smooth clock of their own (seat-predict.ts seatClock), on the throttled
    // clock's share of its lead (§17.11 *Input pacing*), so the drawing never jumps when an extra input goes out.
    const double stepped = SteppedAck();
    const double drawnPast = DrawnInput();
    const input_repeat::SeatLead lead = input_repeat::SeatLeadClock(stepped, drawnPast, throttle, StepMs(), now);
    // §17.11 *Touching*: a seat touching your entity is drawn at the input your entity is drawn at exactly, blended
    // in and out, so a bump is drawn on both on the same frame.
    const double exact = stepped + drawnPast;
    seatDrawClock = SeatClockNext(seatDrawClock ? &*seatDrawClock : nullptr, lead.raw, lead.at, TickHz());
    const double seq = seatDrawClock->seq;
    const double dtMs = std::isnan(seatOffsetsAt) ? 0.0 : now - seatOffsetsAt;
    seatOffsetsAt = now;
    drawTick = pass->stateTick + (seq - pass->ack);
    drawLead = presets::TickInstant(drawTick + 1, TickOrigin(), TickHz()) - ServerNowDrawn();
    const double snap = kSeatSnapMetres * UnitsPerMetre();
    std::unordered_set<std::string> seen;
    ForEach(st->entities, [&](const std::string& id, void* value) {
      if (value == nullptr || id == own->id) return;
      const aw::AuthorityEntity& e = *static_cast<const aw::AuthorityEntity*>(value);
      const std::string owner = Str(e.owner);
      if (owner.empty() || IsProjectile(e) || IsBody(id) || colyseus_map_schema_get(st->players, owner.c_str()) == nullptr) return;
      auto view = views.find(id);
      if (view == views.end()) return;
      const std::optional<SeatMotion> motion = drawnFrom->MotionAt(id, seq);
      if (!motion) return;
      const SeatPose* at = &motion->pose;
      const auto known = seatOffsets.find(id);
      const SeatOffset* prev = known == seatOffsets.end() ? nullptr : &known->second;
      std::optional<SeatChange> change;
      if (prev != nullptr && prev->pass != nullptr && prev->pass != pass) change = drawnFrom->ChangeAt(id, seq, prev->pass.get());
      const SeatOffset off = SeatOffsetNext(prev, pass, e.epoch, change, *motion, dtMs, drawnFrom->TouchingAt(id, seq), snap, drawnFrom->StateRate(id));
      seatOffsets[id] = off;
      seen.insert(id);
      AuthorityEntityView& v = view->second;
      v.x = at->x + off.dx;
      v.y = at->y + off.dy;
      v.z = at->z + off.dz;
      v.yaw = at->yaw + off.dyaw;
      // §17.11 *Touching*: moved its share of the way from the seat clock's input to your exact one.
      const auto shareKnown = touchShares.find(id);
      const double share = SeatTouchShare(shareKnown == touchShares.end() ? std::nullopt : std::optional<double>(shareKnown->second),
                                          drawnFrom->TouchAheadMs(id, exact).has_value(), dtMs);
      touchShares[id] = share;
      if (share > 0) {
        const std::optional<SeatMotion> there = drawnFrom->MotionAt(id, exact);
        if (there) {
          v.x += (there->pose.x - at->x) * share;
          v.y += (there->pose.y - at->y) * share;
          v.z += (there->pose.z - at->z) * share;
          v.yaw += AuthorityWrapAngle(there->pose.yaw - at->yaw) * share;
        }
      }
      v.yaw = AuthorityWrapAngle(v.yaw);
      v.epoch = e.epoch;
      v.seatPredicted = true;
      out[id] = *at;
    });
    for (auto it = seatOffsets.begin(); it != seatOffsets.end();) it = seen.count(it->first) != 0 ? std::next(it) : seatOffsets.erase(it);
    for (auto it = touchShares.begin(); it != touchShares.end();) it = seen.count(it->first) != 0 ? std::next(it) : touchShares.erase(it);
    return out;
  }

  // ---- §17.11 *Contact policy*: a declared policy runs as the rule, the pass and the drawing guard ----

  /** The policy the state's preset text declares, through this client's world (session.ts declared); none when the
   *  game gave its own rule, or the text declares none. */
  const DeclaredContacts* Declared() const {
    if (options.contacts) return nullptr;
    aw::AuthorityRoomState* st = State();
    const std::string text = st != nullptr ? Str(st->preset) : std::string();
    if (text != declaredText || world->Hash() != declaredWorld) {
      declaredText = text;
      declaredWorld = world->Hash();
      declaredNow = DeclaredContactsOf(text, *world);
    }
    return declaredNow.get();
  }

  /** Whether this room has seat contacts: the module's rule, or a declared policy. */
  bool HasContacts() const { return static_cast<bool>(options.contacts) || Declared() != nullptr; }

  /** The room's contact rule on two seats: the module's, else the declared policy's. */
  void ContactRuleNow(ContactBody& a, ContactBody& b) const {
    if (options.contacts) {
      options.contacts(a, b);
      return;
    }
    if (const DeclaredContacts* d = Declared()) d->Rule(a, b);
  }

  /** How other seats are drawn now: the game's, else the declared policy's (a shooter's on the render timeline,
   *  where §17.5's rewind judges a shot), else Predicted. */
  SeatDrawing SeatDrawingNow() const {
    if (options.seatDrawing) return *options.seatDrawing;
    const DeclaredContacts* d = Declared();
    if (d == nullptr) return SeatDrawing::Predicted;
    switch (d->Policy().drawing) {
      case contact::ContactDrawing::Separate:
        return SeatDrawing::Separate;
      case contact::ContactDrawing::Timeline:
        return SeatDrawing::Timeline;
      case contact::ContactDrawing::Predicted:
        break;
    }
    return SeatDrawing::Predicted;
  }

  /** The seat prediction while the room has seat contacts: your contacts and the physics replay's seats come from
   *  it whatever the drawing. */
  SeatWorld* SeatWorldNow() const { return HasContacts() ? seatWorld.get() : nullptr; }
  /** The seat prediction other seats are drawn from: only when they are drawn on your clock. */
  SeatWorld* SeatWorldDrawn() const { return SeatDrawingNow() == SeatDrawing::Predicted ? SeatWorldNow() : nullptr; }

  /** The rule the drawing runs against your entity `you`: a declared policy's with yours fixed (a seat by a wall is
   *  moved along it, never into it), else the room's (session.ts drawingRule). */
  ContactRule DrawingRule(const std::string& you) const {
    if (options.contacts) return options.contacts;
    std::shared_ptr<const DeclaredContacts> d = Declared() != nullptr ? declaredNow : nullptr;
    if (d == nullptr) return ContactRule();
    return [d, you](ContactBody& a, ContactBody& b) { d->DrawRule(you, a, b); };
  }

  /** Every other seat's own entity in the latest state (session.ts otherSeats): owned, not a projectile,
   *  not a body, its owner a seated player, not yours. */
  std::vector<ContactBody> OtherSeats() const {
    std::vector<ContactBody> out;
    aw::AuthorityRoomState* st = State();
    if (st == nullptr || st->entities == nullptr) return out;
    // A declared policy's pair rules read each seat's `flags` (session.ts withFlags).
    const bool declared = Declared() != nullptr;
    const std::string ownId = own ? own->id : std::string();
    ForEach(st->entities, [&](const std::string& id, void* value) {
      if (value == nullptr || id == ownId) return;
      const aw::AuthorityEntity& e = *static_cast<const aw::AuthorityEntity*>(value);
      const std::string owner = Str(e.owner);
      if (owner.empty() || IsProjectile(e) || IsBody(id)) return;
      if (st->players == nullptr || colyseus_map_schema_get(st->players, owner.c_str()) == nullptr) return;
      ContactBody b;
      b.id = id;
      b.x = static_cast<double>(e.x);
      b.y = static_cast<double>(e.y);
      b.z = static_cast<double>(e.z);
      b.vx = static_cast<double>(e.vx);
      b.vy = static_cast<double>(e.vy);
      b.vz = static_cast<double>(e.vz);
      b.yaw = static_cast<double>(e.yaw);
      b.spin = static_cast<double>(e.spin);
      if (declared) b.flags = static_cast<double>(e.flags);
      out.push_back(std::move(b));
    });
    return out;
  }

  /** Your entity after each input in flight (ack + 1 … sent), stepped afresh from the server's state of it
   *  (session.ts ownPath, §17.11 *The client world*); empty without a prediction. */
  std::vector<std::pair<double, OwnState>> OwnPathNow() const {
    if (!own || own->reconciler == nullptr || handle == nullptr || own->entity == nullptr) return {};
    const SentInputAt inputAt = [this](int seq) { return ReplayInput(seq); };
    return OwnPath(own->prediction, *own->entity, SteppedAck(), colyseus_input_handle_sent_count(handle), inputAt, OwnStepSeconds(),
                   StateTick(), OwnRulesNow());
  }

  /** Input `seq` (just sent on `handle`) kept until your inputs' ack passes it, at most the handle's ring of them;
   *  a new socket's inputs count from 1 again, so its first send starts the copy afresh. */
  void KeepSent(int seq, const aw::AuthorityInput& input) {
    const int epoch = colyseus_input_handle_epoch(handle);
    if (epoch != sentSinceAckEpoch) {
      sentSinceAck.clear();
      sentSinceAckEpoch = epoch;
    }
    aw::AuthorityInput copy{};
    copy.moveX = input.moveX;
    copy.moveY = input.moveY;
    copy.moveZ = input.moveZ;
    copy.yaw = input.yaw;
    copy.pitch = input.pitch;
    copy.buttons = input.buttons;
    copy.tick = input.tick;
    sentSinceAck.emplace_back(seq, copy);
    const int ack = OwnAck();
    const auto ring = static_cast<std::size_t>((std::max)(1, colyseus_input_handle_replay_buffer_size(handle)));
    while (!sentSinceAck.empty() && (sentSinceAck.front().first <= ack || sentSinceAck.size() > ring)) sentSinceAck.pop_front();
  }

  /** The kept copy of input `seq` (KeepSent), or null. */
  const aw::AuthorityInput* KeptInput(int seq) const {
    if (sentSinceAck.empty() || sentSinceAckEpoch != colyseus_input_handle_epoch(handle)) return nullptr;
    const int first = sentSinceAck.front().first;
    if (seq < first || seq - first >= static_cast<int>(sentSinceAck.size())) return nullptr;
    return &sentSinceAck[static_cast<std::size_t>(seq - first)].second;
  }

  /** Input `seq` for a replay: the handle's, else the fast channel's copy (session.ts inputAt, Unity's ReplayInput),
   *  else the session's own copy of what was sent after your inputs' ack (KeptInput). On a fast seat this handle lets
   *  go of the inputs its WebSocket ack counted, which the server dropped unread: the frames stay unmuted
   *  (GenexFastSeat.h), so its ack does not stand still as the reference's does. The channel's copy keeps only from the
   *  server's received ack or the newest 170 ms, and a replay starts at the stepped ack, so past that round trip what
   *  the server received and has not stepped is in neither. The kept copy holds it. Not the shadow's ring: the shadow
   *  lets go at `ack + inRep`, which can move back. Until the channel's first record of your seat (a round trip after
   *  the binding) the ack stands at the binding's while `inRep` is the WebSocket's, and a repeat the server pays back
   *  lowers it (CI run 42540365191: ack 5, inRep 2 then 1, input 7 in no copy for four frames).
   *  A copy lives in `replayCopy` until the next call, so read it at once. */
  const aw::AuthorityInput* ReplayInput(int seq) const {
    const aw::AuthorityInput* real = reinterpret_cast<const aw::AuthorityInput*>(colyseus_input_handle_at(handle, seq));
    if (real != nullptr || fastSeat == nullptr) return real;
    const fast::FastInput* held = fastSeat->InputAt(seq);
    if (held == nullptr) return KeptInput(seq);
    replayCopy.moveX = held->input.moveX;
    replayCopy.moveY = held->input.moveY;
    replayCopy.moveZ = held->input.moveZ;
    replayCopy.yaw = held->input.yaw;
    replayCopy.pitch = held->input.pitch;
    replayCopy.buttons = held->input.buttons;
    replayCopy.tick = held->tick;
    return &replayCopy;
  }
  mutable aw::AuthorityInput replayCopy{};

  /** See AuthoritySession::ReseedMissing. */
  int reseedMissing = 0;

  /** Inputs in flight OwnPathNow could not step (see AuthoritySession::OwnPathMissing). */
  int OwnPathMissing() const {
    if (!own || own->reconciler == nullptr || handle == nullptr) return 0;
    const int inFlight = colyseus_input_handle_sent_count(handle) - SteppedAck();
    return inFlight > 0 ? inFlight - static_cast<int>(OwnPathNow().size()) : 0;
  }

  /** A new prediction for the own entity (the world changed): the old reconciler is dropped and a fresh
   *  one seeded from the server's pose, or none when this client cannot predict now. */
  void RepredictOwn() {
    if (!own) return;
    if (own->reconciler != nullptr) colyseus_reconciler_free(own->reconciler);
    own->reconciler = nullptr;
    own->respawning = false;
    own->reseeded = false;
    own->drawnEpoch = own->entity->epoch;
    own->snapUntil = -std::numeric_limits<double>::infinity();
    if (closed || !StillOwned(*own)) {
      DisposeOwn();
      return;
    }
    PredictOwn();  // not a re-seed in the telemetry's sense (a respawn, a reconnect), as session.ts counts
  }

  std::uint32_t SetWorld(FirstpersonWorldPtr next) {
    if (next == nullptr) next = FirstpersonWorld::Empty();
    const bool changed = next->Hash() != world->Hash();
    world = std::move(next);
    // Same hash: the same world, value for value; nothing to re-seed.
    if (changed && own && joined && !closed) RepredictOwn();
    return world->Hash();
  }

  AuthorityPredictionStatus PredictionNow() const {
    AuthorityPredictionStatus out;
    out.predicting = own && own->reconciler != nullptr;
    out.reason = out.predicting ? std::string() : own ? blocked : !options.predict ? std::string("off") : std::string("no_entity");
    out.world = world->Hash();
    out.roomWorld = RoomPrediction().RoomWorld();
    return out;
  }

  /** The limit drawn pitches are held to: the room's firstperson pitchLimit as float32, else π. */
  double PitchLimit() {
    aw::AuthorityRoomState* st = State();
    const char* text = st != nullptr && st->preset != nullptr ? st->preset : "";
    if (pitchLimitText != text) {
      pitchLimitText = text;
      pitchLimitValue = PredictionFor(pitchLimitText).PitchLimit();
    }
    return pitchLimitValue;
  }

  /** Run every step the reconciler has due: a reconcile's replay, then the live catch-up. */
  void Drain() {
    colyseus_reconciler_t* r = own->reconciler;
    aw::AuthorityEntity* mirror = reinterpret_cast<aw::AuthorityEntity*>(colyseus_reconciler_state(r));
    const OwnRules rules = OwnRulesNow();
    while (colyseus_reconciler_pump_begin(r) > 0) {
      const colyseus_step_ctx_t* ctx = nullptr;
      const colyseus_schema_t* cmd = nullptr;
      while ((cmd = colyseus_reconciler_pump_next(r, &ctx)) != nullptr) {
        const bool live = !ctx->is_replay;
        // A live step: the render's prev is the state before it (reconciler.c snapshot_prev).
        if (live) own->yawPrev = static_cast<double>(mirror->yaw) + own->yawErr;
        // The input exactly as sent, sanitized as the server sanitizes it before its own step (inside
        // Prediction::Step), and the fixed dt the core derives from the room's tick rate.
        // The room module's seat rule before it and its seat contacts after it (§17.11; StepOwnInput).
        StepOwnInput(own->prediction, *mirror, *reinterpret_cast<const aw::AuthorityInput*>(cmd), ctx->dt, ctx->tick, StateTick(),
                     SteppedAck(), rules);
        colyseus_reconciler_pump_commit(r);
        if (live) {
          // consume_render_step: one step of the render clock, resynced into [0, stepMs).
          const double stepMs = colyseus_reconciler_step_ms(r);
          own->yawAcc -= stepMs;
          if (own->yawAcc < 0) {
            own->yawAcc = 0;
          } else if (own->yawAcc >= stepMs) {
            own->yawAcc = std::fmod(own->yawAcc, stepMs);
          }
        }
      }
      colyseus_reconciler_pump_end(r);
    }
  }

  /** The predicted state (the mirror), no correction offset. */
  void PredictedPose(std::vector<double>& into) const {
    const aw::AuthorityEntity* mirror =
        reinterpret_cast<const aw::AuthorityEntity*>(colyseus_reconciler_state(own->reconciler));
    for (std::size_t i = 0; i < own->fields.size(); ++i) into[i] = FieldOf(*mirror, own->fields[i]);
  }

  // Correction telemetry, measured as the TS and Unity sessions do (Godot reads the core's
  // last_correction_mag, which also carries the previous correction's undecayed offset): the
  // predicted state's jump across the reconcile, 0 when the prediction matched; a heading by the
  // short arc.
  void NoteCorrection(int seqBefore, double now) {
    colyseus_reconciler_t* r = own->reconciler;
    if (colyseus_reconciler_reconcile_seq(r) == seqBefore) return;
    if (own->respawning) {
      // The reconcile that adopted the new life: a snap, not a correction (kRespawnSnapTaus).
      own->respawning = false;
      own->drawnEpoch = own->entity->epoch;
      const int patchMs = colyseus_input_handle_patch_rate(handle);
      const double tau = patchMs > 0 ? static_cast<double>(patchMs) : kRespawnSnapFallbackTauMs;
      own->snapUntil = now + kRespawnSnapTaus * tau;
      own->snapPrev.clear();
      own->snapCur.clear();
      return;
    }
    PredictedPose(own->after);
    const AuthorityCorrectionSizes sizes = AuthorityCorrectionsOf(own->fields, own->before, own->after);
    telemetry.reconciles += 1;
    telemetry.lastCorrection = sizes.place;
    telemetry.peakCorrection = (std::max)(telemetry.peakCorrection, sizes.place);
    telemetry.peakStateCorrection = (std::max)(telemetry.peakStateCorrection, sizes.state);
    if (AuthorityVisibleCorrection(sizes.place, UnitsPerMetre())) telemetry.visibleCorrections += 1;
  }

  double StepMs() const {
    const int rate = handle != nullptr ? colyseus_input_handle_tick_rate(handle) : 0;
    return rate > 0 ? 1000.0 / static_cast<double>(rate)
                    : 1000.0 / static_cast<double>(protocol::authority_timing::kTickHz);
  }

  /** Input pacing without a reconciler (the core paces only once one exists). */
  int OwnPace(double now) {
    if (handle == nullptr || colyseus_input_handle_tick_rate(handle) <= 0) return 0;
    const double stepMs = StepMs();
    if (std::isnan(paceFrom)) {
      paceFrom = now;
      return 0;
    }
    const int due = static_cast<int>(std::floor((now - paceFrom) / stepMs));
    if (due > kMaxCatchUpSteps) {
      paceFrom = now;
      return kMaxCatchUpSteps;
    }
    paceFrom += static_cast<double>(due) * stepMs;
    return due;
  }

  int SendSteps(int due, const Input& staged) {
    if (due <= 0) return 0;
    if (!connected || handle == nullptr) {
      telemetry.inputsDropped += due;
      return 0;
    }
    aw::AuthorityInput* data = reinterpret_cast<aw::AuthorityInput*>(colyseus_input_handle_data(handle));
    int sent = 0;
    for (int i = 0; i < due; ++i) {
      staged.WriteSanitized(*data);
      const int seq = colyseus_input_handle_send(handle);
      if (seq > 0) {
        sent += 1;
        // §17.12: while the fast channel is live the input also goes by datagram (the same wire input).
        if (fastSeat != nullptr) fastSeat->Sent(seq, InputTickField(data->tick), Input::FromWire(*data), FastRenderStamp());
        KeepSent(seq, *data);
      } else {
        telemetry.inputsDropped += 1;
      }
    }
    telemetry.inputsSent += sent;
    if (fastSeat != nullptr) fastSeat->Flush();
    MirrorShadow();
    return sent;
  }

  int Frame(double now, const Input& staged) {
    if (!joined || closed || predict == nullptr) return 0;
    // §17.12: a fast channel past its deadline falls back before this frame's sends.
    if (fastSeat != nullptr) fastSeat->Poll();
    AnnounceTransport(now);
    // The newest keyframe of what arrived, adopted once before this frame's inputs go (§17.11 *A burst of keyframes*).
    SettlePhysicsKeyframe();
    // Everything this frame draws is drawn at `now`, the frame's instant (FrameLag).
    frameAt = now;
    framing = true;
    struct Unframe {
      bool& framing;
      ~Unframe() { framing = false; }
    } unframe{framing};
    TrackOwn();
    colyseus_reconciler_t* r = own ? own->reconciler : nullptr;
    const int seqBefore = r != nullptr ? colyseus_reconciler_reconcile_seq(r) : 0;
    if (r != nullptr) PredictedPose(own->before);
    double yawBefore = r != nullptr ? MirrorYaw() : 0.0;
    const double tickNow = colyseus_room_clock_now(colyseus_room_get_clock(room));
    // The reconciler polls the shadow's ack inside the tick: it follows the state first.
    MirrorShadow();
    const int extra = ThrottleExtra(now);
    const int due = colyseus_predict_tick(predict, tickNow) + extra;
    ExpireShots(tickNow);
    int sent = 0;
    if (r == nullptr) {
      sent = SendSteps(OwnPace(now) + extra, staged);
      AfterPhysicsSend(std::nullopt);
    } else {
      paceFrom = NaN();
      const double tickDt = TickYawRender(tickNow, yawBefore);
      Drain();  // the reconcile the tick found: adopt + replay (before this frame's sends)
      SettleYawRender(yawBefore, MirrorYaw(), tickDt);
      NoteCorrection(seqBefore, now);
      sent = SendSteps(due, staged);
      Drain();  // the live steps of this frame's sends
      AfterPhysicsSend(OwnPosition());
      // A stepped reconciler renders from the re-seeded pose on: draw through it again.
      if (sent > 0) own->reseeded = false;
      // §17.11 *Seat contacts* (session.ts): a state that put your inputs in flight on later ticks had the
      // seat prediction find a contact in an input your entity was already stepped through without it: your
      // inputs are predicted again from the state, your drawing eased from where it was.
      if (seatWorld != nullptr && !seatWorld->TakeMissed().empty() && own && own->reconciler != nullptr) ShoveRepredict(now);
    }
    BecameReady(now);
    RefreshViews(now);
    return sent;
  }

  // ---------------- every entity but the predicted own one: drawn on the render timeline ----------------
  // Others are drawn renderDelay behind, interpolated between the server-stamped patches this session
  // notes (NotePatches), at the render time the TS session and the server's rewind use: serverNow -
  // renderDelay - rtt/2. So what is drawn is what a lag-compensated shot is judged against (§17.5). Godot
  // style, not the core's lerp: SPIKE.md "The C core's lerp" has the measurement and the decision.
  //
  // A respawn (an epoch bump) is a snap on that same render timeline (§17.3: a bump means snap, never
  // lerp): until the render time reaches the patch that carried the bump, the old life is drawn, held at
  // its last patch across that last patch interval, and the view reports the old epoch.

  /** The respawn the render time has not reached yet, if any (those it passed are dropped). */
  static Respawn* PendingRespawn(Remote& remote, double renderTime) {
    std::vector<Respawn>& respawns = remote.respawns;
    while (!respawns.empty() && renderTime >= respawns.front().at) respawns.erase(respawns.begin());
    return respawns.empty() ? nullptr : &respawns.front();
  }

  /** Where entity `id` is drawn this frame (before the spring), and the epoch of the life that is. */
  AuthorityPose Drawn(const std::string& id, const aw::AuthorityEntity& e, double renderTime, double* epoch) {
    // §17.11 *Drawing other seats*: in a predicting room, from the keyframe samples on the tick timeline
    // (never your own entity), which hold the old life until the new one's first sample. The epoch drawn
    // is the sample's life, so the output spring snaps on the very frame the pose changes life.
    if ((!own || own->id != id) && DrawsOnTicks()) {
      if (const std::optional<TickDrawn> drawn = ticked.At(id, renderTime)) {
        *epoch = drawn->life;
        AuthorityPose pose;
        pose.t = renderTime;
        pose.x = drawn->pose.x;
        pose.y = drawn->pose.y;
        pose.z = drawn->pose.z;
        pose.yaw = drawn->pose.yaw;
        pose.pitch = drawn->pose.pitch;
        pose.duck = drawn->pose.duck;
        return pose;
      }
    }
    auto it = remotes.find(id);
    if (it == remotes.end() || it->second.entity != &e.__base) {
      *epoch = e.epoch;
      return PoseOf(e, renderTime);
    }
    Respawn* respawn = PendingRespawn(it->second, renderTime);
    const std::vector<AuthorityPose>& history = respawn != nullptr ? respawn->history : it->second.history;
    *epoch = respawn != nullptr ? respawn->epoch : e.epoch;
    if (history.empty()) return PoseOf(e, renderTime);
    return AuthoritySample(history, renderTime);
  }

  /** The output spring (remoteSmoothMs, display only): eases toward the render-time pose within a life,
   *  never across a respawn. 0 draws exactly what a shot is judged against. */
  AuthorityPose Smoothed(const std::string& id, const AuthorityPose& target, double epoch, double now) {
    auto it = springs.find(id);
    const bool has = it != springs.end();
    const AuthorityPose last = has ? it->second.pose : AuthorityPose();
    const double lastEpoch = has ? it->second.epoch : 0.0;
    const AuthorityPose out =
        AuthoritySpringStep(target, epoch, has, last, lastEpoch, has ? now - it->second.at : 0.0, options.remoteSmoothMs);
    Spring s;
    s.pose = out;
    s.epoch = epoch;
    s.at = now;
    springs[id] = s;
    return out;
  }

  /** The own entity's pose just after a respawn: its predicted state (no correction offset), eased from
   *  the previous fixed step to the latest over one step, as the reconciler's own render does. */
  AuthorityPose SnapPose(const AuthorityPose& base, double now) {
    std::vector<double> cur(own->fields.size(), 0.0);
    PredictedPose(cur);
    if (own->snapCur.empty() || cur != own->snapCur) {
      own->snapPrev = own->snapCur.empty() ? cur : own->snapCur;
      own->snapCur = cur;
      own->snapAt = now;
    }
    const double u = (std::min)((std::max)((now - own->snapAt) / StepMs(), 0.0), 1.0);
    AuthorityPose out = base;
    for (std::size_t i = 0; i < own->fields.size(); ++i) {
      const double a = own->snapPrev[i];
      const double b = own->snapCur[i];
      SetPoseField(out, own->fields[i], IsAngle(own->fields[i]) ? a + ShortArc(a, b) * u : a + (b - a) * u);
    }
    return out;
  }

  void RefreshViews(double now) {
    aw::AuthorityRoomState* st = ready ? State() : nullptr;
    std::unordered_set<std::string> present;
    if (st != nullptr && st->entities != nullptr) {
      const double renderTime = RenderTime();
      ForEach(st->entities, [&](const std::string& id, void* value) {
        if (value == nullptr) return;
        aw::AuthorityEntity& e = *static_cast<aw::AuthorityEntity*>(value);
        if (IsProjectile(e)) return;  // drawn from its flight, below
        if (IsBody(id)) return;       // drawn at the server's present, below
        present.insert(id);
        RefreshView(id, e, renderTime, now);
      });
      SeparateSeats(st, now);
      DrawBodyViews(&present);
    }
    for (auto it = views.begin(); it != views.end();) {
      if (!it->second.IsProjectile() && present.count(it->first) == 0) {
        springs.erase(it->first);
        probes.erase(it->first);
        sides.erase(it->first);
        it = views.erase(it);
      } else {
        ++it;
      }
    }
    if (st != nullptr) {
      DrawProjectileViews(st, ReadClock());
    } else {
      DrawProjectileViews(nullptr, AuthorityServerClock());
    }
    RefreshPlayers();
  }

  /** A seat not drawn against yours for longer than this (ms: a stalled player) is separated afresh, not
   *  taken round your entity from where it was drawn then (session.ts SIDE_STALE_MS). */
  static constexpr double kSideStaleMs = 250.0;

  /**
   * §17.11 *Drawing other seats* (session.ts nearSeats), with a contact rule and your prediction: every other seat's
   * own entity (owned by a seated player, not a projectile, not a body), on your clock (`predicted`, where the seat
   * prediction has it, with its correction: DrawPredictedSeats) or as RefreshView drew it on the render timeline
   * (`separate`), then moved out of your drawn entity by the contact rule and taken round it, never across it, and
   * out of each other (SeparateSeats). Draw-only: the state and your entity are unchanged. Without your prediction
   * the seats are drawn on the timeline and the memory is dropped. A seat's (or pair's) memory is forgotten when a
   * life on either side changed since, or when it is older than kSideStaleMs.
   */
  void SeparateSeats(aw::AuthorityRoomState* st, double now) {
    const bool draws = HasContacts() && SeatDrawingNow() != SeatDrawing::Timeline;
    const auto mine = own ? views.find(own->id) : views.end();
    if (!draws || st->players == nullptr || !own || own->reconciler == nullptr || own->entity == nullptr || mine == views.end()) {
      sides.clear();
      drawTick = drawLead = std::numeric_limits<double>::quiet_NaN();
      return;
    }
    const bool onYourClock = SeatWorldDrawn() != nullptr;
    const std::map<std::string, SeatPose> predicted = onYourClock ? DrawPredictedSeats(st, now) : std::map<std::string, SeatPose>();
    if (!onYourClock) drawTick = drawLead = std::numeric_limits<double>::quiet_NaN();
    const bool declared = Declared() != nullptr;
    ContactBody you;
    you.id = own->id;
    you.x = mine->second.x;
    you.y = mine->second.y;
    you.z = mine->second.z;
    you.yaw = mine->second.yaw;
    const std::string ownLife = std::to_string(own->entity->epoch);
    std::vector<ContactBody> seats;
    std::map<std::string, std::string> lives;
    std::map<std::string, double> epochs;
    ForEach(st->entities, [&](const std::string& id, void* value) {
      if (value == nullptr || id == own->id) return;
      const aw::AuthorityEntity& e = *static_cast<const aw::AuthorityEntity*>(value);
      const std::string owner = Str(e.owner);
      if (owner.empty() || IsProjectile(e) || IsBody(id)) return;
      if (colyseus_map_schema_get(st->players, owner.c_str()) == nullptr) return;
      auto view = views.find(id);
      if (view == views.end()) return;
      const AuthorityEntityView& v = view->second;
      ContactBody seat;
      seat.id = id;
      seat.x = v.x;
      seat.y = v.y;
      seat.z = v.z;
      seat.yaw = v.yaw;
      if (declared) seat.flags = static_cast<double>(e.flags);
      seats.push_back(seat);
      epochs[id] = v.epoch;
      lives[id] = ownLife + "/" + std::to_string(v.epoch);
    });
    for (const auto& [a, ea] : epochs) {
      for (const auto& [b, eb] : epochs) {
        if (a < b) lives[SeatPairKey(a, b)] = std::to_string(ea) + "/" + std::to_string(eb);
      }
    }
    std::map<std::string, SeatSide> prev;
    for (const auto& [key, life] : lives) {
      const auto known = sides.find(key);
      if (known != sides.end() && known->second.lives == life && now - known->second.side.at <= kSideStaleMs) prev[key] = known->second.side;
    }
    const SeparatedSeats out = genex::SeparateSeats(DrawingRule(you.id), you, seats, prev, now);
    sides.clear();
    for (const auto& [key, side] : out.sides) {
      DrawnSide d;
      d.side = side;
      const auto life = lives.find(key);
      d.lives = life == lives.end() ? std::string() : life->second;
      sides[key] = d;
    }
    for (const auto& [id, p] : out.drawn) {
      auto view = views.find(id);
      if (view == views.end()) continue;
      AuthorityEntityView& v = view->second;
      v.x = p.x;
      v.y = p.y;
      v.z = p.z;
      const auto at = predicted.find(id);
      if (at != predicted.end()) v.correction = std::hypot(p.x - at->second.x, p.y - at->second.y, p.z - at->second.z);
    }
  }

  void RefreshView(const std::string& id, aw::AuthorityEntity& e, double renderTime, double now) {
    AuthorityEntityView& v = views[id];
    if (v.isBody) v = AuthorityEntityView();  // a body no longer (its descriptor removed): an ordinary entity
    v.seatPredicted = false;
    v.correction = 0.0;
    v.id = id;
    v.kind = Str(e.kind);
    v.owner = Str(e.owner);
    v.isMine = !sid.empty() && v.owner == sid;
    v.vx = static_cast<double>(e.vx);
    v.vy = static_cast<double>(e.vy);
    v.vz = static_cast<double>(e.vz);
    v.hp = e.hp;
    v.flags = e.flags;
    v.data = Str(e.data);
    v.serverX = static_cast<double>(e.x);
    v.serverY = static_cast<double>(e.y);
    v.serverZ = static_cast<double>(e.z);
    v.serverYaw = static_cast<double>(e.yaw);
    v.serverEpoch = e.epoch;
    double drawnEpoch = e.epoch;
    const AuthorityPose timeline = Drawn(id, e, renderTime, &drawnEpoch);
    if (options.probeCoreLerp) Probe(id, e, timeline, renderTime);
    const bool predicted = own && own->entity == &e && own->reconciler != nullptr;
    if (predicted) {
      // Fields the prediction does not mirror are drawn on the timeline (Godot _view).
      AuthorityPose pose = timeline;
      const aw::AuthorityEntity* mirror =
          reinterpret_cast<const aw::AuthorityEntity*>(colyseus_reconciler_state(own->reconciler));
      if (now < own->snapUntil) {
        pose = SnapPose(timeline, now);
      } else if (own->reseeded) {
        for (const std::string& field : own->fields) SetPoseField(pose, field, FieldOf(*mirror, field));
      } else {
        for (const std::string& field : own->fields) {
          if (NotAPlace(field)) continue;
          SetPoseField(pose, field, field == "yaw" ? OwnYaw() : colyseus_reconciler_value(own->reconciler, field.c_str()));
        }
      }
      const std::array<double, 3> place = ShoveEased({pose.x, pose.y, pose.z}, now);
      if (own->shoveEasing && std::exp(-(now - own->shoveAt) / kSeatTauMs) *
                                      (std::max)({std::abs(own->shoveDx), std::abs(own->shoveDy), std::abs(own->shoveDz)}) <
                                  kShoveEaseDone) {
        own->shoveEasing = false;
      }
      v.x = place[0];
      v.y = place[1];
      v.z = place[2];
      v.yaw = AuthorityWrapAngle(pose.yaw);
      v.pitch = AuthorityDrawnPitch(pose.pitch, PitchLimit());
      v.duck = Clamp01(pose.duck);
      // The movement bits are the predicted state's (never interpolated), when the step mirrors them.
      const auto mirrored = [&](const char* field) {
        return std::find(own->fields.begin(), own->fields.end(), field) != own->fields.end();
      };
      v.mstate = mirrored("mstate") ? mirror->mstate : e.mstate;
      v.cap = static_cast<double>(e.cap);
      // A vehicle's yaw rate and fuel: the predicted state's, never interpolated (session.ts drawnLatest).
      v.spin = mirrored("spin") ? static_cast<double>(mirror->spin) : static_cast<double>(e.spin);
      v.fuel = mirrored("fuel") ? static_cast<double>(mirror->fuel) : static_cast<double>(e.fuel);
      v.epoch = own->drawnEpoch;
      springs.erase(id);
      return;
    }
    const AuthorityPose shown = Smoothed(id, timeline, drawnEpoch, now);
    v.x = shown.x;
    v.y = shown.y;
    v.z = shown.z;
    v.yaw = AuthorityWrapAngle(shown.yaw);
    v.pitch = AuthorityDrawnPitch(shown.pitch, PitchLimit());
    v.duck = Clamp01(shown.duck);
    v.mstate = e.mstate;
    v.cap = static_cast<double>(e.cap);
    v.spin = static_cast<double>(e.spin);
    v.fuel = static_cast<double>(e.fuel);
    v.epoch = drawnEpoch;
  }

  void Probe(const std::string& id, aw::AuthorityEntity& e, const AuthorityPose& timeline, double renderTime) {
    AuthorityRemoteProbe& p = probes[id];
    p.timelineX = timeline.x;
    p.timelineY = timeline.y;
    p.coreX = predict != nullptr ? colyseus_predict_value(predict, &e.__base, "x") : NaN();
    p.coreY = predict != nullptr ? colyseus_predict_value(predict, &e.__base, "y") : NaN();
    p.renderTime = renderTime;
    p.vx = static_cast<double>(e.vx);
    p.vy = static_cast<double>(e.vy);
    auto it = remotes.find(id);
    p.steady = it != remotes.end() && it->second.respawns.empty() && it->second.history.size() >= 2;
    p.newestPatch = it != remotes.end() && !it->second.history.empty() ? it->second.history.back().t : 0.0;
  }

  // ---------------- the frame driver ----------------

  /** Free a room for good. Its callbacks are detached first: colyseus_room_free closes a transport that
   *  is still open (a stalled reconnect handshake, after a leave) and that close reports on_leave
   *  synchronously, which would queue the freed room again (measured: a double free when Leave() ran
   *  during a stalled handshake). Anything it already queued is dropped too. */
  void FreeRoom(colyseus_room_t* dead) {
    for (std::unique_ptr<Ctx>& ctx : ctxs) {
      if (ctx->room == dead) ctx->impl = nullptr;
    }
    raw.erase(std::remove_if(raw.begin(), raw.end(), [dead](const Raw& item) { return item.room == dead; }), raw.end());
    colyseus_room_free(dead);
  }

  void Update(double now) {
    // The poll is over: the fast channel's values go back before anything reads the state.
    CoverFast();
    std::vector<colyseus_room_t*> dead;
    dead.swap(graveyard);
    for (colyseus_room_t* r : dead) FreeRoom(r);
    while (!raw.empty()) {
      Raw item = std::move(raw.front());
      raw.pop_front();
      Process(item, now);
    }
    if (probe) FinishProbe(now);
    // §17.12: the snapshots the fast channel's socket received (each runs the state pass a patch runs).
    if (fastSeat != nullptr && joined && !closed) fastSeat->Receive();
    if (retryAt >= 0.0 && now >= retryAt && !closed) {
      retryAt = -1.0;
      JoinRoom();
    }
    if (awaitingResync && now > resyncDeadline) FinishResync();
    if (room != nullptr && joined && !connected && !awaitingResync && !closed) UnstickReconnect(now);
    if (joined && !ready && !closed) BecameReady(now);  // the warm-up deadline also passes without Frame()
  }

  ~Impl() {
    for (std::unique_ptr<Ctx>& ctx : ctxs) ctx->impl = nullptr;
    DisposePrediction();
    DisposeShots();
    if (room != nullptr) {
      colyseus_room_leave(room, true);
      colyseus_room_free(room);
    }
    for (colyseus_room_t* r : leavingRooms) colyseus_room_free(r);
    for (colyseus_room_t* r : graveyard) colyseus_room_free(r);
    // A matchmake or latency request still out keeps its userdata: the callback then finds no session
    // and leaves the room it brings. Those few bytes are never freed.
    for (std::unique_ptr<Ctx>& ctx : ctxs) {
      if (ctx->inFlight) (void)ctx.release();
    }
    ctxs.clear();
    for (const auto& old : oldClients) {
      colyseus_client_free(old.second);
      colyseus_settings_free(old.first);
    }
    if (client != nullptr) colyseus_client_free(client);
    if (settings != nullptr) colyseus_settings_free(settings);
  }
};

// ---- the C callbacks: they only copy data into the queue (and note patches) ----

void Push(Ctx* ctx, RawKind kind, Raw item = Raw()) {
  item.kind = kind;
  item.gen = ctx->gen;
  item.room = ctx->room;
  ctx->impl->raw.push_back(std::move(item));
}

void CbJoin(void* ud) {
  Ctx* ctx = static_cast<Ctx*>(ud);
  if (ctx->impl != nullptr) Push(ctx, RawKind::Joined);
}

void CbState(void* ud) {
  Ctx* ctx = static_cast<Ctx*>(ud);
  Impl* impl = ctx->impl;
  if (impl == nullptr || ctx->room == nullptr || ctx->room != impl->room) return;
  // §17.12: the decode wrote the WebSocket's values; the fast channel's held fields go back first.
  impl->CoverFast();
  // Noted here, while this patch is the decoded state and its TIMED stamp the clock's latest; and the
  // predictions this patch's acknowledgement settles, against the state it carries.
  // The reconnect's first state first: its decode confirmed what the earlier socket's inputs launched.
  if (impl->resyncFirstState) impl->DropEarlierSockets();
  impl->NotePatches();
  impl->NoteBodies();
  impl->NotePhysicsKeyframe();
  impl->SampleTicks();
  impl->projectileTtl.NoteState(colyseus_room_clock_now(colyseus_room_get_clock(impl->room)));
  impl->SettleShots();
  Push(ctx, RawKind::State);
  // A later patch in this same poll decodes against the WebSocket's values again.
  impl->BeforePoll();
}

void CbMessage(const char* type, const std::uint8_t* data, std::size_t length, void* ud) {
  Ctx* ctx = static_cast<Ctx*>(ud);
  if (ctx->impl == nullptr || type == nullptr) return;
  Raw item;
  item.text = type;
  if (data != nullptr && length > 0) {
    std::optional<Json> decoded = DecodeMsgpack(data, length);
    if (decoded) item.data = std::move(*decoded);
  }
  Push(ctx, RawKind::Message, std::move(item));
}

void CbDrop(int code, const char* reason, void* ud) {
  (void)reason;
  Ctx* ctx = static_cast<Ctx*>(ud);
  if (ctx->impl == nullptr) return;
  Raw item;
  item.code = code;
  Push(ctx, RawKind::Drop, std::move(item));
}

void CbReconnect(void* ud) {
  Ctx* ctx = static_cast<Ctx*>(ud);
  Impl* impl = ctx->impl;
  if (impl == nullptr || ctx->room == nullptr) return;
  if (ctx->room != impl->room) {
    // Leave() ran while the socket was down, where the consented leave could not reach the server:
    // leave now (leaving from a callback is fine), or the seat stays taken with nobody behind it.
    colyseus_room_leave(ctx->room, true);
    return;
  }
  impl->resyncFirstState = true;
  Push(ctx, RawKind::Reconnect);
}

void CbLeave(int code, const char* reason, void* ud) {
  Ctx* ctx = static_cast<Ctx*>(ud);
  if (ctx->impl == nullptr) return;
  Raw item;
  item.code = code;
  item.text = Str(reason);
  Push(ctx, RawKind::Leave, std::move(item));
}

void CbRoomError(int code, const char* message, void* ud) {
  Ctx* ctx = static_cast<Ctx*>(ud);
  if (ctx->impl == nullptr) return;
  Raw item;
  item.code = code;
  item.text = Str(message);
  Push(ctx, RawKind::RoomError, std::move(item));
}

void CbRoom(colyseus_room_t* room, void* ud) {
  Ctx* ctx = static_cast<Ctx*>(ud);
  ctx->inFlight = false;
  ctx->room = room;
  Impl* impl = ctx->impl;
  if (impl == nullptr) {
    colyseus_room_leave(room, true);
    return;
  }
  // Wire the room right here: its handshake can arrive in the next poll. The schema first.
  colyseus_room_set_state_type(room, &authority_wire::AuthorityRoomState_vtable);
  colyseus_room_on_join(room, CbJoin, ud);
  colyseus_room_on_state_change(room, CbState, ud);
  colyseus_room_on_leave(room, CbLeave, ud);
  colyseus_room_on_drop(room, CbDrop, ud);
  colyseus_room_on_reconnect(room, CbReconnect, ud);
  colyseus_room_on_error(room, CbRoomError, ud);
  colyseus_room_on_message_any_with_type_encoded(room, CbMessage, ud);
  Impl::SetReconnection(room);
  if (impl->closed || impl->leaving || ctx->gen != impl->gen || impl->room != nullptr) {
    // Left while the join was in flight (or a stale attempt): never keep the seat (Godot _on_joined).
    colyseus_room_leave(room, true);
    impl->leavingRooms.push_back(room);
    return;
  }
  impl->room = room;
}

void CbJoinError(int code, const char* message, void* ud) {
  Ctx* ctx = static_cast<Ctx*>(ud);
  ctx->inFlight = false;
  if (ctx->impl == nullptr) return;
  Raw item;
  item.code = code;
  item.text = Str(message);
  Push(ctx, RawKind::JoinError, std::move(item));
}

void CbLatency(const char* best, double latencyMs, void* ud) {
  (void)latencyMs;
  Ctx* ctx = static_cast<Ctx*>(ud);
  ctx->inFlight = false;
  if (ctx->impl == nullptr) return;
  Raw item;
  item.hasText = best != nullptr;
  item.text = Str(best);
  Push(ctx, RawKind::Latency, std::move(item));
}

void CbProbe(const char* best, double latencyMs, void* ud) {
  Ctx* ctx = static_cast<Ctx*>(ud);
  ctx->inFlight = false;
  if (ctx->impl == nullptr) return;
  Raw item;
  item.hasText = best != nullptr;
  item.text = Str(best);
  item.number = latencyMs;
  Push(ctx, RawKind::Probe, std::move(item));
}

}  // namespace genex::authority_session_detail

namespace genex {

namespace asd = ::genex::authority_session_detail;

const char* AuthorityStatusName(AuthorityStatus status) {
  switch (status) {
    case AuthorityStatus::Joining:
      return "joining";
    case AuthorityStatus::Connected:
      return "connected";
    case AuthorityStatus::Reconnecting:
      return "reconnecting";
    case AuthorityStatus::Closed:
      return "closed";
  }
  return "closed";
}

const char* AuthorityEventTypeName(AuthorityEventType type) {
  switch (type) {
    case AuthorityEventType::Ready:
      return "ready";
    case AuthorityEventType::JoinFailed:
      return "joinFailed";
    case AuthorityEventType::Reconnecting:
      return "reconnecting";
    case AuthorityEventType::Reconnected:
      return "reconnected";
    case AuthorityEventType::Disconnected:
      return "disconnected";
    case AuthorityEventType::ServerRestart:
      return "serverRestart";
    case AuthorityEventType::Draining:
      return "draining";
    case AuthorityEventType::Rejoining:
      return "rejoining";
    case AuthorityEventType::Rejoined:
      return "rejoined";
    case AuthorityEventType::Message:
      return "message";
    case AuthorityEventType::Warning:
      return "warning";
  }
  return "warning";
}

/** §17.1 *Regrouping* for a session whose join may regroup: the probe it asks by, where the schedule stands, the ask
 *  in the air and the rooms it moved out of, until their leave settles. */
struct asd::RegroupRun {
  asd::RegroupBasis basis;
  std::vector<double> waits;
  /** The wait before the next look: waits[min(step, last)]. */
  std::size_t step = 0;
  /** When the next look is due; empty until the seat's first state. */
  std::optional<double> nextAt;
  /** The servers this look asks, nearest first, and the one being asked. */
  std::vector<std::string> asking;
  std::size_t askAt = 0;
  /** The ask in the air: a whole session's insides, which become this one's on their first state. */
  std::unique_ptr<asd::Impl> next;
  /** Rooms the seat moved out of, with when it left each. */
  std::vector<std::pair<std::unique_ptr<asd::Impl>, double>> left;

  double Wait(std::size_t at) const { return waits[std::min(at, waits.size() - 1)]; }
};

/** A rejoin on its way (§17.13). */
struct asd::RejoinRun {
  int lostCode = 0;
  std::string lostReason;
  std::string lostRoom;
  std::string matchKey;
  bool closed = false;
  /** Nearest first, the seat's own region at the front. */
  std::vector<std::string> targets;
  double startedAt = 0.0;
  int attempt = 0;
  std::optional<int> refusal;
  /** When the next attempt starts, decided by rejoin::NextStep; empty: decide. */
  std::optional<double> nextAt;
  rejoin::Way way = rejoin::Way::Successor;
  std::size_t region = 0;
  /** The attempt in the air: a whole session's insides, which become this one's on their first state. */
  std::unique_ptr<asd::Impl> next;
};

AuthoritySession::AuthoritySession(AuthorityOptions options) : impl_(new asd::Impl(std::move(options))) {
  Pump::EnsurePolled();
  Pump::Register(this);
  impl_->Start();
}

AuthoritySession::~AuthoritySession() { Pump::Unregister(this); }

void AuthoritySession::Update(double nowMs) {
  impl_->Update(nowMs);
  DriveRejoin(nowMs);
  DriveRegroup(nowMs);
}

void AuthoritySession::BeforePoll() {
  impl_->BeforePoll();
  if (rejoin_ != nullptr && rejoin_->next != nullptr) rejoin_->next->BeforePoll();
  if (regroup_ == nullptr) return;
  if (regroup_->next != nullptr) regroup_->next->BeforePoll();
  for (auto& left : regroup_->left) left.first->BeforePoll();
}

void AuthoritySession::DriveRejoin(double nowMs) {
  if (rejoin_ == nullptr && impl_->lostCode.has_value()) {
    rejoin_ = std::make_unique<asd::RejoinRun>();
    rejoin_->lostCode = *impl_->lostCode;
    rejoin_->lostReason = impl_->lostReason;
    rejoin_->lostRoom = impl_->roomId;
    rejoin_->matchKey = impl_->seatMatchKey;
    const AuthorityOptions& options = impl_->options;
    const bool byExtra = options.extra.Find("successorClosed") != nullptr;
    rejoin_->closed = options.createPrivate || options.joinCode.has_value() || byExtra;
    rejoin_->targets.push_back(impl_->url);
    for (const std::string& url : impl_->targets) {
      if (url != impl_->url) rejoin_->targets.push_back(url);
    }
    rejoin_->startedAt = nowMs;
    impl_->lostCode.reset();
  }
  if (rejoin_ == nullptr) return;
  asd::RejoinRun& run = *rejoin_;
  if (run.next != nullptr) {
    run.next->Update(nowMs);
    std::vector<AuthorityEvent> events;
    events.swap(run.next->events);
    for (AuthorityEvent& event : events) {
      if (event.type == AuthorityEventType::Warning) impl_->events.push_back(std::move(event));
      if (event.type == AuthorityEventType::JoinFailed || event.type == AuthorityEventType::Disconnected) {
        run.refusal = event.code > 0 ? std::optional<int>(event.code) : std::nullopt;
        run.next.reset();
        run.nextAt.reset();
        break;
      }
    }
    if (run.next != nullptr) {
      // Its first state is enough: the seat must frame to send the uplink its snapshots wait for, and
      // Ready waits for the clock's first round trip, up to 2 s more out of play.
      if (run.next->joined) AdoptRejoin();
      return;
    }
  }
  if (run.nextAt.has_value()) {
    if (nowMs < *run.nextAt) return;
    AuthorityOptions options = impl_->options;
    options.url = run.region < run.targets.size() ? run.targets[run.region] : impl_->url;
    options.capacityRetryMs.clear();  // the rejoin's schedule is the ladder
    options.rejoin = false;
    options.createPrivate = false;
    options.joinCode.reset();
    options.world = impl_->world;
    options.physics = impl_->physicsHash;
    options.matchKey.clear();
    if (run.way == rejoin::Way::Room) options.joinCode = run.lostRoom;
    if (run.way != rejoin::Way::Room) options.matchKey = run.matchKey;
    if (run.way == rejoin::Way::Successor) {
      if (!options.extra.IsObject()) options.extra = Json::MakeObject();
      options.extra.Set("successorOf", Json(run.lostRoom));
      if (run.closed) options.extra.Set("successorClosed", Json(true));
    }
    run.next = std::make_unique<asd::Impl>(std::move(options));
    run.next->Start();
    return;
  }
  rejoin::Input decide;
  decide.attempt = run.attempt;
  decide.elapsedMs = nowMs - run.startedAt;
  decide.refusal = run.refusal;
  decide.lostCode = run.lostCode;
  decide.closed = run.closed;
  decide.regions = run.targets.size();
  decide.jitter = std::fmod(Clock::NowMs(), 1.0);
  const rejoin::Step step = rejoin::NextStep(decide);
  if (step.stop != rejoin::Stop::None) {
    impl_->status = AuthorityStatus::Closed;
    AuthorityEvent e;
    e.type = AuthorityEventType::Disconnected;
    e.code = run.lostCode;
    e.message = run.lostReason;
    impl_->events.push_back(std::move(e));
    rejoin_.reset();
    return;
  }
  run.attempt += 1;
  run.nextAt = nowMs + step.waitMs;
  run.way = step.way;
  run.region = step.region;
  AuthorityEvent e;
  e.type = AuthorityEventType::Rejoining;
  e.attempt = run.attempt;
  e.code = run.lostCode;
  e.ms = step.waitMs;
  impl_->events.push_back(std::move(e));
}

void AuthoritySession::AdoptRejoin() {
  std::unique_ptr<asd::RejoinRun> run = std::move(rejoin_);
  std::unique_ptr<asd::Impl> next = std::move(run->next);
  // The attempt's options were its own; what the game asked for stays for the next time.
  const AuthorityOptions& mine = impl_->options;
  next->options.rejoin = mine.rejoin;
  next->options.capacityRetryMs = mine.capacityRetryMs;
  next->options.url = mine.url;
  next->options.joinCode.reset();
  next->options.createPrivate = false;
  next->options.extra = mine.extra;
  if (run->closed) next->options.extra.Set("successorClosed", Json(true));
  next->targets = std::move(run->targets);
  next->rejoinedSeat = true;
  std::vector<AuthorityEvent> carried;
  carried.swap(impl_->events);
  impl_ = std::move(next);
  for (AuthorityEvent& event : impl_->events) carried.push_back(std::move(event));
  AuthorityEvent e;
  e.type = AuthorityEventType::Rejoined;
  e.name = impl_->roomId;
  carried.push_back(std::move(e));
  impl_->events.swap(carried);
}

AuthorityRegionMeter::AuthorityRegionMeter(const std::vector<regions::Region>& regions, const std::vector<std::string>& urls,
                                           std::function<void(const std::vector<regions::RegionPing>&)> done)
    : done_(std::move(done)) {
  Pump::EnsurePolled();
  Pump::Register(this);
  std::vector<regions::Region> regs = regions::Normalize(regions, urls);
  if (regs.size() <= 1) {
    // One region is not probed (measureAuthorityRegions): there is nothing to choose between.
    pings_ = regions::Pings(regs, {});
    return;
  }
  impl_ = std::make_unique<asd::Impl>(AuthorityOptions{});
  impl_->measureOnly = true;
  impl_->ProbeRegions(std::move(regs));
}

AuthorityRegionMeter::~AuthorityRegionMeter() { Pump::Unregister(this); }

void AuthorityRegionMeter::Update(double nowMs) {
  if (notified_) return;
  if (impl_ != nullptr) {
    impl_->Update(nowMs);
    if (!impl_->measured.has_value()) return;
    pings_ = std::move(impl_->measured);
    impl_.reset();
  }
  if (!pings_.has_value()) return;
  // Always from an Update, never from the constructor: the caller holds the meter before it answers.
  notified_ = true;
  if (done_) done_(*pings_);
}

void AuthoritySession::DriveRegroup(double nowMs) {
  if (regroup_ == nullptr && impl_->regroupBasis.has_value()) {
    regroup_ = std::make_unique<asd::RegroupRun>();
    regroup_->basis = std::move(*impl_->regroupBasis);
    impl_->regroupBasis.reset();
    const std::optional<std::vector<double>>& waits = impl_->options.regroupWaitsMs;
    if (waits && !waits->empty()) regroup_->waits = *waits;
    else regroup_->waits.assign(regions::kRegroupWaitsMs.begin(), regions::kRegroupWaitsMs.end());
  }
  if (regroup_ == nullptr) return;
  asd::RegroupRun& run = *regroup_;
  SettleLeftRooms(nowMs);
  // Nothing is asked while a lost room is being replaced (§17.13): the schedule waits and starts over.
  const bool rejoining = rejoin_ != nullptr || impl_->lostCode.has_value();
  if (run.next != nullptr) {
    if (rejoining || impl_->closed) {
      GiveBackRegroupAsk(nowMs);
      return;
    }
    DriveRegroupAsk(nowMs);
    return;
  }
  if (impl_->leaving || (impl_->closed && !rejoining)) return;
  if (!run.nextAt.has_value()) {
    if (impl_->joined) run.nextAt = nowMs + run.Wait(run.step);
    return;
  }
  if (nowMs < *run.nextAt) return;
  // With company (the state lists another player) it only looks again after the first wait, and the schedule
  // starts over the next time the player is alone.
  if (rejoining || !impl_->joined || impl_->playerViews.size() > 1) {
    run.step = 0;
    run.nextAt = nowMs + run.Wait(0);
    return;
  }
  run.step += 1;
  run.asking.clear();
  run.askAt = 0;
  const std::string here = regions::RegionOf(run.basis.regions, impl_->url);
  for (regions::Pick& p : regions::PlanRegroup(run.basis.regions, run.basis.best, run.basis.options, here)) {
    run.asking.push_back(std::move(p.url));
  }
  if (run.asking.empty()) {
    run.nextAt = nowMs + run.Wait(run.step);
    return;
  }
  StartRegroupAsk();
}

void AuthoritySession::StartRegroupAsk() {
  asd::RegroupRun& run = *regroup_;
  AuthorityOptions options = impl_->options;
  options.url = run.asking[run.askAt];
  // A full region is a refused ask like any other: the next region is asked.
  options.capacityRetryMs.clear();
  options.rejoin = false;
  options.regroup = false;
  options.createPrivate = false;
  options.joinCode.reset();
  options.world = impl_->world;
  options.physics = impl_->physicsHash;
  // The pool's options: the game's own match key, as its join-or-create sent.
  run.next = std::make_unique<asd::Impl>(std::move(options));
  run.next->joinOnly = true;
  // The game hears Rejoined with `moved` once the seat is adopted, never a second Ready.
  run.next->rejoinedSeat = true;
  run.next->Start();
}

void AuthoritySession::DriveRegroupAsk(double nowMs) {
  asd::RegroupRun& run = *regroup_;
  run.next->Update(nowMs);
  std::vector<AuthorityEvent> events;
  events.swap(run.next->events);
  const bool refused = std::any_of(events.begin(), events.end(), [](const AuthorityEvent& e) {
    return e.type == AuthorityEventType::JoinFailed || e.type == AuthorityEventType::Disconnected;
  });
  if (!refused) {
    if (!run.next->joined) {
      run.next->events.swap(events);
      return;
    }
    // Company arrived in the player's own room while the other region was asked: the player stays, so the newcomer
    // is not left alone in turn, and the seat found is given back. The game hears nothing.
    if (impl_->playerViews.size() > 1) {
      GiveBackRegroupAsk(nowMs);
      return;
    }
    // Its first state is enough, as for a rejoin: the seat is adopted before its clock's first round trip.
    AdoptRegroup(nowMs);
    return;
  }
  // A refused ask is never an error: no room there, or no way there. The next region is asked.
  run.next.reset();
  run.askAt += 1;
  if (run.askAt < run.asking.size()) {
    StartRegroupAsk();
    return;
  }
  run.asking.clear();
  run.nextAt = nowMs + run.Wait(run.step);
}

void AuthoritySession::GiveBackRegroupAsk(double nowMs) {
  asd::RegroupRun& run = *regroup_;
  // A leave the server hears, so the room found does not hold the seat for its reconnect grace.
  run.next->Leave();
  run.left.emplace_back(std::move(run.next), nowMs);
  run.asking.clear();
  run.nextAt = nowMs + run.Wait(run.step);
}

void AuthoritySession::AdoptRegroup(double nowMs) {
  asd::RegroupRun& run = *regroup_;
  std::unique_ptr<asd::Impl> next = std::move(run.next);
  // The ask's options were its own; what the game asked for stays for the next time.
  const AuthorityOptions& mine = impl_->options;
  next->options.rejoin = mine.rejoin;
  next->options.regroup = mine.regroup;
  next->options.capacityRetryMs = mine.capacityRetryMs;
  next->options.url = mine.url;
  next->joinOnly = false;
  // A later rejoin walks from the region the seat is in now, then the others (DriveRejoin).
  next->targets = impl_->targets;
  std::unique_ptr<asd::Impl> empty = std::move(impl_);
  impl_ = std::move(next);
  std::vector<AuthorityEvent> carried;
  carried.swap(empty->events);
  for (AuthorityEvent& event : impl_->events) carried.push_back(std::move(event));
  AuthorityEvent e;
  e.type = AuthorityEventType::Rejoined;
  e.name = impl_->roomId;
  e.moved = true;
  carried.push_back(std::move(e));
  impl_->events.swap(carried);
  // The room the player was alone in is left, with a leave the server hears.
  empty->Leave();
  run.left.emplace_back(std::move(empty), nowMs);
  run.asking.clear();
  run.step = 0;
  run.nextAt = nowMs + run.Wait(0);
}

void AuthoritySession::SettleLeftRooms(double nowMs) {
  std::vector<std::pair<std::unique_ptr<asd::Impl>, double>>& left = regroup_->left;
  for (auto& l : left) l.first->Update(nowMs);
  left.erase(std::remove_if(left.begin(), left.end(),
                            [nowMs](const auto& l) { return l.first->Settled() || nowMs - l.second >= asd::kRegroupLeaveSettleMs; }),
             left.end());
}

int AuthoritySession::OwnPathMissing() const {
  return impl_->OwnPathMissing();
}

int AuthoritySession::ReseedMissing() const {
  return impl_->reseedMissing;
}

const fast::FastSeatStatus& AuthoritySession::Fast() const {
  static const fast::FastSeatStatus kNone;
  return impl_->fastSeat != nullptr ? impl_->fastSeat->Status() : kNone;
}

const std::string& AuthoritySession::TransportLine() const { return impl_->transportLine; }

int AuthoritySession::Frame(double nowMs) { return impl_->Frame(nowMs, input); }

int AuthoritySession::Frame() { return Frame(Clock::NowMs()); }

void AuthoritySession::Leave() {
  // A rejoin or a regroup's ask in the air takes no seat: its insides leave whatever they hold as they go.
  rejoin_.reset();
  regroup_.reset();
  impl_->Leave();
}

std::vector<AuthorityEvent> AuthoritySession::DrainEvents() {
  std::vector<AuthorityEvent> out;
  out.swap(impl_->events);
  return out;
}

AuthorityStatus AuthoritySession::Status() const { return impl_->status; }
const std::string& AuthoritySession::SessionId() const { return impl_->sid; }
const std::string& AuthoritySession::RoomId() const { return impl_->roomId; }
const std::string& AuthoritySession::Url() const { return impl_->url; }
std::string AuthoritySession::Region() const {
  const AuthorityOptions& o = impl_->options;
  return regions::RegionOf(regions::Normalize(o.regions, o.urls), impl_->url);
}
const std::string& AuthoritySession::Code() const { return impl_->roomId; }
std::string AuthoritySession::MatchKey() const {
  const authority_wire::AuthorityRoomState* st = impl_->State();
  return st == nullptr || st->matchKey == nullptr ? std::string() : std::string(st->matchKey);
}
bool AuthoritySession::IsReady() const { return impl_->ready && !impl_->closed; }
bool AuthoritySession::IsConnected() const { return impl_->connected && !impl_->closed; }
bool AuthoritySession::IsClosed() const { return impl_->closed && rejoin_ == nullptr && !impl_->lostCode.has_value(); }

double AuthoritySession::Tick() const {
  const authority_wire::AuthorityRoomState* st = impl_->State();
  return st != nullptr ? st->tick : 0.0;
}

const std::string& AuthoritySession::Preset() const {
  const authority_wire::AuthorityRoomState* st = impl_->State();
  impl_->preset = st != nullptr && st->preset != nullptr ? std::string(st->preset) : std::string();
  return impl_->preset;
}

double AuthoritySession::Rtt() const {
  if (impl_->room == nullptr) return 0.0;
  return colyseus_room_clock_smoothed_rtt(colyseus_room_get_clock(impl_->room));
}

AuthorityTelemetry AuthoritySession::Telemetry() const { return impl_->telemetry; }

const AuthorityEntityView* AuthoritySession::Me() const {
  if (!impl_->own || !IsReady()) return nullptr;
  return Entity(impl_->own->id);
}

const std::map<std::string, AuthorityEntityView>& AuthoritySession::Entities() const { return impl_->views; }

double AuthoritySession::DrawTick() const { return impl_->drawTick; }

double AuthoritySession::DrawLead() const { return impl_->drawLead; }

const AuthorityEntityView* AuthoritySession::Entity(const std::string& id) const {
  auto it = impl_->views.find(id);
  return it != impl_->views.end() ? &it->second : nullptr;
}

const std::map<std::string, AuthorityPlayerView>& AuthoritySession::Players() const { return impl_->playerViews; }

std::uint32_t AuthoritySession::SetWorld(FirstpersonWorldPtr world) { return impl_->SetWorld(std::move(world)); }

bool AuthoritySession::SetWorld(const Json& world, std::string* error, std::uint32_t* hash) {
  FirstpersonWorldPtr checked = FirstpersonWorld::FromJson(&world, error);
  if (checked == nullptr) return false;
  const std::uint32_t h = impl_->SetWorld(std::move(checked));
  if (hash != nullptr) *hash = h;
  return true;
}

const FirstpersonWorldPtr& AuthoritySession::World() const { return impl_->world; }

AuthorityPredictionStatus AuthoritySession::PredictionStatus() const { return impl_->PredictionNow(); }

std::string AuthoritySession::SetPhysics(std::string hash) {
  impl_->physicsHash = std::move(hash);
  return impl_->physicsHash;
}

AuthorityPhysicsStatus AuthoritySession::PhysicsStatus() const { return impl_->PhysicsNow(); }

AuthorityPhysicsPrediction AuthoritySession::PhysicsPrediction() const {
  AuthorityPhysicsPrediction out = impl_->predictCounts;
  out.status = physics::PredictStatusName(impl_->PredictStatusNow());
  return out;
}

bool AuthoritySession::DrawBodies() {
  if (!impl_->ready || impl_->closed || impl_->room == nullptr) return false;
  impl_->DrawBodyViews(nullptr);
  return impl_->ClockTimed();
}

std::string AuthoritySession::PredictProjectile(const ProjectilePrediction& projectile) {
  return impl_->PredictProjectile(projectile);
}

std::string AuthoritySession::NextProjectileId() const { return impl_->NextProjectileId(); }

std::optional<AuthorityServerClock> AuthoritySession::DrawProjectiles() {
  if (!impl_->ready || impl_->closed || impl_->room == nullptr) return std::nullopt;
  // Read once: the views are drawn at exactly the instant returned.
  const AuthorityServerClock clock = impl_->ReadClock();
  impl_->DrawProjectileViews(impl_->State(), clock);
  if (!impl_->ClockTimed()) return std::nullopt;
  return clock;
}

std::optional<AuthorityServerClock> AuthoritySession::ServerClock() const { return impl_->ClockNow(); }

void AuthoritySession::TestDrop() {
  if (impl_->joined && impl_->connected) impl_->Drop();
}

std::optional<AuthorityRemoteProbe> AuthoritySession::ProbeRemote(const std::string& id) const {
  auto it = impl_->probes.find(id);
  if (it == impl_->probes.end()) return std::nullopt;
  return it->second;
}

// ---- pure pieces ----

double AuthorityWrapAngle(double v) { return v - asd::kTwoPi * std::floor((v + asd::kJsPi) / asd::kTwoPi); }

double AuthorityDrawnPitch(double pitch, double limit) {
  const double wrapped = AuthorityWrapAngle(pitch);
  return wrapped < -limit ? -limit : wrapped > limit ? limit : wrapped;
}

bool AuthorityIsHeading(const std::string& field) { return field == "yaw"; }

double AuthorityCorrection(const std::string& field, double before, double after) {
  const double delta = after - before;
  return std::fabs(AuthorityIsHeading(field) ? AuthorityWrapAngle(delta) : delta);
}

AuthorityCorrectionSizes AuthorityCorrectionsOf(const std::vector<std::string>& fields, const std::vector<double>& before,
                                                const std::vector<double>& after) {
  double squares = 0.0;
  AuthorityCorrectionSizes sizes;
  for (std::size_t i = 0; i < fields.size(); ++i) {
    const std::string& field = fields[i];
    if (asd::NotAPlace(field)) continue;
    if (field == "x" || field == "y" || field == "z") {
      const double delta = after[i] - before[i];
      squares += delta * delta;
    } else {
      sizes.state = (std::max)(sizes.state, AuthorityCorrection(field, before[i], after[i]));
    }
  }
  sizes.place = std::sqrt(squares);
  return sizes;
}

bool AuthorityVisibleCorrection(double place, double unitsPerMetre) { return place > asd::kVisibleCorrectionMetres * unitsPerMetre; }

std::string AuthorityProjectileId(const std::string& sid, double seqBase, int seq, int n) {
  std::string id = sid;
  id += '.';
  AppendJsonNumber(id, seqBase + static_cast<double>(seq));
  id += '.';
  id += std::to_string(n);
  return id;
}

double AuthorityLeadTicks(double leadMs, double tickHz) { return (leadMs * tickHz) / 1000.0; }

void ProjectileTtl::NoteState(double now) {
  if (now - lastStateAt_ > stallMs_ || now - stallEndedAt_ > kProjectileTtlMinMs + stallMs_) {
    stallMs_ = now - lastStateAt_;
    stallEndedAt_ = now;
  }
  lastStateAt_ = now;
}

double ProjectileTtl::Ms(double rtt, bool connected, double now) const {
  const double base = (std::max)(2.0 * rtt, kProjectileTtlMinMs);
  if (!connected) return base;
  // The silence now, or the last stall for as long as a prediction made before it could still be waiting (its age
  // counts the stall; its TTL does not).
  const double recent = now - stallEndedAt_ < base + stallMs_ ? stallMs_ : 0.0;
  return base + (std::max)(now - lastStateAt_, recent);
}

std::optional<double> AuthorityBudgetOverride(const Json* value) {
  if (value == nullptr || !value->IsNumber()) return std::nullopt;
  const double ms = value->AsNumber();
  if (!std::isfinite(ms) || !(ms > 0.0)) return std::nullopt;
  return ms;
}

double AuthorityEffectiveBudgetMs(const std::optional<double>& overrideMs, double deviceMs) {
  return overrideMs && std::isfinite(*overrideMs) && *overrideMs > 0.0 ? *overrideMs : deviceMs;
}

AuthorityPose AuthoritySpringStep(const AuthorityPose& target, double epoch, bool has, const AuthorityPose& last,
                                  double lastEpoch, double dtMs, double tauMs) {
  if (!has || lastEpoch != epoch) return target;
  if (dtMs <= 0.0) return last;  // a second read in the same instant
  if (!(tauMs > 0.0)) return target;
  const double k = 1.0 - std::exp(-dtMs / tauMs);
  AuthorityPose out;
  out.t = target.t;
  out.x = last.x + (target.x - last.x) * k;
  out.y = last.y + (target.y - last.y) * k;
  out.z = last.z + (target.z - last.z) * k;
  out.yaw = last.yaw + asd::ShortArc(last.yaw, target.yaw) * k;
  out.pitch = last.pitch + (target.pitch - last.pitch) * k;  // a bounded angle: straight
  out.duck = last.duck + (target.duck - last.duck) * k;
  return out;
}

AuthorityPose AuthoritySample(const std::vector<AuthorityPose>& history, double time) {
  if (history.size() == 1 || time <= history.front().t) return history.front();
  const AuthorityPose& newest = history.back();
  if (time >= newest.t) return newest;
  std::size_t k = history.size() - 2;
  while (k > 0 && history[k].t > time) --k;
  const AuthorityPose& a = history[k];
  const AuthorityPose& b = history[k + 1];
  const double u = (time - a.t) / (b.t - a.t);
  AuthorityPose out;
  out.t = time;
  out.x = a.x + (b.x - a.x) * u;
  out.y = a.y + (b.y - a.y) * u;
  out.z = a.z + (b.z - a.z) * u;
  out.yaw = a.yaw + asd::ShortArc(a.yaw, b.yaw) * u;
  out.pitch = a.pitch + (b.pitch - a.pitch) * u;  // a bounded angle: straight
  out.duck = a.duck + (b.duck - a.duck) * u;
  return out;
}

}  // namespace genex
