/**
 * The Genex plugin's publish in a development profile pointed at a stand (a local or test copy of
 * genex.games, `play/origins.ts`). Exactly as `genex__cli` does, its backend then talks to the
 * stand's API as the stand's own account, the one the profile signed in to: the host names the API
 * in the backend's environment and hands the stand's token as its session lease, and the plugin's
 * own saved genex.games account is neither read nor written. Every other launch (the released app,
 * a packaged or fixture launch, a profile with no stand) keeps genex.games and the plugin's account.
 */
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { GENEX_PLUGIN_ID, genexPluginAccount, launchStand } from "../../src/main/core/genex-cli.ts";
import { devStand, type LaunchKind, PlayOriginEnv } from "../../src/main/play/origins.ts";
import { createGenexPlugin, hostApiOf, hostCaOf, hostGamesOf } from "../../src/plugins/genex/backend.ts";
import { stagingLink } from "../../src/plugins/genex/publish.ts";
import { genexCliEnv, runGenexCli } from "../../src/plugins/genex/cli.ts";
import { GenexAction } from "../../src/shared/genex.ts";
import type { PluginManifest } from "../../src/shared/plugins.ts";
import {
  PLUGIN_API_ENV,
  PLUGIN_CA_ENV,
  PLUGIN_GAMES_ENV,
  pluginBackendEnv,
} from "../../src/substrate/plugins/process.ts";
import { PluginRegistry } from "../../src/substrate/plugins/registry.ts";
import { EXAMPLE_PLUGIN, PLUGIN_SDK_BACKEND } from "../helpers/plugins.ts";
import { removeTree } from "../helpers/tmp.ts";

const STAND_API = "http://localhost:3000";
const STAND_GAMES = "https://localhost:8443";
const STAND_CA = "/tmp/stand/certs/ca.pem";
const STAND_TOKEN = "stand-session-token-synthetic";
const SAVED_TOKEN = "genex-games-token-synthetic";
const token = async () => STAND_TOKEN;
/** A development stand's whole environment: its API, its game host and its own CA. */
const STAND_ENV = {
  [PlayOriginEnv.Api]: STAND_API,
  [PlayOriginEnv.Games]: STAND_GAMES,
  [PlayOriginEnv.GamesCa]: STAND_CA,
};

const launches: ReadonlyArray<[string, LaunchKind, boolean]> = [
  ["the released app", { developerProfile: false, packaged: true, fixture: false }, false],
  ["a packaged app started as a developer profile", { developerProfile: true, packaged: true, fixture: false }, false],
  ["a packaged fixture launch", { developerProfile: true, packaged: true, fixture: true }, false],
  ["the normal profile from a checkout", { developerProfile: false, packaged: false, fixture: false }, false],
  ["a smoke or self-test run", { developerProfile: false, packaged: false, fixture: true }, false],
  ["a fixture development profile", { developerProfile: true, packaged: false, fixture: true }, false],
  ["a live development profile", { developerProfile: true, packaged: false, fixture: false }, true],
];

