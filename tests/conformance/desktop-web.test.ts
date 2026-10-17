/**
 * Web pages read and driven by their structure: cua-driver's browser tools behind the studio's
 * guards. Fake calls record what would reach the browser, so each guard is proven by nothing
 * reaching it; the shapes are the ones cua-driver 0.34.0 answered with on a real Mac.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { asksForSecret, guardedWeb, openableUrl } from "../../src/main/core/desktop-web.ts";
import { computerActionsFor, parseComputerArgs } from "../../src/substrate/computer-tool.ts";
import { BROWSER_CAPABILITIES, DESKTOP_CAPABILITIES } from "../../src/shared/computer-target.ts";
import { cuaWeb, pageText } from "../../src/substrate/cua-web.ts";
import type { DesktopApp, DesktopWeb, WebElement, WebSnapshot } from "../../src/substrate/desktop-driver.ts";

const CHROME: DesktopApp = { name: "Google Chrome", bundleId: "com.google.Chrome", pid: 82634 };

/** cua's outline and refs for a search page and a login form, as a real snapshot gave them. */
const OUTLINE = [
  "- banner",
  '- link "Wikipedia The Free Encyclopedia" [focusable=true]',
  '  - statictext "Wikipedia"',
  "- search",
  '  - searchbox "Search Wikipedia" [editable="plaintext",focusable=true]',
  '  - button "Search" [focusable=true]',
  "- generic",
  '  - statictext "is an open source"',
  '  - link "MIT License" [focusable=true]',
  '    - statictext "MIT License"',
  '  - statictext "released under the"',
].join("\n");
const REFS = [
  {
    ref: "p1:0",
    role: "link",
    name: "Wikipedia The Free Encyclopedia",
    actions: ["click", "pointer"],
    visibility: "in_viewport",
  },
  { ref: "p1:1", role: "statictext", name: "Wikipedia", actions: ["click", "pointer"], visibility: "in_viewport" },
  {
    ref: "p1:3",
    role: "searchbox",
    name: "Search Wikipedia",
    actions: ["type", "pointer"],
    value: "Godot",
    visibility: "near_viewport",
  },
  { ref: "p1:4", role: "button", name: "Search", actions: ["click", "pointer"], visibility: "in_viewport" },
  { ref: "p1:9", role: "link", name: "MIT License", actions: ["click", "pointer"], visibility: "in_viewport" },
];

describe("a web page as the model reads it", () => {
  it("is the page in document order, every control with its ref inline, text without a ref, no word said twice", () => {
    assert.equal(
      pageText(OUTLINE, REFS),
      [
        '[p1:0] link "Wikipedia The Free Encyclopedia"',
        ' [p1:3] searchbox "Search Wikipedia" = "Godot" (near viewport)',
        ' [p1:4] button "Search"',
        " is an open source",
        ' [p1:9] link "MIT License"',
        " released under the",
      ].join("\n"),
    );
  });
});

/** A refusal as the cua client throws it: the driver's words, and its code. */
function refused(tool: string, code: string): Error {
  return Object.assign(new Error(`cua-driver ${tool} failed: ${code}`), { code });
}

/** A login form's DOM refs as `dom_refs_v1` lists them: a password input carries no label of its own. */
const LOGIN_DOM = [
  { node: "input", label: "name=authenticity_token type=hidden value=abc", ref: "p1:0" },
  { node: "input", label: "aria-label=Search Wikipedia name=search id=searchInput type=search", ref: "p1:1" },
  { node: "input", label: "name=password id=password type=password", ref: "p1:2" },
  { node: "input", label: "placeholder=enter it type=password", ref: "p1:3" },
  { node: "button", label: null, ref: "p1:4" },
];

interface FakeCuaOptions {
  trustedClickRefused?: boolean;
  /** The launched browser's windows, in the order the driver lists them; the first binds unless refused. */
  windows?: Array<{ id: number; binds: boolean }>;
  /** The DOM refs `dom_refs_v1` answers; none when absent. */
  dom?: unknown[];
  /** The refs `semantic_v2` answers. */
  refs?: unknown[];
  /** A browser the person closed: the first navigation finds its binding stale. */
  closedOnce?: boolean;
}

