// The multiplayer bridge as an ES module (game systems MP-5a). A net web build's game.js imports
// the bare specifier `@genex-ai/multiplayer/bridge` (the genex-multiplayer crate's web backend);
// the page's import map resolves it to this file, served as mp/bridge.mjs. The bridge itself is
// the pinned `@genex-ai/multiplayer` bridge.global.js (with @colyseus/sdk, @colyseus/schema and
// @genex-ai/embed-sdk bundled, all MIT), served as mp/bridge.global.js and loaded by a classic
// script before any module, which sets `globalThis.GenexMultiplayerBridge`. This file re-exports
// its calls by name; a page where the bridge did not load fails here, before the game starts.
const bridge = globalThis.GenexMultiplayerBridge;
if (!bridge) throw new Error("mp-bridge-missing: mp/bridge.global.js did not load before the game");

export const {
  chatSend,
  claim,
  claimAsHost,
  connect,
  destroy,
  dispose,
  drainEventsJson,
  initEmbed,
  leave,
  listen,
  objectsJson,
  open,
  playersJson,
  release,
  reportEliminated,
  reportFinish,
  reportScore,
  send,
  sendInput,
  serverNow,
  sessionJson,
  setIdentity,
  setMe,
  setObject,
  setRoomOpen,
  setShared,
  sharedJson,
  snapMe,
  snapObject,
  timeUntil,
  version,
} = bridge;
export default bridge;