describe("which launches publish to a stand", () => {
  for (const [name, launch, onStand] of launches)
    it(`${onStand ? "publishes to the stand" : "keeps genex.games"} for ${name}`, () => {
      const account = genexPluginAccount(launchStand(devStand(STAND_ENV, launch), token));
      if (!onStand) {
        assert.equal(account, undefined);
        return;
      }
      assert.equal(account?.id, GENEX_PLUGIN_ID);
      assert.equal(account?.api, STAND_API);
      assert.equal(
        account?.ca,
        STAND_CA,
        "its publish trusts the stand's own CA, which signs its source and game hosts",
      );
      assert.equal(account?.games, STAND_GAMES, "its publish tests the draft on the stand's own game host");
    });

  it("names a game host only beside the stand's own API", () => {
    const development = { developerProfile: true, packaged: false, fixture: false };
    const gamesOf = (env: Record<string, string>) =>
      genexPluginAccount(launchStand(devStand(env, development), token))?.games;
    assert.equal(gamesOf({ [PlayOriginEnv.Games]: STAND_GAMES }), undefined);
    assert.equal(gamesOf({ [PlayOriginEnv.Api]: STAND_API }), undefined, "genex.games' own game host is never named");
    assert.equal(gamesOf({ [PlayOriginEnv.Api]: STAND_API, [PlayOriginEnv.Games]: "http://evil.example" }), undefined);
  });

  it("trusts a CA only beside the stand's own API and game host, and only one named as an absolute path", () => {
    const development = { developerProfile: true, packaged: false, fixture: false };
    const caOf = (env: Record<string, string>) =>
      genexPluginAccount(launchStand(devStand(env, development), token))?.ca;
    assert.equal(caOf({ [PlayOriginEnv.Games]: STAND_GAMES, [PlayOriginEnv.GamesCa]: STAND_CA }), undefined);
    assert.equal(caOf({ [PlayOriginEnv.Api]: STAND_API, [PlayOriginEnv.GamesCa]: STAND_CA }), undefined);
    for (const ca of ["", "certs/ca.pem", "./ca.pem", "../ca.pem", `/tmp/a\u0000b.pem`, `/${"a".repeat(1100)}.pem`])
      assert.equal(caOf({ ...STAND_ENV, [PlayOriginEnv.GamesCa]: ca }), undefined, JSON.stringify(ca.slice(0, 40)));
  });

  it("keeps genex.games for a development profile with no stand API, or one that does not read", () => {
    const development = { developerProfile: true, packaged: false, fixture: false };
    for (const api of [undefined, "", "https://api.genex.games", "ftp://localhost:3000", "http://evil.example"]) {
      const stand = launchStand(devStand({ [PlayOriginEnv.Api]: api }, development), token);
      assert.equal(genexPluginAccount(stand), undefined, String(api));
    }
  });
});

describe("the API a plugin backend is told to use", () => {
  it("comes from the host only: a parent's variable never reaches the backend", () => {
    const parent = {
      HOME: "/home/x",
      PATH: "/usr/bin",
      [PLUGIN_API_ENV]: "https://evil.example",
      [PLUGIN_CA_ENV]: "/tmp/evil-ca.pem",
      [PLUGIN_GAMES_ENV]: "https://evil.example",
      NODE_EXTRA_CA_CERTS: "/tmp/evil-ca.pem",
    };
    const bare = pluginBackendEnv(parent, "darwin");
    assert.equal(bare[PLUGIN_API_ENV], undefined);
    assert.equal(bare[PLUGIN_CA_ENV], undefined);
    assert.equal(bare.NODE_EXTRA_CA_CERTS, undefined);
    const onStand = pluginBackendEnv(parent, "darwin", undefined, undefined, { api: STAND_API });
    assert.equal(onStand[PLUGIN_API_ENV], STAND_API);
    assert.equal(onStand[PLUGIN_CA_ENV], undefined, "no CA unless the host names the stand's");
    assert.equal(onStand.NODE_EXTRA_CA_CERTS, undefined);
    const withCa = pluginBackendEnv(parent, "darwin", undefined, undefined, {
      api: STAND_API,
      ca: STAND_CA,
      games: STAND_GAMES,
    });
    assert.equal(withCa[PLUGIN_CA_ENV], STAND_CA);
    assert.equal(withCa[PLUGIN_GAMES_ENV], STAND_GAMES);
    assert.equal(bare[PLUGIN_GAMES_ENV], undefined);
    assert.equal(withCa.NODE_EXTRA_CA_CERTS, STAND_CA, "the backend's own requests to the stand trust it too");
  });

  const hostile: ReadonlyArray<[string, string | undefined]> = [
    ["none", undefined],
    ["empty", ""],
    ["a path", "http://localhost:3000/api"],
    ["a query", "http://localhost:3000/?x=1"],
    ["credentials", "http://user:pass@localhost:3000"],
    ["another scheme", "file:///etc/passwd"],
    ["script", "javascript:alert(1)"],
    ["no URL", "localhost:3000"],
    ["a line break", "http://localhost:3000\n"],
  ];
  for (const [name, raw] of hostile)
    it(`leaves the Genex backend on genex.games for ${name}`, () => {
      assert.equal(hostApiOf({ [PLUGIN_API_ENV]: raw }), undefined);
    });

  it("takes a bare origin", () => {
    assert.equal(hostApiOf({ [PLUGIN_API_ENV]: STAND_API }), STAND_API);
    assert.equal(hostApiOf({ [PLUGIN_API_ENV]: "https://api.stand.test" }), "https://api.stand.test");
  });
});

