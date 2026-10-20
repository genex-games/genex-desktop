/**
 * The answers the starters' tapes hold: written by hand for each starter's demo, call by call in the
 * order the demo makes them, and saved with `source: "fixture"` and no model — what a person reading a
 * tape can trust is that nothing in it pretends to come from a model. `record.ts` plays each demo on
 * these and writes the lines; a builder records its own game's tapes on this Mac's models.
 */
import type { AuthoredAnswer, StarterRequest } from "./lanes.ts";

/** One site's answers, in call order, and how many frames each took. */
interface SiteScript {
  latencyFrames: number;
  answers: readonly unknown[];
}

const WORLD_SIM: Record<string, SiteScript> = {
  "turn.resolve": {
    latencyFrames: 18,
    answers: [
      {
        reactions: [
          {
            nation: "brenn",
            stance: 2,
            action: "trade",
            target: "aurel",
            troops: 0,
            note: "Brenn's council takes the grain envoys in.",
          },
          {
            nation: "calder",
            stance: -1,
            action: "idle",
            target: "aurel",
            troops: 0,
            note: "Calder's court mutters about the pact.",
          },
          {
            nation: "esk",
            stance: 1,
            action: "trade",
            target: "brenn",
            troops: 0,
            note: "Esk sends salt along the new road.",
          },
        ],
        headline: "Brenn and Aurel seal a grain-for-iron pact while Calder watches.",
      },
      {
        reactions: [
          {
            nation: "calder",
            stance: -2,
            action: "war",
            target: "aurel",
            troops: 300,
            note: "Calder answers the regiments with its own.",
          },
          {
            nation: "dorvan",
            stance: -1,
            action: "ally",
            target: "calder",
            troops: 100,
            note: "Dorvan pledges riders to Calder.",
          },
          {
            nation: "fallow",
            stance: -1,
            action: "war",
            target: "aurel",
            troops: 200,
            note: "Fallow rattles its spears from afar.",
          },
        ],
        headline: "Calder masses troops on the Aurel line; Dorvan rides to its side.",
      },
      {
        reactions: [
          {
            nation: "brenn",
            stance: 1,
            action: "ally",
            target: "aurel",
            troops: 0,
            note: "Brenn's merchants join the festival.",
          },
          {
            nation: "calder",
            stance: 1,
            action: "reform",
            target: "dorvan",
            troops: 50,
            note: "Calder recalls a regiment to keep its guilds quiet.",
          },
        ],
        headline: "A week of festivals fills Aurel's capital; Calder's envoys are seen dancing.",
      },
    ],
  },
  "turn.dispatch": {
    latencyFrames: 6,
    answers: [
      { line: "From the court: the grain carts roll east to Brenn, and Calder's ambassador left the hall early." },
      { line: "From the border: Calder's banners line the ridge, and our scouts count Dorvan's riders among them." },
      { line: "From the capital: lanterns on every street, and for one night nobody speaks of Calder." },
    ],
  },
  "minor.drift": {
    latencyFrames: 9,
    answers: [
      {
        drifts: [
          { nation: "calder", stability: -1 },
          { nation: "esk", stability: 1 },
          { nation: "fallow", stability: -1 },
        ],
      },
    ],
  },
};

const CREATURE_GEN: Record<string, SiteScript> = {
  "creature.design": {
    latencyFrames: 15,
    answers: [
      {
        name: "Lilyhum",
        body: "round",
        legs: 0,
        arms: 0,
        size: 0.6,
        speed: 1.2,
        diet: "plants",
        palette: "moss",
        temper: "shy",
      },
      {
        name: "Duskcoil",
        body: "long",
        legs: 8,
        arms: 0,
        size: 1.8,
        speed: 4.5,
        diet: "meat",
        palette: "dusk",
        temper: "bold",
      },
      {
        name: "Glasswade",
        body: "tall",
        legs: 2,
        arms: 0,
        size: 2.4,
        speed: 2.2,
        diet: "light",
        palette: "tide",
        temper: "curious",
      },
    ],
  },
  "creature.note": {
    latencyFrames: 5,
    answers: [
      { line: "Drifts among the lily pads, humming a note only frogs seem to answer." },
      { line: "Eight stubby legs carry it through the reeds at dusk, fast and silent." },
      { line: "Stands still at noon with its glassy wings open, drinking the sun." },
    ],
  },
};

const AGENT_ARENA: Record<string, SiteScript> = {
  "bot.compile": {
    latencyFrames: 20,
    answers: [
      {
        name: "Ram",
        rules: [
          { when: "enemy-near", act: "strike", power: 3 },
          { when: "hurt", act: "retreat", power: 1 },
          { when: "always", act: "advance", power: 3 },
        ],
      },
      {
        name: "Turtle",
        rules: [
          { when: "enemy-near", act: "strike", power: 2 },
          { when: "enemy-far", act: "guard", power: 1 },
          { when: "always", act: "retreat", power: 1 },
        ],
      },
    ],
  },
};

const NPC_DIALOGUE: Record<string, SiteScript> = {
  "npc.intent": {
    latencyFrames: 4,
    answers: [
      { intent: "greet", topic: "forge" },
      { intent: "ask", topic: "river-ford" },
      { intent: "trade", topic: "iron-price" },
      { intent: "threaten", topic: "none" },
    ],
  },
  "npc.reply": {
    latencyFrames: 8,
    answers: [
      { line: "Morning. North-wood charcoal — burns hot and clean. Mind the sparks.", mood: "warm", give: "none" },
      {
        line: "Flooded, last week. Took a cart of my iron with it, and my father's hammer that night.",
        mood: "wary",
        give: "none",
      },
      { line: "Fresh bread for a horseshoe? That is fair. Here.", mood: "warm", give: "horseshoe" },
      { line: "Touch my anvil and you'll learn what a smith's arm is for. Out.", mood: "cold", give: "none" },
    ],
  },
};

/** Each starter's answers, by its name. */
const SCRIPTS: Record<string, Record<string, SiteScript>> = {
  "world-sim": WORLD_SIM,
  "creature-gen": CREATURE_GEN,
  "agent-arena": AGENT_ARENA,
  "npc-dialogue": NPC_DIALOGUE,
};

/** An author for one starter: each site's next answer, in call order; none once a site's run out. */
export function authorFor(starter: string): (request: StarterRequest) => AuthoredAnswer {
  const script = SCRIPTS[starter] ?? {};
  const asked = new Map<string, number>();
  return (request) => {
    const site = script[request.site];
    const n = asked.get(request.site) ?? 0;
    asked.set(request.site, n + 1);
    if (!site || n >= site.answers.length) throw new Error(`${starter} has no answer ${n + 1} for ${request.site}`);
    return { value: site.answers[n], latencyFrames: site.latencyFrames };
  };
}
