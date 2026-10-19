/**
 * One credential redactor (src/shared/redact.ts) replaced three pattern sets that disagreed: the
 * Codex sign-in line, the sign-in terminal and the dev control's log sanitizer. Each consumer must
 * still take out everything its old patterns took out; the old patterns are kept here, verbatim,
 * as the oracle. Plus `errorMessage`, the other small shared helper.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sanitizeLoginLine } from "../../src/main/codex-login.ts";
import { LoginTerminalOutput } from "../../src/main/terminal-login-output.ts";
import { errorMessage } from "../../src/shared/errors.ts";
import {
  containsSecret,
  credentialEnvValues,
  isCredentialName,
  redactContacts,
  redactDeep,
  redactSecrets,
  redactTokens,
  redactValues,
  secretRedactor,
} from "../../src/shared/redact.ts";

// The fake credentials the table hides; none may survive a redactor that removed it before.
const SECRETS = [
  "sk-ant-oat01-FAKE1",
  "SK-live-FAKE2",
  "eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl",
  "tok-FAKE3",
  "ref-FAKE4",
  "cap-FAKE5",
  "key-FAKE6",
  "idt-FAKE7",
  "a,b-FAKE8",
];
const LINES = [
  "Your key is sk-ant-oat01-FAKE1 — keep it safe",
  "SK-live-FAKE2",
  "session eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl ends",
  "access_token=tok-FAKE3",
  '{"refresh_token": "ref-FAKE4"}',
  "capability: cap-FAKE5",
  "api_key key-FAKE6",
  "id_token=idt-FAKE7",
  "authorization: Bearer tok-FAKE3",
  "Authorization=Bearer ref-FAKE4",
  "access_token=a,b-FAKE8",
  "Complete the sign-in in your browser, then come back",
];

/** The three pattern sets as they were, before `shared/redact.ts`. */
const BEFORE = {
  loginLine: (v: string) =>
    v
      .replace(/https?:\/\/[^\s<>"']+/g, "[sign-in link]")
      .replace(/\b(?:sk-[\w-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, "[redacted]")
      .replace(/((?:access_token|refresh_token|id_token|authorization)["']?\s*[:=]\s*)\S+/gi, "$1[redacted]"),
  terminalWord: (w: string) =>
    /https?:\/\/|\bsk-[\w-]+|\beyJ[\w-]+\.[\w-]+\.[\w-]+|(?:access_token|refresh_token|id_token|authorization)["']?[:=].+/i.test(
      w,
    ),
  devLog: (v: string) =>
    v.replace(/(Bearer\s+|(?:access_token|refresh_token|api_key|capability)["'=:\s]+)[^\s",}]+/gi, "$1[redacted]"),
};
const leaks = (text: string) => SECRETS.filter((secret) => text.includes(secret));
/** The sign-in terminal, word by word, as a person would see it. */
const terminal = (line: string) => {
  const out = new LoginTerminalOutput(() => {});
  return out.write(line) + out.end();
};

describe("one redactor, at least as strict as each of the three it replaced", () => {
  for (const line of LINES) {
    it(JSON.stringify(line), () => {
      for (const secret of leaks(line).filter((s) => !leaks(BEFORE.loginLine(line)).includes(s)))
        assert.ok(!sanitizeLoginLine(line).includes(secret), `sign-in line: ${secret}`);
      for (const secret of leaks(line).filter((s) => !leaks(BEFORE.devLog(line)).includes(s)))
        assert.ok(!redactSecrets(line).includes(secret), `dev log (sanitize applies it to every string): ${secret}`);
      const words = line.split(/(\s+)/);
      const before = words.map((w) => (w.trim() && BEFORE.terminalWord(w) ? "[redacted]" : w)).join("");
      for (const secret of leaks(line).filter((s) => !leaks(before).includes(s)))
        assert.ok(!terminal(line).includes(secret), `terminal: ${secret}`);
    });
  }

  it("says what it redacted and keeps the field names and ordinary words", () => {
    assert.equal(redactSecrets("authorization: Bearer tok-FAKE3"), "authorization: [redacted] [redacted]");
    assert.equal(redactSecrets('{"access_token":"tok-FAKE3"}'), '{"access_token":[redacted]');
    assert.equal(redactSecrets("key sk-ant-oat01-FAKE1."), "key [redacted].");
    assert.equal(
      redactSecrets("Complete the authorization in your browser"),
      "Complete the authorization in your browser",
    );
    assert.equal(containsSecret("Waiting for sign-in"), false);
    assert.equal(
      sanitizeLoginLine("Open https://auth.openai.com/x?code=1 id_token=idt-FAKE7"),
      "Open [sign-in link] id_token=[redacted]",
    );
  });

  it("the sign-in terminal still hides the value after a field name split across words", () => {
    assert.equal(terminal("authorization: tok-FAKE3 done"), "authorization: [redacted] done");
  });

  it("takes exact values out, skipping ones too short to be secrets", () => {
    assert.equal(redactValues("key=abcd1234 and abcd1234", ["abcd1234"]), "key=[redacted] and [redacted]");
    assert.equal(redactValues("a cat sat", ["a", "cat"], 4), "a cat sat");
    assert.equal(redactValues("nothing", []), "nothing");
  });
});

describe("token shapes the dev control's logs used to let through (SEC-5)", () => {
  it("takes out credential env assignments, OAuth callback codes and bare provider tokens", () => {
    for (const [line, secret] of [
      ["CLAUDE_CODE_OAUTH_TOKEN=FAKE3-value", "FAKE3-value"],
      ["export GENEX_TOKEN=FAKE4-value", "FAKE4-value"],
      ["AWS_SECRET_ACCESS_KEY=FAKE5/value", "FAKE5/value"],
      ["DB_PASSWORD=hunter2-FAKE", "hunter2-FAKE"],
      ["sk-ant-oat01-FAKE6", "sk-ant-oat01-FAKE6"],
      ["https://claude.ai/oauth/callback?code=FAKE7&state=x", "FAKE7"],
      ["https://example.test/cb?state=x&code=FAKE8", "FAKE8"],
      ["token ghp_FAKEaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa9", "ghp_FAKEaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa9"],
      ["github_pat_FAKE_aaaaaaaaaaaaaaaaaaaaaa", "github_pat_FAKE_aaaaaaaaaaaaaaaaaaaaaa"],
    ] as const) {
      const out = redactSecrets(line);
      assert.ok(!out.includes(secret), `${line} -> ${out}`);
      assert.ok(out.includes("[redacted]"), line);
    }
  });

  it("keeps the names and words around them readable", () => {
    assert.equal(redactSecrets("GENEX_TOKEN=FAKE4 done"), "GENEX_TOKEN=[redacted] done");
    assert.equal(redactSecrets("callback?code=FAKE7&state=s"), "callback?code=[redacted]&state=s");
    assert.equal(redactSecrets("MAX_TOKENS=4096 and exit code=1"), "MAX_TOKENS=4096 and exit code=1");
  });

  it("reads a field name only as a whole word, and `capability` only with its `=` or `:` (B1)", () => {
    assert.equal(redactSecrets("Add a capability to jump twice"), "Add a capability to jump twice");
    assert.equal(redactSecrets("The incapability of the boss"), "The incapability of the boss");
    assert.equal(redactSecrets("incapability=high"), "incapability=high");
    assert.equal(redactSecrets("capability: cap-FAKE5"), "capability: [redacted]");
    assert.equal(redactSecrets("my_api_key=key-FAKE6"), "my_api_key=[redacted]");
  });
});

describe("Genex API keys (`genex_sk_v1_…`, the eval ingest key among them) are credentials by shape (M0.S2)", () => {
  // Synthetic keys in the minted shape: the prefix and 43 base64url characters, `_` and `-` included.
  const KEY = "genex_sk_v1_FAKEaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1";
  const DASHED = "genex_sk_v1_FAKE-bbbbbbbb_cccccccccccccccccccccccccccccc2";
  const hostile = [
    ["a log line", `publishing 3 runs with ${KEY} to the admin route`],
    ["a JSON field", `{"ingest":"${KEY}","runs":3}`],
    ["a JSON field whose name says nothing", `{"value": "${DASHED}"}`],
    ["an env assignment the variable name does not give away", `GENEX_EVALS_INGEST=${KEY} npm run eval`],
    ["an env assignment named for a key", `export GENEX_EVALS_KEY=${DASHED}`],
    ["a flag", `--ingest=${DASHED} --publish-evidence`],
    ["a bearer header", `authorization: Bearer ${KEY}`],
    ["a key alone", KEY],
  ] as const;

  for (const [label, line] of hostile) {
    it(`takes the whole key out of ${label}`, () => {
      for (const redact of [redactSecrets, redactTokens]) {
        const out = redact(line);
        assert.ok(!out.includes("FAKE"), `${redact.name}: ${out}`);
        assert.ok(out.includes("[redacted]"), `${redact.name}: ${out}`);
      }
      assert.equal(containsSecret(line), true);
    });
  }

  it("keeps the words around the key", () => {
    assert.equal(redactTokens(`publishing with ${KEY} now`), "publishing with [redacted] now");
    assert.equal(redactSecrets(`{"ingest":"${DASHED}"}`), '{"ingest":"[redacted]"}');
  });

  const lookalikes = [
    "genex_sk_v2_FAKEaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1",
    "genex_sk_v1",
    "genex_sk_v1_…",
    "`genex_sk_v1_` plus its body",
    "genex_sk_v1_short",
    "genex_studio_v1_FAKEaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "the genex studio builds genex-games with genexify",
    "GENEX_HOME=/opt/genex GENEX_API=https://example.test",
  ];
  for (const text of lookalikes) {
    it(`leaves the lookalike ${JSON.stringify(text)} alone`, () => {
      assert.equal(redactSecrets(text), text);
      assert.equal(redactTokens(text), text);
      assert.equal(containsSecret(text), false);
    });
  }
});

describe("a connector value is a credential by its name, not by being in the secret store (B2)", () => {
  it("reads env and header names", () => {
    const names = [
      "WEATHER_API_KEY",
      "api_key",
      "GITHUB_TOKEN",
      "GITHUB_PAT",
      "DB_PASSWORD",
      "CLIENT_SECRET",
      "Authorization",
      "X-Api-Key",
      "Cookie",
      "BASE_URL",
      "ALLOWED_DIR",
      "MAX_TOKENS",
      "REGION",
      "Accept",
    ];
    assert.deepEqual(names.filter(isCredentialName), [
      "WEATHER_API_KEY",
      "api_key",
      "GITHUB_TOKEN",
      "GITHUB_PAT",
      "DB_PASSWORD",
      "CLIENT_SECRET",
      "Authorization",
      "X-Api-Key",
      "Cookie",
    ]);
  });
});

describe("the event log's redactor: held values and unmistakable token shapes only (B1)", () => {
  it("takes out held values, bearer values and provider tokens", () => {
    const redact = secretRedactor(() => ["held-FAKE-value"], redactTokens);
    assert.equal(
      redact("got held-FAKE-value, Bearer abc.def and sk-ant-oat01-FAKE1 ghp_FAKEaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa9"),
      "got [redacted], Bearer [redacted] and [redacted] [redacted]",
    );
  });

  it("leaves prose and code that only looks like a credential field alone", () => {
    const text =
      "Use the api_key field; Authorization: header docs; SPRITE_KEY=hero; game.html?code=level2; access_token=see-docs";
    assert.equal(secretRedactor(() => [], redactTokens)(text), text);
  });
});

describe("the redactor for everything Studio persists or hands to another agent (SEC-1)", () => {
  it("takes the values Studio holds out first, then anything token-shaped, longest value first", () => {
    const held = ["leased-connector-key", "leased-connector-key-2"];
    const redact = secretRedactor(() => held);
    assert.equal(redact("got leased-connector-key-2 and leased-connector-key"), "got [redacted] and [redacted]");
    assert.equal(redact("Bearer abc.def and sk-ant-oat01-FAKE1"), "Bearer [redacted] and [redacted]");
    held.push("rotated-later-value");
    assert.equal(
      redact("rotated-later-value"),
      "[redacted]",
      "the source is read on every call, so a value unlocked later is covered",
    );
  });

  it("skips values too short to be a credential", () => {
    assert.equal(secretRedactor(() => ["true", "1234567"])("true 1234567"), "true 1234567");
  });

  it("walks an event payload and redacts every string in it, keys and shape unchanged", () => {
    const leased = "mcp-leased-FAKE-value";
    const event = {
      type: "custom",
      event_type: "delegated.claude",
      payload: {
        kind: "tool_result",
        data: {
          content: [{ type: "text", text: `env\nCLAUDE_CODE_OAUTH_TOKEN=FAKE9\nWEATHER=${leased}` }],
          is_error: false,
          count: 3,
        },
        stderr: `warning ${leased}`,
      },
    };
    const clean = redactDeep(
      event,
      secretRedactor(() => [leased]),
    );
    const text = JSON.stringify(clean);
    assert.equal(text.includes(leased), false);
    assert.equal(text.includes("FAKE9"), false);
    assert.equal(clean.payload.data.count, 3);
    assert.equal(clean.payload.data.is_error, false);
    assert.equal(clean.event_type, "delegated.claude");
    assert.match(clean.payload.data.content[0]!.text, /CLAUDE_CODE_OAUTH_TOKEN=\[redacted\]/);
    assert.equal(event.payload.stderr, `warning ${leased}`, "the input is not changed in place");
  });

  it("finds the credential values in an environment by name, not every variable", () => {
    const values = credentialEnvValues({
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-FAKE-env",
      GENEX_TOKEN: "genex-FAKE-env-value",
      OPENAI_API_KEY: "sk-FAKE-openai-env",
      AWS_SECRET_ACCESS_KEY: "aws-FAKE-secret-env",
      SHORT_TOKEN: "abc",
      HOME: "/Users/someone",
      PATH: "/usr/bin:/bin",
      MAX_TOKENS: "4096",
      EMPTY_KEY: undefined,
    });
    assert.deepEqual(
      values.sort(),
      ["aws-FAKE-secret-env", "genex-FAKE-env-value", "sk-FAKE-openai-env", "sk-ant-oat01-FAKE-env"].sort(),
    );
  });
});

describe("contact redaction on a long run of word characters (a Report's 128 KiB prompt)", () => {
  it("stays linear: a megabyte with no address is read in one pass", () => {
    const text = `${"x".repeat(1024 * 1024)} write to mira@example.com`;
    const started = performance.now();
    const out = redactContacts(text);
    // A pattern that retries the whole run from every character takes minutes here.
    assert.ok(performance.now() - started < 2000, "contact redaction is linear in its input");
    assert.equal(out.endsWith("write to [redacted]"), true);
  });

  const rows: Array<[string, string, string]> = [
    ["an address in a sentence", "mail mira.k+games@example.co.uk now", "mail [redacted] now"],
    ["an address after punctuation", "(mira@example.com)", "([redacted])"],
    ["two addresses", "a@b.io, c@d.io", "[redacted], [redacted]"],
    ["a handle with no domain", "@mira said hi", "@mira said hi"],
  ];
  for (const [name, text, expected] of rows)
    it(`redacts ${name} as before`, () => {
      assert.equal(redactContacts(text), expected);
    });
});

describe("errorMessage: the words of whatever was thrown", () => {
  it("reads an Error, an error-shaped object, and anything else", () => {
    assert.equal(errorMessage(new TypeError("bad input")), "bad input");
    assert.equal(errorMessage({ message: "from another realm" }), "from another realm");
    assert.equal(errorMessage("plain string"), "plain string");
    assert.equal(errorMessage(null), "null");
    assert.equal(errorMessage(undefined), "undefined");
    assert.equal(errorMessage({ message: 42 }), "[object Object]");
    assert.equal(errorMessage(new Error("")), "");
  });
});