describe("the CA a Genex backend's CLI runs trust", () => {
  const hostile: ReadonlyArray<[string, Record<string, string | undefined>]> = [
    ["no CA", { [PLUGIN_API_ENV]: STAND_API }],
    ["a CA without the stand's API", { [PLUGIN_CA_ENV]: STAND_CA }],
    ["a CA beside an API that does not read", { [PLUGIN_API_ENV]: "localhost:3000", [PLUGIN_CA_ENV]: STAND_CA }],
    ["an empty path", { [PLUGIN_API_ENV]: STAND_API, [PLUGIN_CA_ENV]: "" }],
    ["a relative path", { [PLUGIN_API_ENV]: STAND_API, [PLUGIN_CA_ENV]: "certs/ca.pem" }],
    ["a traversal", { [PLUGIN_API_ENV]: STAND_API, [PLUGIN_CA_ENV]: "../../ca.pem" }],
    ["a line break", { [PLUGIN_API_ENV]: STAND_API, [PLUGIN_CA_ENV]: `${STAND_CA}\nGIT_SSL_NO_VERIFY=1` }],
    ["a control character", { [PLUGIN_API_ENV]: STAND_API, [PLUGIN_CA_ENV]: "/tmp/a\u0000.pem" }],
    ["an oversized path", { [PLUGIN_API_ENV]: STAND_API, [PLUGIN_CA_ENV]: `/${"a".repeat(1100)}.pem` }],
  ];
  for (const [name, env] of hostile)
    it(`trusts nothing more for ${name}`, () => {
      assert.equal(hostCaOf(env), undefined);
    });

  it("takes the stand's CA as an absolute path beside the stand's API", () => {
    assert.equal(hostCaOf({ [PLUGIN_API_ENV]: STAND_API, [PLUGIN_CA_ENV]: STAND_CA }), STAND_CA);
  });

  it("hands a run that CA for Node and git, and never a parent's own", () => {
    const parent = { PATH: "/usr/bin", NODE_EXTRA_CA_CERTS: "/tmp/evil.pem", GIT_SSL_CAINFO: "/tmp/evil.pem" };
    const plain = genexCliEnv(parent, { api: STAND_API, home: "/tmp/publish/home" });
    assert.equal(plain.NODE_EXTRA_CA_CERTS, undefined);
    assert.equal(plain.GIT_SSL_CAINFO, undefined);
    const trusting = genexCliEnv(parent, { api: STAND_API, home: "/tmp/publish/home", ca: STAND_CA });
    assert.equal(trusting.NODE_EXTRA_CA_CERTS, STAND_CA);
    assert.equal(trusting.GIT_SSL_CAINFO, STAND_CA);
  });

  it("reaches a CLI run the backend starts", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "studio-genex-ca-run-"));
    try {
      const cli = path.join(dir, "cli.mjs");
      const preload = path.join(dir, "preload.mjs");
      await writeFile(
        cli,
        "process.stdout.write(JSON.stringify([process.env.NODE_EXTRA_CA_CERTS ?? null, process.env.GIT_SSL_CAINFO ?? null]));\n",
      );
      await writeFile(preload, "");
      const run = {
        cli,
        preload,
        api: STAND_API,
        token: "stand-run-token-synthetic",
        cwd: dir,
        args: [],
        signal: undefined,
        timeoutMs: 20_000,
        parse: false,
        home: dir,
      };
      assert.deepEqual(await runGenexCli({ ...run, ca: STAND_CA }), { out: JSON.stringify([STAND_CA, STAND_CA]) });
      assert.deepEqual(await runGenexCli(run), { out: JSON.stringify([null, null]) });
    } finally {
      await removeTree(dir);
    }
  });
});

