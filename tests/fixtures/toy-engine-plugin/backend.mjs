// The toy engine does nothing: every tool answers which tool ran, for which project (its editor
// with nobody at it). Its play tools stand in for a play of up to three players, each with its own
// picture and state, and its judges' probe measures the play that is open. A game folder holding
// `live-data.txt` stands in for a game whose play reaches the live game's saved data. A test's copy
// that declares the Do it for me action and tools below gets the host's answer to
// `game.engine.assist` (a setup click handed to the game's chat) back from each, and its answer to
// `game.engine.canAssist` (whether Do it for me can run on this computer). A copy that declares
// `name-it` gets back the name it was called with, as the person's card left it.

import { existsSync } from "node:fs";
import path from "node:path";

/** The smallest JPEG markers, base64, as a stand-in picture: start of image, then end of image. */
const SHOT = "/9j/2Q==";
const VIEW = { width: 1280, height: 720 };
/** The file that marks a game whose play reaches its live saved data. */
const LIVE_DATA_MARK = "live-data.txt";
/** A stand-in JPEG long enough to be read as one (start of image, an APP0 marker, end of image), base64. */
const PROBE_PICTURE = "/9j/4AAAAAAAAAAA/9k=";

/** The setup tasks the toy hands to the chat, by the action or tool that asks. */
const ASSIST_TASKS = {
  "do-it-for-me": "Turn on the toy editor's server: Toy › Settings › Server",
  "publish-toy": "Publish the toy game: File › Publish",
  "assist-quietly": "Turn on the toy editor's server: Toy › Settings › Server",
  "assist-unasked": "Turn on the toy editor's server: Toy › Settings › Server",
};

/** A player's number from a call's arguments: player 1 when none is named. */
const playerOf = (args) => (typeof args?.player === "number" ? args.player : 1);

/** The toy play: how many players it opened, and what each one has held. */
function toyPlay() {
  let players = 0;
  let probes = 0;
  const held = new Map();
  const tools = {
    "play-open": (args, ctx) => {
      const joined = players > 0;
      players = typeof args?.players === "number" ? Math.min(3, Math.max(1, args.players)) : 1;
      const liveData = typeof ctx?.directory === "string" && existsSync(path.join(ctx.directory, LIVE_DATA_MARK));
      return { ...VIEW, joined, players, ...(liveData ? { liveData } : {}) };
    },
    "play-input": (args) => {
      const keys = String(args?.keys ?? "")
        .split(",")
        .filter(Boolean);
      held.set(playerOf(args), keys);
      return { held: keys, gameSeconds: Number(args?.seconds) || 0 };
    },
    "play-shot": () => ({ data: SHOT, mime: "image/jpeg", ...VIEW }),
    "play-state": (args) => ({ player: playerOf(args), players, held: held.get(playerOf(args)) ?? [] }),
    "play-pause": () => ({ refused: "unsupported", message: "The toy play cannot pause." }),
    // A judge's probe: what it measured of the play that is open, and one picture per player.
    "toy-probe": () => {
      probes += 1;
      const note = players > 0 ? `${players} players in the play; probe ${probes}` : "no play is open";
      const images = Array.from({ length: players }, (_, i) => ({
        mimeType: "image/jpeg",
        data: PROBE_PICTURE,
        label: `player ${i + 1}`,
      }));
      return { note, images };
    },
    "play-close": () => {
      const closed = players > 0;
      players = 0;
      held.clear();
      return { closed };
    },
  };
  return tools;
}

export async function activate() {
  const play = toyPlay();
  return {
    async tool(name, args, ctx) {
      if (Object.hasOwn(play, name)) return play[name](args, ctx);
      if (Object.hasOwn(ASSIST_TASKS, name)) return ctx.host("game.engine.assist", { task: ASSIST_TASKS[name] });
      if (name === "can-assist") return ctx.host("game.engine.canAssist");
      if (name === "name-it") return { tool: name, name: args?.name };
      // Nobody uses the toy editor: its lock's person-first probe never waits on the person.
      if (name === "editor-state") return { tool: name, project: ctx.project, personActive: false };
      return { tool: name, project: ctx.project };
    },
    async action(name, _args, ctx) {
      if (Object.hasOwn(ASSIST_TASKS, name)) return ctx.host("game.engine.assist", { task: ASSIST_TASKS[name] });
      return null;
    },
  };
}