/** A fake call over cua's browser tools: records every call, answers as a real driver did. */
function fakeCua(options: FakeCuaOptions = {}) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const windows = options.windows ?? [{ id: 5598, binds: true }];
  let closed = options.closedOnce ?? false;
  const call = async (tool: string, args: Record<string, unknown>) => {
    calls.push({ tool, args });
    if (tool === "browser_prepare") return { body: { prepared: true, prepared_pid: 82634 }, image: null };
    if (tool === "list_windows")
      return { body: { windows: windows.map((w) => ({ window_id: w.id, pid: 82634 })) }, image: null };
    if (tool === "get_browser_state" && args.window_id !== undefined) {
      if (!windows.find((w) => w.id === args.window_id)?.binds) throw refused(tool, "browser_wrong_target_refused");
      return { body: { target_id: "bt-1", tabs: [{ active: true, tab_id: "tab-1" }] }, image: null };
    }
    if (tool === "get_browser_state" && args.snapshot_format === "dom_refs_v1")
      return { body: { refs: options.dom ?? [], truncated: false }, image: null };
    if (tool === "get_browser_state")
      return {
        body: {
          page: { title: "Search", url: "https://en.wikipedia.org/" },
          outline: OUTLINE,
          refs: options.refs ?? REFS,
        },
        image: args.include_screenshot ? Buffer.from("png") : null,
      };
    if (tool === "browser_navigate" && closed) {
      closed = false;
      throw refused(tool, "browser_binding_stale");
    }
    if (tool === "browser_click" && args.delivery_mode === "foreground" && options.trustedClickRefused)
      throw refused(tool, "browser_input_trust_unavailable");
    return { body: { status: "ok" }, image: null };
  };
  const web = cuaWeb(call, { session: "genex-test", appOf: async () => CHROME });
  return { web, calls };
}