describe("the stand game host a Genex backend tests its draft on", () => {
  const hostile: ReadonlyArray<[string, Record<string, string | undefined>]> = [
    ["no game host", { [PLUGIN_API_ENV]: STAND_API }],
    ["a game host without the stand's API", { [PLUGIN_GAMES_ENV]: STAND_GAMES }],
    ["a path", { [PLUGIN_API_ENV]: STAND_API, [PLUGIN_GAMES_ENV]: `${STAND_GAMES}/games` }],
    ["credentials", { [PLUGIN_API_ENV]: STAND_API, [PLUGIN_GAMES_ENV]: "https://u:p@localhost:8443" }],
    ["another scheme", { [PLUGIN_API_ENV]: STAND_API, [PLUGIN_GAMES_ENV]: "ftp://localhost:8443" }],
    ["a line break", { [PLUGIN_API_ENV]: STAND_API, [PLUGIN_GAMES_ENV]: `${STAND_GAMES}\n` }],
  ];
  for (const [name, env] of hostile)
    it(`names none for ${name}`, () => {
      assert.equal(hostGamesOf(env), undefined);
    });

  it("takes a bare origin beside the stand's API", () => {
    assert.equal(hostGamesOf({ [PLUGIN_API_ENV]: STAND_API, [PLUGIN_GAMES_ENV]: STAND_GAMES }), STAND_GAMES);
  });

  const printed = (link: string) => `› Publishing…\n✓ Live. 🌐  ${link}\n`;
  const links: ReadonlyArray<[string, string]> = [
    ["the draft on the stand's game host", "https://preview--frost-axe.localhost:8443/"],
    ["a game on the stand's game host", "https://frost-axe.localhost:8443/"],
    ["genex.games' own draft", "https://preview--frost-axe.genex.technology/"],
  ];
  for (const [name, link] of links)
    it(`tests ${name}`, () => {
      assert.equal(stagingLink(printed(link), STAND_API, STAND_GAMES), link);
    });

  const refused: ReadonlyArray<[string, string]> = [
    ["another port", "https://preview--frost-axe.localhost:9443/"],
    ["plain http", "http://preview--frost-axe.localhost:8443/"],
    ["the game host itself", "https://localhost:8443/"],
    ["two labels down", "https://a.preview--frost-axe.localhost:8443/"],
    ["a look-alike host", "https://preview--frost-axe.evil-localhost:8443/"],
    ["the host inside another", "https://preview--frost-axe.localhost.evil.test:8443/"],
    ["credentials", "https://u:p@preview--frost-axe.localhost:8443/"],
  ];
  for (const [name, link] of refused)
    it(`never tests ${name}`, () => {
      assert.equal(stagingLink(printed(link), STAND_API, STAND_GAMES), undefined);
    });

  it("never tests a stand's game host it was not told of", () => {
    assert.equal(stagingLink(printed("https://preview--frost-axe.localhost:8443/"), STAND_API), undefined);
  });
});

/** A backend that reports the API it was told and the lease the host hands it, and tries to save a token. */
const BACKEND = `export async function activate(){return {
  async action(n,a,c){
    if(n==='whoami')return {api:process.env.${PLUGIN_API_ENV}??null,ca:process.env.${PLUGIN_CA_ENV}??null,games:process.env.${PLUGIN_GAMES_ENV}??null,extra:process.env.NODE_EXTRA_CA_CERTS??null,lease:await c.host('credentials.session',{})};
    if(n==='unlock'){await c.host('credentials.read',{});return {lease:await c.host('credentials.session',{})};}
    if(n==='connect'){await c.host('credentials.read',{});await c.host('credentials.write',{token:'saved-on-stand'});return {};}
    if(n==='disconnect'){await c.host('credentials.clear',{});return {};}
    return {};
  }};}`;

