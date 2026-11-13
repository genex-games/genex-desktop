/**
 * What `show_design` says to a model: what the design board is and when it is the right answer
 * (the tool's description, which every turn reads), how to design on it and what it holds now
 * (answered once asked), and what each call did. When to ask the person first is the chat's own
 * rule (the seed's per-turn text), not this tool's. Model-facing text.
 */
import type { LiveToolSpec } from "../../shared/engine-requests.ts";
import {
  CHOICES_MAX,
  DESIGN_DROPS,
  DESIGN_FOLDER,
  DESIGN_SUPPORT_FOLDER,
  MAKING_MAX,
  NOTE_MAX_CHARS,
} from "../../shared/design-board.ts";
import { ProjectTool } from "../../shared/project-tools.ts";

/** What the board is. */
const BOARD = [
  "Genex's Design tab: this game's design as artboards on a canvas the person looks at beside the game, with a block in the chat that points to it.",
  `An artboard is a file in ${DESIGN_FOLDER}/: a picture, a 3D model, or a page (HTML and CSS) for what needs words and layout (the pitch, a map with call-outs, the core loop, rules as a table, the game's screens). A folder there is a section (world/, characters/, game-ui/).`,
];

/** When the board is the right answer. */
const JUDGMENT = [
  "Put the design here before you build a new game or a large new part of one, once its direction is settled, and build what the person agrees to. Also when they ask for a design, a concept, ideas, options or a look.",
  "Not for a small fix or tweak, a question a sentence answers, or a progress report, and not when they said to just build.",
  `The person can drop their own pictures on the canvas; they land in ${DESIGN_FOLDER}/${DESIGN_DROPS}/. Look at them before you design.`,
];

/** How the tool is called. */
const CALLS = [
  "The canvas is live: it shows a new or changed file within seconds, so put the first artboards up early and add the rest in front of the person.",
  "Call it with no page first: it answers how to design on the board and what the board holds now. After adding or changing artboards the person should look at now, call it with one of them and a note of a few words (what to look at, or what changed): the Design tab opens on it. With a spot it points at one place of that artboard and says the note there.",
  "Before you make artboards that take a while (pictures, models), call it with making: the person watches them being drawn. When the person is to choose among artboards, call it with choose: only those wear Use this and Not this.",
];

/** `show_design`: the design board's judgment in its description; it writes no file itself. */
export const SHOW_DESIGN_TOOL: LiveToolSpec = {
  name: ProjectTool.ShowDesign,
  description: [...BOARD, ...JUDGMENT, ...CALLS].join(" "),
  parameters: {
    type: "object",
    properties: {
      page: {
        type: "string",
        description: `An artboard's path below ${DESIGN_FOLDER}/, e.g. world/town.png or 01-pitch.html. Leave it out to read how to design on the board and what it holds.`,
      },
      spot: {
        type: "string",
        description:
          'With a page: where on it to point, as percent across and percent down ("40,70" is a little left of the middle, two thirds down). The note is said at that spot. Leave it out to show the whole artboard.',
      },
      making: {
        type: "string",
        description: `The artboards you are about to make, in order, by the paths they will have below ${DESIGN_FOLDER}/, one to a line. The canvas shows each as being drawn until its file is there. At most ${MAKING_MAX}.`,
      },
      choose: {
        type: "string",
        description: `Artboards of the board the person is to pick among, one path to a line: each wears Use this and Not this, and no other artboard does. A new list replaces the last; an empty one ends the choosing. At most ${CHOICES_MAX}.`,
      },
      note: {
        type: "string",
        description: `With a page: a few words for its block in the chat, on what to look at or what changed ("Three directions: pick one", "Added the swamp"). At most ${NOTE_MAX_CHARS} characters.`,
      },
    },
  },
};

