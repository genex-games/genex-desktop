/**
 * Play in a fixture profile: the gallery's answers made here, the same shapes the API serves, so the
 * dashboard, its shelves and tabs, paging, online counts, likes and the viewer can be checked with no socket.
 * Covers are drawn SVGs; a game is a small local stand-in page. Deterministic: the same launch
 * draws the same catalog.
 */
import { FEED_PAGE_SIZE, type GalleryAnswer, type GalleryRequest, PlayRoute } from "../play/gallery.ts";
import { fixtureCreatorAnswer } from "./fixture-creator.ts";
import {
  type FixtureCatalog,
  fixtureAccountOf,
  fixtureAuthorId,
  fixturePeopleAnswer,
  fixtureReferral,
} from "./fixture-people.ts";

/** One fixture game: what a card needs and what varies between cards. */
interface FixtureGame {
  slug: string;
  title: string;
  author: string;
  plays: number;
  categories: string[];
  hue: number;
  multiplayer?: boolean;
  online?: number;
  /** No cover: the card shows its plain tile. */
  bare?: boolean;
  private?: boolean;
}

const GAMES: FixtureGame[] = [
  { slug: "lost-cathedral", title: "Lost Cathedral", author: "Simeon M", plays: 2682, categories: ["games"], hue: 32 },
  {
    slug: "stick-steel",
    title: "Stick & Steel",
    author: "Simeon M",
    plays: 2431,
    categories: ["games", "fighting"],
    hue: 8,
    multiplayer: true,
    online: 6,
  },
  {
    slug: "skate",
    title: "SKATE",
    author: "Simeon M",
    plays: 5285,
    categories: ["games", "sports"],
    hue: 200,
    multiplayer: true,
    online: 8,
    private: true,
  },
  {
    slug: "sandstorm",
    title: "SANDSTORM",
    author: "Gab",
    plays: 1937,
    categories: ["games", "arcade"],
    hue: 40,
    multiplayer: true,
    online: 4,
  },
  {
    slug: "the-long-silence",
    title: "The Long Silence",
    author: "achimala",
    plays: 3111,
    categories: ["games", "exploration"],
    hue: 220,
  },
  { slug: "wildfire", title: "wildfire", author: "Gab", plays: 803, categories: ["games"], hue: 16 },
  { slug: "claude-of-duty", title: "Claude of Duty", author: "mshumer", plays: 613, categories: ["games"], hue: 95 },
  {
    slug: "skate-dog",
    title: "Skate Dog",
    author: "Matthew G",
    plays: 333,
    categories: ["games", "sports", "arcade"],
    hue: 160,
  },
  {
    slug: "samurai-template",
    title: "Samurai Third-Person Template",
    author: "achref",
    plays: 291,
    categories: ["games", "exploration"],
    hue: 350,
  },
  {
    slug: "snowball",
    title: "Snowball",
    author: "Rabneba",
    plays: 3198,
    categories: ["games"],
    hue: 190,
    multiplayer: true,
    online: 0,
  },
  {
    slug: "a-very-long-name",
    title: "A game whose name is far too long to fit on one line of its card",
    author: "Someone with a long display name",
    plays: 12,
    categories: ["games", "exploration"],
    hue: 280,
  },
  { slug: "no-cover", title: "No Cover Yet", author: "New Maker", plays: 0, categories: ["games"], hue: 0, bare: true },
];
/** Enough extra games for a second page of Featured. */
const MORE: FixtureGame[] = Array.from({ length: 18 }, (_, i) => ({
  slug: `prototype-${i + 1}`,
  title: `Prototype ${i + 1}`,
  author: i % 2 ? "Builder" : "Maker",
  plays: 900 - i * 37,
  categories: ["games", ...(i % 5 === 0 ? ["arcade"] : []), ...(i % 7 === 0 ? ["exploration"] : [])],
  hue: (i * 47) % 360,
}));
/** The Tools shelf: interactive tech demos, each in one or more of its tabs. */
const TOOLS: FixtureGame[] = [
  {
    slug: "stylized-water",
    title: "Stylized Water",
    author: "Threejs Community",
    plays: 55,
    categories: ["tools", "vfx", "lighting"],
    hue: 190,
  },
  {
    slug: "procedural-ocean",
    title: "Procedural Ocean",
    author: "Threejs Community",
    plays: 73,
    categories: ["tools", "vfx", "terrain"],
    hue: 215,
  },
  {
    slug: "procedural-planet",
    title: "Procedural Planet",
    author: "Threejs Community",
    plays: 89,
    categories: ["tools", "terrain"],
    hue: 120,
  },
  {
    slug: "physics-sandbox",
    title: "Physics Sandbox",
    author: "Threejs Community",
    plays: 550,
    categories: ["tools", "physics"],
    hue: 30,
  },
];
/** The Assets shelf: single models, no tabs of its own. */
const ASSETS: FixtureGame[] = [
  {
    slug: "stone-fireplace",
    title: "Stone Fireplace",
    author: "Threejs Community",
    plays: 56,
    categories: ["assets"],
    hue: 24,
  },
  {
    slug: "candle-chandelier",
    title: "Candle Chandelier",
    author: "Threejs Community",
    plays: 40,
    categories: ["assets"],
    hue: 45,
  },
  {
    slug: "writing-desk",
    title: "Writing Desk",
    author: "Threejs Community",
    plays: 35,
    categories: ["assets"],
    hue: 15,
  },
];
const CATALOG = [...GAMES, ...MORE, ...TOOLS, ...ASSETS];