/** The example plugin as an account plugin whose backend is {@link BACKEND}, with a saved genex.games token. */
async function accountRegistry(stand: boolean) {
  const root = await mkdtemp(path.join(os.tmpdir(), "studio-publish-stand-"));
  const seed = path.join(root, "seeds", "example");
  await mkdir(path.dirname(seed), { recursive: true });
  await cp(EXAMPLE_PLUGIN, seed, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(seed, "plugin.json"), "utf8")) as PluginManifest;
  manifest.capabilities.push("credentials");
  manifest.actions.push(...["whoami", "unlock", "connect", "status"].map((name) => ({ name, label: name })), {
    name: "disconnect",
    label: "disconnect",
    confirmation: "Sign out",
  });
  manifest.account = { connect: "connect", unlock: "unlock", disconnect: "disconnect", status: "status" };
  await writeFile(path.join(seed, "plugin.json"), JSON.stringify(manifest));
  await writeFile(path.join(seed, "backend.mjs"), BACKEND);
  let saved: string | null = SAVED_TOKEN;
  const registry = new PluginRegistry(
    path.join(root, "installed"),
    path.join(root, "seeds"),
    PLUGIN_SDK_BACKEND,
    async (_id, method, args) => {
      if (method === "credentials.read") return saved;
      if (method === "credentials.write") saved = args.token;
      else if (method === "credentials.clear") saved = null;
      return method === "storage.root" ? path.join(root, "data") : undefined;
    },
  );
  registry.appAccount = { id: "example", actions: ["whoami", "unlock", "connect", "disconnect", "status"] };
  if (stand) registry.hostAccount = { id: "example", api: STAND_API, ca: STAND_CA, games: STAND_GAMES, token };
  await registry.init();
  return {
    registry,
    saved: () => saved,
    close: async () => {
      registry.cancel();
      await removeTree(root);
    },
  };
}

describe("a plugin's backend on a stand", () => {
  it("is told the stand's API and CA and holds the stand's token, never the saved genex.games one", async () => {
    const f = await accountRegistry(true);
    try {
      assert.deepEqual(await f.registry.action("example", "whoami", {}), {
        api: STAND_API,
        ca: STAND_CA,
        games: STAND_GAMES,
        extra: STAND_CA,
        lease: STAND_TOKEN,
      });
      assert.deepEqual(await f.registry.action("example", "unlock", {}), { lease: STAND_TOKEN });
      await assert.rejects(f.registry.action("example", "connect", {}), /stand/);
      await f.registry.action("example", "disconnect", {});
      assert.equal(f.saved(), SAVED_TOKEN, "the plugin's own saved account is untouched");
    } finally {
      await f.close();
    }
  });

  it("keeps genex.games and the saved account without a stand", async () => {
    const f = await accountRegistry(false);
    try {
      await f.registry.action("example", "unlock", {});
      assert.deepEqual(await f.registry.action("example", "whoami", {}), {
        api: null,
        ca: null,
        games: null,
        extra: null,
        lease: SAVED_TOKEN,
      });
    } finally {
      await f.close();
    }
  });
});

describe("the Genex backend on a stand", () => {
  it("takes the host's lease again at every call, so a sign-in or sign-out on the stand reaches its publish", async () => {
    let lease: string | null = STAND_TOKEN;
    const plugin = await createGenexPlugin("http://127.0.0.1:9", { hostAccount: true });
    const root = await mkdtemp(path.join(os.tmpdir(), "studio-genex-stand-"));
    const ctx = {
      host: async (method: string) => {
        if (method === "storage.root") return root;
        if (method === "credentials.session") return lease;
        return undefined;
      },
    };
    try {
      const signedIn = (await plugin.action(GenexAction.Status, {}, ctx)) as { connected: boolean };
      assert.equal(signedIn.connected, true);
      lease = null;
      const signedOut = (await plugin.action(GenexAction.Status, {}, ctx)) as { connected: boolean };
      assert.equal(signedOut.connected, false, "signed out of the stand, nothing is published as anyone");
    } finally {
      await removeTree(root);
    }
  });
});