describe("cua-driver's browser tools as the studio's web pages", () => {
  it("launches a separate, clean browser — never the person's profile — and binds its tab, under one session label", async () => {
    const { web, calls } = fakeCua();
    assert.equal(web.opened(), false);
    assert.deepEqual(await web.browser(), CHROME);
    await web.navigate("https://en.wikipedia.org/");
    assert.deepEqual(calls[0], {
      tool: "browser_prepare",
      args: { allow_launch: true, profile: { mode: "isolated_new" }, session: "genex-test" },
    });
    assert.ok(!calls.some((c) => "strategy" in c.args), "never attaches to the person's own browser");
    const browserCalls = calls.filter((c) => c.tool.startsWith("browser_") || c.tool === "get_browser_state");
    assert.ok(
      browserCalls.every((c) => c.args.session === "genex-test"),
      "one session label on every browser call",
    );
    assert.deepEqual(calls.at(-1)?.args, {
      target_id: "bt-1",
      tab_id: "tab-1",
      session: "genex-test",
      url: "https://en.wikipedia.org/",
    });
  });

  it("follows a link through the page, presses a control in the foreground, and falls back when that is refused", async () => {
    const { web, calls } = fakeCua({ trustedClickRefused: true });
    await web.click("p1:9", "link");
    await web.click("p1:4", "button");
    const clicks = calls
      .filter((c) => c.tool === "browser_click")
      .map((c) => [c.args.ref, c.args.input_route ?? c.args.delivery_mode]);
    assert.deepEqual(clicks, [
      ["p1:9", "dom_event"],
      ["p1:4", "foreground"],
      ["p1:4", "dom_event"],
    ]);
  });

  it("types into a field replacing what it held, and presses Enter when asked to submit", async () => {
    const { web, calls } = fakeCua();
    await web.type("p1:3", "Godot Engine", false);
    await web.type("p1:3", "Godot Engine", true);
    const typed = calls.filter((c) => c.tool === "browser_type").map((c) => [c.args.text, c.args.mode, c.args.replace]);
    assert.deepEqual(typed, [
      ["Godot Engine", "insert_text", true],
      ["Godot Engine\n", "keystrokes", true],
    ]);
  });

  it("binds the window the driver can tie to the browser, when the launched browser shows another first", async () => {
    const { web, calls } = fakeCua({
      windows: [
        { id: 464, binds: false },
        { id: 475, binds: true },
      ],
    });
    await web.navigate("https://en.wikipedia.org/");
    const binds = calls.filter((c) => c.tool === "get_browser_state" && c.args.window_id !== undefined);
    assert.deepEqual(
      binds.map((c) => c.args.window_id),
      [464, 475],
    );
    assert.equal(calls.at(-1)?.tool, "browser_navigate");
  });

  it("opens a fresh browser once when the person closed the one it had, and says so for any other verb", async () => {
    const reopened = fakeCua({ closedOnce: true });
    await reopened.web.navigate("https://en.wikipedia.org/");
    await reopened.web.navigate("https://en.wikipedia.org/");
    assert.equal(reopened.calls.filter((c) => c.tool === "browser_prepare").length, 2, "launched again once");
    assert.equal(reopened.calls.filter((c) => c.tool === "browser_navigate").length, 3);
  });

  it("marks a field the page's DOM types as a password, though its name says nothing of a secret", async () => {
    const refs = [
      { ref: "p2:0", role: "searchbox", name: "Search Wikipedia", actions: ["type", "pointer"] },
      { ref: "p2:1", role: "textbox", name: "enter it", actions: ["type", "pointer"] },
      { ref: "p2:2", role: "textbox", name: "Secret thing", actions: ["type", "pointer"] },
      { ref: "p2:3", role: "button", name: "Go", actions: ["click", "pointer"] },
      // A submit input, which cua lists as typable too (GitHub's Sign in): pressed, never a field.
      { ref: "p2:5", role: "button", name: "Sign in", actions: ["type", "click", "pointer"] },
      // A field's inner editor, as cua lists it beside the field: no control of its own.
      { ref: "p2:4", role: "generic", name: null, actions: ["type"], visibility: "unknown" },
    ];
    const { web, calls } = fakeCua({ dom: LOGIN_DOM, refs });
    const page = await web.snapshot({ picture: false });
    assert.deepEqual(
      page.elements.map((e) => [e.ref, e.secret]),
      [
        ["p2:0", false],
        ["p2:1", true],
        // The page has a password input labelled only by its <label>: a field no label places is taken for it.
        ["p2:2", true],
        ["p2:3", false],
        ["p2:5", false],
      ],
    );
    assert.match(page.text, /\[p2:1\] textbox "enter it" \(asks for a secret: never typed into\)/);
    const reads = calls.filter((c) => c.tool === "get_browser_state" && c.args.snapshot_format);
    assert.deepEqual(
      reads.map((c) => c.args.snapshot_format),
      ["dom_refs_v1", "semantic_v2"],
      "the structural read comes last, so its refs are the live ones",
    );
  });

  it("takes no field for a secret on a page without a password input", async () => {
    const refs = [{ ref: "p2:0", role: "textbox", name: "Secret thing", actions: ["type", "pointer"] }];
    const { web } = fakeCua({ dom: LOGIN_DOM.filter((row) => !row.label?.includes("type=password")), refs });
    assert.deepEqual(
      (await web.snapshot({ picture: false })).elements.map((e) => e.secret),
      [false],
    );
  });

  it("reads the page with its controls, and its picture only when asked", async () => {
    const { web } = fakeCua();
    const plain = await web.snapshot({ picture: false });
    assert.equal(plain.shot, null);
    assert.deepEqual(
      plain.elements.map((e) => e.ref),
      ["p1:0", "p1:3", "p1:4", "p1:9"],
      "a text run is no control",
    );
    assert.ok((await web.snapshot({ picture: true })).shot);
  });
});