/** How to design on the board: answered to `show_design` with no page, before what the board holds. */
const DESIGN_GUIDE = `How to design on Genex's Design tab.

WHERE. Files in ${DESIGN_FOLDER}/ in the game folder (make it). Each picture (png, jpg, webp, svg), 3D model (glb) and page (html) there is an artboard. A folder is a section, named as the person should read it (world, characters, game-ui, systems); artboards hang in name order, so number what has an order (01-pitch.html). No deeper folders. ${DESIGN_SUPPORT_FOLDER}/ is never a section: pictures only a page needs go there. The folder is documentation: saved and rewound with the game, never shipped with it.

FROM THE PERSON. ${DESIGN_FOLDER}/${DESIGN_DROPS}/ holds pictures the person dropped on the canvas. Open each one before you design, say in a line what you took from it, and never change or delete them. The person also pins notes on artboards: they reach you as a message of theirs, each naming its artboard's file and where on it the note is (how far across and how far down, in percent). A note on one of their own pictures says what that reference is for. Answer a note by changing the artboard it is on, then say in a line what you changed. Their picks reach you the same way: "Use this" is the artboard to go with, "Not this" one to drop; go on from what they chose, and never ask again what a pick already answers.

PICTURES FIRST. The person needs to see and feel the game, so a design is mostly pictures, large, one subject each: a place, a character concept, a moment of play, a screen. Generate them with the tools you have (a plugin's image or 3D generation; what it makes lands in the game folder, usually under assets/) and put the ones that belong to the design in its section. A character or prop that has a model: put its .glb beside its concept picture. Name files as their captions should read (the-warden.png).

PAGES are for what a picture cannot say: the pitch, the core loop, a map with numbered call-outs, rules as a table, a screen with its HUD over a picture. HTML and CSS only: scripts never run and the network is closed (no <script>, no remote fonts or pictures). A page is drawn in Genex's own look, dark or light with the app, in Genex's typefaces. Build with its variables and never paint a white sheet: var(--genex-bg), --genex-inset, --genex-ink, --genex-ink-2, --genex-ink-3, --genex-line, --genex-accent, --genex-radius, and font-family: var(--genex-mono) for small labels. A page shows pictures, sounds (<audio controls>) and videos of the game by relative path (../../assets/hero.png). It is 1200px wide and at least 800px tall and grows with what it holds (body{width:1800px} for a wider one); it never scrolls.

ONE ARTBOARD, ONE IDEA. Few words: labels and bullets, never paragraphs. A <title> that names the page, and the date on the pitch. Write for the person who will play: what they see and do, never file names or code. An idea that will not fit one page is two ideas, or not clear yet.

WHAT TO MAKE, by what is open now, never all of it at once:
- Concept: the pitch, and two or three directions as pictures, offered with choose so the person picks one on the canvas.
- World: the places as pictures; a map page with call-outs and the minutes each stretch takes.
- Characters: concept pictures, their models once made, and who beats or helps whom.
- Game UI: the screens, drawn over a picture of the game or as plain wireframes.
- Systems: the core loop with its seconds, rules as a table (a missing rule is an empty cell), the whole game as one strip over time.
- Change, for a game that exists: what is there beside what it would become, the two offered with choose.

NO BUTTONS. A page is read, not pressed: put no button, form or "press here" on it, since nothing on a page can act. The person answers on the canvas (their notes, and Use this and Not this on the artboards you offer with choose) and in the chat. A link to another page (href="../world/map.html") brings it into view; an https link opens in the browser.

LIVE. Say what you are about to make (${ProjectTool.ShowDesign} with making) before you make it, put the first artboards up early, show them, and add the rest as they are made: the person watches the canvas fill. When they answer, change what is there (mark their pick, remove what lost) instead of adding more, and keep the board true as the game changes.

SHOW. After adding or changing artboards the person should look at now, call ${ProjectTool.ShowDesign} with one of them and a note; when you changed one thing on a picture or a page, add a spot so the note is said where the change is. When the person is to pick among artboards (directions, two takes of a character), call it with choose and those artboards: they pick on the canvas with Use this and Not this, and no other artboard offers that. Then say in one line what to look at or choose; if you wait for their choice, end your reply.`;

/** What the board holds now, section by section, as the guide ends: the person's own pictures are named as theirs. */
function boardWords(files: readonly string[]): string {
  if (files.length === 0) return "ON THE BOARD NOW: nothing yet.";
  const below = files.map((file) => file.slice(DESIGN_FOLDER.length + 1));
  const theirs = below.filter((file) => file.startsWith(`${DESIGN_DROPS}/`));
  const rest = below.filter((file) => !file.startsWith(`${DESIGN_DROPS}/`));
  const lines = [
    `ON THE BOARD NOW (below ${DESIGN_FOLDER}/): ${rest.length > 0 ? rest.join(", ") : "nothing of yours yet"}.`,
  ];
  if (theirs.length > 0) lines.push(`DROPPED BY THE PERSON, to look at: ${theirs.join(", ")}.`);
  return lines.join("\n");
}

/** What `show_design` answers. */
export const SHOW_DESIGN_ANSWER = {
  guide: (files: readonly string[]) => `${DESIGN_GUIDE}\n\n${boardWords(files)}`,
  shown: (file: string) =>
    `The Design tab is open on ${file}, and its block is in the chat. Tell the person in one line what to look at or choose there; if you wait for their choice, end your reply.`,
  badName: `Give an artboard's path below ${DESIGN_FOLDER}/, e.g. 01-pitch.html or world/town.png: a page, a picture or a model, at the board's top or in one section. Call ${ProjectTool.ShowDesign} with no page to read how to design on the board.`,
  making: (files: readonly string[]) =>
    `The canvas shows these as being drawn until their files are there: ${files.join(", ")}. Make them now, in that order.`,
  offered: (files: readonly string[]) =>
    files.length > 0
      ? `The person now sees Use this and Not this on: ${files.join(", ")}. Their picks reach you as a message of theirs: say in one line what to pick among, end your reply and wait for it.`
      : "No artboard is offered to pick among now.",
  missing: (file: string, files: readonly string[]) =>
    files.length > 0
      ? `There is no ${file}. The board holds: ${files.join(", ")}. Make the file first, then show it.`
      : `There is no ${file}: the board is empty. Make the file first (call ${ProjectTool.ShowDesign} with no page to read how), then show it.`,
} as const;