/** A drawn 16:9 cover: a gradient sky, a horizon and a sun in the game's hue. */
function cover(hue: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${hue} 55% 22%)"/><stop offset="1" stop-color="hsl(${(hue + 30) % 360} 60% 48%)"/></linearGradient></defs><rect width="320" height="180" fill="url(#s)"/><circle cx="226" cy="74" r="26" fill="hsl(${(hue + 50) % 360} 90% 72%)"/><path d="M0 132 L70 96 L128 124 L196 84 L262 120 L320 100 V180 H0 Z" fill="hsl(${hue} 40% 12%)"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** A fixture game as the gallery serves an item. */
function item(game: FixtureGame, index: number) {
  return {
    id: `fx${String(index).padStart(4, "0")}`,
    slug: game.slug,
    title: game.title,
    description: `${game.title}, a fixture game.`,
    thumbnailUrl: game.bare ? null : cover(game.hue),
    cloneUrl: `https://git.genex.games/u-fixture/${game.slug}.git`,
    purchaseUrl: null,
    private: game.private === true,
    multiplayer: game.multiplayer === true,
    categories: game.categories,
    playsCount: game.plays,
    online: game.multiplayer ? (game.online ?? 0) : null,
    author: { id: fixtureAuthorId(game.author), name: game.author, image: null },
  };
}

const likes = new Map<string, boolean>();
const ok = (body: unknown): GalleryAnswer => ({ status: 200, body });
const NOT_FOUND: GalleryAnswer = { status: 404, body: null };
const SIGNED_OUT: GalleryAnswer = { status: 401, body: null };

/** One page of the catalog for a tab, from the cursor on. */
function feed(query: URLSearchParams): GalleryAnswer {
  // The gallery read with no category is the Games shelf, as the API serves it.
  const category = query.get("category") ?? "games";
  const games = CATALOG.map(item).filter((game) => game.categories.includes(category));
  const cursor = query.get("cursor");
  const start = cursor ? games.findIndex((game) => game.id === cursor) + 1 : 0;
  const page = games.slice(start, start + FEED_PAGE_SIZE);
  const last = page.at(-1);
  return ok({ items: page, nextCursor: start + FEED_PAGE_SIZE < games.length && last ? last.id : null });
}

/** How many items each tab, and each shelf, has. */
function counts(): GalleryAnswer {
  const values: Record<string, number> = {};
  for (const game of CATALOG) for (const category of game.categories) values[category] = (values[category] ?? 0) + 1;
  const buckets = { games: values.games ?? 0, tools: values.tools ?? 0, assets: values.assets ?? 0 };
  return ok({ buckets, values });
}

/** A game's page facts, with this launch's like. */
function world(slug: string): GalleryAnswer {
  const index = CATALOG.findIndex((game) => game.slug === slug);
  const game = CATALOG[index];
  if (!game) return NOT_FOUND;
  const liked = likes.get(slug) === true;
  return ok({ item: { ...item(game, index), likesCount: 3 + (liked ? 1 : 0), likedByMe: liked } });
}

/** The search catalog: every fixture game in its slim shape, the author a name. */
function corpus(): GalleryAnswer {
  const items = CATALOG.map(item).map(({ author, private: hidden, ...rest }) => ({
    ...rest,
    author: author.name,
    remixable: !hidden,
  }));
  return ok({ items });
}

/** The fixture catalog by author: the gallery items of one author's games, as a profile lists them. */
const catalog: FixtureCatalog = {
  games: (authorId) => CATALOG.map(item).filter((game) => game.author.id === authorId),
};

/** The gallery's answers in a fixture launch, its people's (`fixture-people.ts`) and its numbers' (`fixture-creator.ts`). */
export const fixturePlayRequest: GalleryRequest = async (route, init) => {
  // The creator routes first: the account's stats live under `/api/users/me`, beside the people routes.
  const people = fixtureCreatorAnswer(route, init, catalog) ?? fixturePeopleAnswer(route, init, catalog);
  if (people) return people;
  if (route === PlayRoute.Referral && fixtureAccountOf(init.token)) return ok(fixtureReferral());
  const [pathname = "", search = ""] = route.split("?");
  const query = new URLSearchParams(search);
  if (pathname === PlayRoute.Feed) return feed(query);
  if (pathname === PlayRoute.Counts) return counts();
  if (pathname === PlayRoute.Corpus) return corpus();
  if (pathname === PlayRoute.Online) {
    const online = Object.fromEntries(CATALOG.filter((g) => g.multiplayer).map((g) => [g.slug, g.online ?? 0]));
    return ok({ online });
  }
  const worldPrefix = PlayRoute.world("");
  if (pathname.startsWith(worldPrefix)) return world(decodeURIComponent(pathname.slice(worldPrefix.length)));
  // Likes, tickets and invites answer signed out, even for the fixture account: no game's page signs in here.
  return SIGNED_OUT;
};

/** The stand-in page a fixture launch plays for `slug`: its name over a moving sky, no network. */
export function fixtureGamePage(slug: string): string {
  const game = CATALOG.find((candidate) => candidate.slug === slug);
  const title = (game?.title ?? slug).replace(/[<>&"]/g, "");
  const hue = game?.hue ?? 210;
  const page = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>html,body{margin:0;height:100%;background:#000;overflow:hidden;font:600 28px/1.2 -apple-system,system-ui,sans-serif;color:#fff}canvas{position:fixed;inset:0;width:100%;height:100%}h1{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);margin:0;text-shadow:0 2px 24px #000}</style></head><body data-fixture-game="${slug}"><canvas id="c"></canvas><h1>${title}</h1><script>const c=document.getElementById("c"),x=c.getContext("2d");let t=0;function f(){c.width=innerWidth;c.height=innerHeight;const g=x.createLinearGradient(0,0,0,c.height);g.addColorStop(0,"hsl(${hue} 55% 18%)");g.addColorStop(1,"hsl(${(hue + 30) % 360} 60% 42%)");x.fillStyle=g;x.fillRect(0,0,c.width,c.height);x.fillStyle="hsl(${(hue + 50) % 360} 90% 72%)";x.beginPath();x.arc(c.width*(.5+.3*Math.sin(t/90)),c.height*.35,40,0,7);x.fill();t++;requestAnimationFrame(f)}f()</script></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(page)}`;
}