/** A site that records what reached the browser. */
function recordingSite(snapshot: Partial<WebSnapshot> = {}) {
  const reached: string[] = [];
  let open = false;
  const page: WebSnapshot = {
    title: "Sign in",
    url: "https://example.com/login",
    text: "",
    elements: [
      { ref: "p2:0", role: "textbox", name: "Username or email address", editable: true, secret: false },
      { ref: "p2:1", role: "textbox", name: "Password", editable: true, secret: false },
      { ref: "p2:2", role: "textbox", name: "Пароль", editable: true, secret: false },
      { ref: "p2:3", role: "textbox", name: "Card number", editable: true, secret: false },
      { ref: "p2:4", role: "textbox", name: "CVC", editable: true, secret: false },
      { ref: "p2:5", role: "textbox", name: "PIN", editable: true, secret: false },
      { ref: "p2:6", role: "button", name: "Sign in", editable: false, secret: false },
      { ref: "p2:7", role: "textbox", name: "Secret thing", editable: true, secret: true },
    ],
    shot: null,
    ...snapshot,
  };
  const site: DesktopWeb = {
    opened: () => open,
    browser: async () => {
      open = true;
      return CHROME;
    },
    navigate: async (url) => {
      reached.push(`navigate ${url}`);
    },
    snapshot: async () => page,
    click: async (ref) => {
      reached.push(`click ${ref}`);
    },
    type: async (ref, text) => {
      reached.push(`type ${ref} ${text}`);
    },
  };
  return { site, reached };
}

describe("the studio's guards on web pages", () => {
  it("asks for the browser once, as an app — not each website", async () => {
    const { site, reached } = recordingSite();
    const asked: string[] = [];
    const web = guardedWeb(site, {
      allowApp: async (app) => (asked.push(app.name), true),
      neverDriven: () => false,
    });
    await web.open("https://example.com/login", { picture: false });
    await web.open("https://another.example.org/", { picture: false });
    await web.type("p2:0", "genex", { submit: false, picture: false });
    assert.deepEqual([...new Set(asked)], ["Google Chrome"], "one app, whatever the sites");
    assert.deepEqual(reached, [
      "navigate https://example.com/login",
      "navigate https://another.example.org/",
      "type p2:0 genex",
    ]);
  });

  const hostile: Array<{ name: string; run: (web: ReturnType<typeof guardedWeb>) => Promise<unknown>; why: RegExp }> = [
    { name: "a script URL", run: (w) => w.open("javascript:alert(1)", { picture: false }), why: /only http/ },
    { name: "a file URL", run: (w) => w.open("file:///etc/passwd", { picture: false }), why: /only http/ },
    { name: "a data URL", run: (w) => w.open("data:text/html,<b>x</b>", { picture: false }), why: /only http/ },
    { name: "no address", run: (w) => w.open("   ", { picture: false }), why: /only http/ },
    { name: "reading before any page is open", run: (w) => w.read({ picture: false }), why: /no page is open/ },
  ];
  for (const row of hostile) {
    it(`refuses ${row.name}, and nothing reaches the browser`, async () => {
      const { site, reached } = recordingSite();
      const web = guardedWeb(site, { allowApp: async () => true, neverDriven: () => false });
      await assert.rejects(row.run(web), row.why);
      assert.deepEqual(reached, []);
    });
  }

  for (const ref of ["p2:1", "p2:2", "p2:3", "p2:4", "p2:5", "p2:7"]) {
    it(`never types into a field that asks for a secret (${ref})`, async () => {
      const { site, reached } = recordingSite();
      const web = guardedWeb(site, { allowApp: async () => true, neverDriven: () => false });
      await web.open("https://example.com/login", { picture: false });
      await assert.rejects(web.type(ref, "hunter2", { submit: true, picture: false }), /asks for a secret/);
      assert.deepEqual(reached, ["navigate https://example.com/login"]);
    });
  }

  it("acts only on a ref the page lists, and nothing moves in a browser the person declined", async () => {
    const listed = recordingSite();
    const web = guardedWeb(listed.site, { allowApp: async () => true, neverDriven: () => false });
    await web.open("https://example.com/login", { picture: false });
    await assert.rejects(web.click("p9:99", { picture: false }), /not on the page now/);
    assert.deepEqual(listed.reached, ["navigate https://example.com/login"]);

    const declined = recordingSite();
    const refused = guardedWeb(declined.site, { allowApp: async () => false, neverDriven: () => false });
    await assert.rejects(refused.open("https://example.com/", { picture: false }), /did not allow Google Chrome/);
    assert.deepEqual(declined.reached, []);
  });

  it("knows a web address from anything else, and a secret field by its name", () => {
    assert.equal(openableUrl("https://example.com"), true);
    assert.equal(openableUrl("http://localhost:3000/x"), true);
    assert.equal(openableUrl("ftp://example.com"), false);
    assert.equal(asksForSecret({ role: "textbox", name: "Search" }), false);
    assert.equal(asksForSecret({ role: "textbox", name: "Confirm password" }), true);
  });
});

