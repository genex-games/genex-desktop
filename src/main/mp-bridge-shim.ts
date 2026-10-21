/**
 * The multiplayer bridge as an ES module (MP-5a): the text a `[net]` game's web build serves as
 * `mp/bridge.mjs` (`WEB_NET_FILES.shim` in rust-build-web.ts). The game's `game.js` imports the
 * bare specifier `@genex-ai/multiplayer/bridge` (the genex-multiplayer crate's web backend) and the
 * page's import map resolves it here. The bridge itself is the pinned `@genex-ai/multiplayer`
 * `bridge.global.js`, loaded by a classic script before any module, which sets
 * `globalThis.GenexMultiplayerBridge`; this module re-exports its calls by name, and a page where
 * the bridge did not load fails here, before the game starts. The build owns the text, so no game
 * folder carries a copy.
 */

/** The bridge's exports the shim re-exports by name: every call the vendored crate imports, and `version`. */
export const MP_BRIDGE_EXPORTS = [
  "chatSend",
  "claim",
  "claimAsHost",
  "connect",
  "destroy",
  "dispose",
  "drainEventsJson",
  "initEmbed",
  "leave",
  "listen",
  "objectsJson",
  "open",
  "playersJson",
  "release",
  "reportEliminated",
  "reportFinish",
  "reportScore",
  "send",
  "sendInput",
  "serverNow",
  "sessionJson",
  "setIdentity",
  "setMe",
  "setObject",
  "setRoomOpen",
  "setShared",
  "sharedJson",
  "snapMe",
  "snapObject",
  "timeUntil",
  "version",
] as const;

/** The shim's text, byte for byte what a net build writes to `mp/bridge.mjs`. */
export const MP_BRIDGE_SHIM = [
  "// The multiplayer bridge as an ES module (Genex, MP-5a): re-exports mp/bridge.global.js by name.",
  "const bridge = globalThis.GenexMultiplayerBridge;",
  'if (!bridge) throw new Error("mp-bridge-missing: mp/bridge.global.js did not load before the game");',
  "",
  `export const { ${MP_BRIDGE_EXPORTS.join(", ")} } = bridge;`,
  "export default bridge;",
  "",
].join("\n");
