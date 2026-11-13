/**
 * `GenexGame.jslib`, the browser half of the `GenexGame` a Unity multiplayer game carries, run as a
 * WebGL player links it (Emscripten's `mergeInto`, with its string helpers stood in for): the game's
 * project from its published page, Studio's local room from the preview's address, and the published
 * page's server-authoritative room servers. A local room is only ever a `ws://` loopback room on a
 * loopback page: any other address the page was opened with names none.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import vm from "node:vm";

const JSLIB = path.resolve("src/plugins/unity/multiplayer/genex-game/GenexGame.jslib");

type Library = Record<string, unknown>;

/** The jslib linked into a page whose `window` is `window`; answers each function as C# calls it, its string read back. */
async function linked(window: Record<string, unknown>) {
  const library: Library = {};
  const memory = new Map<number, string>();
  const context: Record<string, unknown> = {
    window,
    URL,
    URLSearchParams,
    LibraryManager: { library },
    mergeInto: (into: Library, entries: Library) => Object.assign(into, entries),
    lengthBytesUTF8: (text: string) => Buffer.byteLength(text),
    _malloc: () => memory.size + 1,
    stringToUTF8: (text: string, at: number) => memory.set(at, text),
  };
  vm.runInNewContext(await readFile(JSLIB, "utf8"), context);
  // Emscripten links a `$name` helper under its bare name for the functions that depend on it.
  context.GenexGameText = (library.$GenexGameText as (...args: unknown[]) => unknown).bind(context);
  vm.createContext(context);
  context.GenexGameRegions = vm.runInContext(`(${String(library.$GenexGameRegions)})`, context);
  const call = (name: string): string => {
    const fn = vm.runInContext(`(${String(library[name])})`, context) as () => number;
    return memory.get(fn()) ?? "";
  };
  return call;
}

const page = (href: string, extra: Record<string, unknown> = {}) => {
  const url = new URL(href);
  return { location: { search: url.search, hostname: url.hostname, href }, ...extra };
};

describe("GenexGame in a WebGL build", () => {
  it("joins Studio's local room only at a ws:// loopback room named on a loopback page", async () => {
    const cases: Array<[string, string, string]> = [
      ["the preview's room", "http://127.0.0.1:51234/?genex_authority_url=ws://127.0.0.1:2567", "ws://127.0.0.1:2567"],
      ["on localhost", "http://localhost:5173/?genex_authority_url=ws://localhost:2567", "ws://localhost:2567"],
      ["on IPv6 loopback", "http://[::1]:5173/?genex_authority_url=ws://[::1]:2567", "ws://[::1]:2567"],
      ["no room named", "http://127.0.0.1:51234/", ""],
      ["a published page", "https://genex.games/play/x?genex_authority_url=ws://127.0.0.1:2567", ""],
      ["a room off this computer", "http://127.0.0.1:51234/?genex_authority_url=ws://evil.example:2567", ""],
      ["a secure room", "http://127.0.0.1:51234/?genex_authority_url=wss://127.0.0.1:2567", ""],
      ["an http address", "http://127.0.0.1:51234/?genex_authority_url=http://127.0.0.1:2567", ""],
      ["not an address", "http://127.0.0.1:51234/?genex_authority_url=%20nope", ""],
      ["a lookalike host", "http://127.0.0.1:51234/?genex_authority_url=ws://127.0.0.1.evil.example:2567", ""],
    ];
    for (const [name, href, expected] of cases)
      assert.equal((await linked(page(href)))("GenexGame_LocalRoomUrl"), expected, name);
  });

  it("reads the published page's room servers and project, and none where the page names none", async () => {
    const published = page("https://genex.games/play/arena", {
      __GENEX__: { slug: "arena" },
      genexEmbed: { getAuthorityUrls: () => ["wss://a.genex.games", "", 7, "wss://b.genex.games"] },
    });
    const call = await linked(published);
    assert.equal(call("GenexGame_PageAuthorityUrls"), "wss://a.genex.games\nwss://b.genex.games");
    assert.equal(call("GenexGame_PageSlug"), "arena");
    const bare = await linked(page("http://127.0.0.1:51234/"));
    assert.equal(bare("GenexGame_PageAuthorityUrls"), "");
    assert.equal(bare("GenexGame_PageSlug"), "");
    const throwing = page("https://genex.games/play/arena", {
      genexEmbed: {
        getAuthorityUrls: () => {
          throw new Error("not initialised");
        },
      },
    });
    assert.equal((await linked(throwing))("GenexGame_PageAuthorityUrls"), "");
  });

  it("reads the page's room servers by region, one region a line, its name and urls tab-separated", async () => {
    const regions = [
      { region: "asia", urls: ["wss://asia.genex.games:8443", "wss://asia.genex.games"] },
      { region: "eu", urls: ["wss://eu.genex.games:2053", "", 7] },
      { region: "us", urls: [] },
      { region: "", urls: ["wss://nameless.genex.games"] },
      { region: "a\tb", urls: ["wss://tab.genex.games"] },
      { region: "line", urls: ["wss://x.genex.games\nwss://y.genex.games"] },
      { region: 9, urls: ["wss://number.genex.games"] },
      null,
      "asia",
    ];
    const call = await linked(
      page("https://genex.games/play/arena", { genexEmbed: { getAuthorityRegions: () => regions } }),
    );
    assert.equal(
      call("GenexGame_PageAuthorityRegions"),
      "asia\twss://asia.genex.games:8443\twss://asia.genex.games\neu\twss://eu.genex.games:2053",
    );
  });

  it("names the page's home region only when it is one of the page's regions", async () => {
    const regions = () => [
      { region: "asia", urls: ["wss://asia.genex.games"] },
      { region: "eu", urls: ["wss://eu.genex.games"] },
    ];
    const cases: Array<[string, unknown, string]> = [
      ["a region of the list", () => "asia", "asia"],
      ["a region the list lacks", () => "us", ""],
      ["empty", () => "", ""],
      ["not a string", () => 7, ""],
      ["absent", () => undefined, ""],
      [
        "throws",
        () => {
          throw new Error("not initialised");
        },
        "",
      ],
      ["an SDK without the call", undefined, ""],
    ];
    for (const [name, getAuthorityHome, expected] of cases) {
      const embed = { getAuthorityRegions: regions, ...(getAuthorityHome ? { getAuthorityHome } : {}) };
      const call = await linked(page("https://genex.games/play/arena", { genexEmbed: embed }));
      assert.equal(call("GenexGame_PageAuthorityHome"), expected, name);
    }
    const bare = await linked(page("http://127.0.0.1:51234/"));
    assert.equal(bare("GenexGame_PageAuthorityRegions"), "");
    assert.equal(bare("GenexGame_PageAuthorityHome"), "");
  });
});