/** A site whose every reading renumbers its refs, as cua's snapshots do (p1:… then p2:…). */
function renumberingSite(elements: Array<Pick<WebElement, "role" | "name" | "editable">>) {
  const reached: string[] = [];
  let reading = 0;
  const site: DesktopWeb = {
    opened: () => true,
    browser: async () => CHROME,
    navigate: async () => {},
    snapshot: async () => {
      reading += 1;
      const listed = elements.map((e, i) => ({ ...e, ref: `p${reading}:${i}`, secret: false }));
      return { title: "Search", url: "https://example.com/", text: "", elements: listed, shot: null };
    },
    click: async (ref) => {
      reached.push(`click ${ref}`);
    },
    type: async (ref, text) => {
      reached.push(`type ${ref} ${text}`);
    },
  };
  return { site, reached };
}

describe("refs as a model writes them", () => {
  const guard = { allowApp: async () => true, neverDriven: () => false };

  it("takes a ref from an earlier reading for the same element on the page now, when only one is", async () => {
    const { site, reached } = renumberingSite([
      { role: "searchbox", name: "Search Wikipedia", editable: true },
      { role: "link", name: "English", editable: false },
    ]);
    const web = guardedWeb(site, guard);
    await web.read({ picture: false });
    await web.read({ picture: false });
    await web.type("p1:0", "Godot", { submit: true, picture: false });
    assert.deepEqual(reached, ["type p2:0 Godot"], "the searchbox as the page lists it now");
  });

  it("refuses an earlier ref when two elements on the page now share its role and name", async () => {
    const { site, reached } = renumberingSite([
      { role: "link", name: "Edit", editable: false },
      { role: "link", name: "Edit", editable: false },
    ]);
    const web = guardedWeb(site, guard);
    await web.read({ picture: false });
    await web.read({ picture: false });
    await assert.rejects(web.click("p1:0", { picture: false }), /not on the page now/);
    assert.deepEqual(reached, []);
  });

  it("reads the ref out of the page's whole line, as a small model copies it", () => {
    for (const written of ['[p123:0] searchbox "Search Wikipedia"', "[p123:0]", "p123:0", " p123:0 "]) {
      const parsed = parseComputerArgs({ action: "web_click", ref: written });
      assert.equal(parsed.ok && parsed.request.ref, "p123:0", written);
    }
  });
});

describe("the web verbs in the tool", () => {
  it("are offered only where a target reads pages by their structure, and say what they need", () => {
    assert.ok(computerActionsFor(DESKTOP_CAPABILITIES).includes("web_open"));
    assert.ok(!computerActionsFor(BROWSER_CAPABILITIES).includes("web_open"), "a game's window has no web verbs");
    const missing = parseComputerArgs({ action: "web_click" });
    assert.equal(missing.ok, false);
    const typed = parseComputerArgs({ action: "web_type", ref: "p1:3", text: "Godot", submit: "true" });
    assert.deepEqual(typed.ok && [typed.request.ref, typed.request.submit], ["p1:3", true]);
  });
});
