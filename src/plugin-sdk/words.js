// A panel in Genex's language. Its words are written once, in English, as the key a translation is
// looked up by: `studioPlugin.t("Set up {name}", { name })`, in the ICU message syntax the app uses
// ({name}, {count, plural, one {# game} other {# games}}, {choice, select, …}). The host names the
// app's language in the panel's context; the translations are the plugin's own `locales/<lang>.json`,
// which inline-panel-sdk.mjs pastes in beside this script. A missing translation shows the English.
// An element marked `data-t` shows its own text translated; `data-t="title aria-label"` those
// attributes instead (add `text` to the list for both). `studioPlugin.ready` settles once the
// language is known and those marks are translated: a panel's script waits for it before it writes
// any words (`<script type="module">` with `await studioPlugin.ready;` at its top).
// Its own scope: a panel's script shares the page's globals and may use any of these names.
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: pasted into the panel as one scope, so the page's own globals keep every name
(() => {
  /** How long a panel waits for its context before it goes on in English. */
  const LANGUAGE_WAIT_MS = 2000;
  const ENGLISH = "en";
  /** The script element inline-panel-sdk.mjs writes the plugin's translations into, by language. */
  const CATALOGS_ID = "studio-panel-locales";
  const api = window.studioPlugin;
  const parsed = new Map();
  const pluralRules = new Map();
  let locale = ENGLISH;
  let catalog = {};

  /** The plugin's translations as pasted in, `{ ru: { English: "Русский" } }`; none outside a page. */
  function pastedCatalogs() {
    if (typeof document === "undefined" || typeof document.getElementById !== "function") return {};
    try {
      const value = JSON.parse(document.getElementById(CATALOGS_ID)?.textContent || "{}");
      return value && typeof value === "object" ? value : {};
    } catch {
      return {};
    }
  }

  // ICU message syntax, as `src/shared/i18n.ts` reads it: plain text, {name}, {name, number},
  // {name, plural, …} with `#` and =N cases, and {name, select, …}. An apostrophe quotes only
  // before a syntax character, so "Couldn't" needs no escaping and '{' writes a brace.
  function parseNodes(reader, inPlural) {
    const nodes = [];
    let text = "";
    const flush = () => {
      if (text) nodes.push(text);
      text = "";
    };
    while (reader.at < reader.text.length && reader.text[reader.at] !== "}") {
      const char = reader.text[reader.at];
      if (char === "'") text += readQuoted(reader, inPlural);
      else if (char === "{") {
        flush();
        nodes.push(parseArgument(reader));
      } else if (char === "#" && inPlural) {
        flush();
        nodes.push({ kind: "pound" });
        reader.at += 1;
      } else {
        text += char;
        reader.at += 1;
      }
    }
    flush();
    return nodes;
  }

  function readQuoted(reader, inPlural) {
    const next = reader.text[reader.at + 1];
    if (next === "'") {
      reader.at += 2;
      return "'";
    }
    if (!(next === "{" || next === "}" || (inPlural && next === "#"))) {
      reader.at += 1;
      return "'";
    }
    const end = reader.text.indexOf("'", reader.at + 1);
    const close = end === -1 ? reader.text.length : end;
    const quoted = reader.text.slice(reader.at + 1, close);
    reader.at = close + 1;
    return quoted;
  }

  function readWord(reader) {
    while (/\s/.test(reader.text[reader.at] ?? "")) reader.at += 1;
    const match = /^[=\w-]+/.exec(reader.text.slice(reader.at));
    if (match) reader.at += match[0].length;
    while (/\s/.test(reader.text[reader.at] ?? "")) reader.at += 1;
    return match ? match[0] : "";
  }

  function expect(reader, char) {
    while (/\s/.test(reader.text[reader.at] ?? "")) reader.at += 1;
    if (reader.text[reader.at] !== char) throw new Error(`Expected "${char}" in ${reader.text}`);
    reader.at += 1;
  }

  function parseArgument(reader) {
    reader.at += 1;
    const name = readWord(reader);
    if (!name) throw new Error(`A placeholder without a name in ${reader.text}`);
    if (reader.text[reader.at] === "}") {
      reader.at += 1;
      return { kind: "arg", name };
    }
    expect(reader, ",");
    const type = readWord(reader);
    if (type === "number") {
      expect(reader, "}");
      return { kind: "number", name };
    }
    if (type !== "plural" && type !== "select") throw new Error(`Unknown placeholder type in ${reader.text}`);
    expect(reader, ",");
    const cases = new Map();
    for (let key = readWord(reader); key; key = readWord(reader)) {
      expect(reader, "{");
      cases.set(key, parseNodes(reader, type === "plural"));
      expect(reader, "}");
    }
    expect(reader, "}");
    if (!cases.has("other")) throw new Error(`A ${type} needs an "other" case in ${reader.text}`);
    return { kind: type, name, cases };
  }

  function parse(pattern) {
    let nodes = parsed.get(pattern);
    if (nodes) return nodes;
    const reader = { text: pattern, at: 0 };
    nodes = parseNodes(reader, false);
    if (reader.at < pattern.length) throw new Error(`Unexpected "}" in ${pattern}`);
    parsed.set(pattern, nodes);
    return nodes;
  }

  /** Each placeholder kind, filled in. */
  const FILL = {
    // A plural's count as the language writes numbers ("1 200" in Russian); English keeps "1200".
    pound: (_node, _params, lang, count) => {
      if (count === undefined) return "#";
      return lang === ENGLISH ? String(count) : number(count, lang);
    },
    arg: (node, params) => (node.name in params ? String(params[node.name]) : `{${node.name}}`),
    number: (node, params, lang) => number(Number(params[node.name]), lang),
    plural: (node, params, lang) => {
      const value = Number(params[node.name]);
      const branch = node.cases.get(`=${value}`) ?? node.cases.get(pluralOf(value, lang)) ?? node.cases.get("other");
      return render(branch, params, lang, value);
    },
    select: (node, params, lang, count) =>
      render(node.cases.get(String(params[node.name])) ?? node.cases.get("other"), params, lang, count),
  };

  function render(nodes, params, lang, count) {
    let out = "";
    for (const node of nodes) out += typeof node === "string" ? node : FILL[node.kind](node, params, lang, count);
    return out;
  }

  function pluralOf(value, lang) {
    if (!pluralRules.has(lang)) pluralRules.set(lang, new Intl.PluralRules(lang));
    return pluralRules.get(lang).select(value);
  }

  function number(value, lang) {
    return Number.isFinite(value) ? new Intl.NumberFormat(lang === ENGLISH ? undefined : lang).format(value) : "";
  }

  /** `pattern` with its placeholders filled in, plural forms chosen by `lang`'s rules. */
  function format(pattern, params, lang) {
    if (!pattern.includes("{") && !pattern.includes("'")) return pattern;
    return render(parse(pattern), params ?? {}, lang, undefined);
  }

  /** `source` (English, ICU syntax) in the panel's language; the English when its translation is missing or broken. */
  function t(source, params) {
    const translation = catalog[source];
    if (translation) {
      try {
        return format(translation, params, locale);
      } catch {}
    }
    try {
      return format(source, params, ENGLISH);
    } catch {
      return source;
    }
  }

  /** "a, b and c" in the panel's language; English keeps the app's own form, no comma before "and". */
  function formatList(items) {
    if (locale !== ENGLISH) return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(items);
    if (items.length < 2) return items.join("");
    return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
  }

  const wordsOf = (text) => text.replace(/\s+/g, " ").trim();

  /** One of a marked element's words (`text` or an attribute) in the panel's language, where the plugin has it. */
  function translateWord(element, name) {
    const text = name === "text";
    const english = wordsOf(text ? element.textContent : (element.getAttribute(name) ?? ""));
    if (!catalog[english]) return;
    if (text) element.textContent = t(english);
    else element.setAttribute(name, t(english));
  }

  /** One marked element's words: its text, or the attributes its mark names. */
  function translateMark(element) {
    const names = element.dataset.t.split(/\s+/).filter(Boolean);
    for (const name of names.length > 0 ? names : ["text"]) translateWord(element, name);
  }

  /** The marked words of the page in the panel's language; English leaves the page as written. */
  function translatePage() {
    if (typeof document === "undefined" || typeof document.querySelectorAll !== "function") return;
    document.documentElement.lang = locale;
    if (locale !== ENGLISH) for (const element of document.querySelectorAll("[data-t]")) translateMark(element);
  }

  /** Speak `wanted` when the plugin has its words, else English. */
  function speak(wanted) {
    const catalogs = pastedCatalogs();
    const own = typeof wanted === "string" && wanted !== ENGLISH ? catalogs[wanted] : undefined;
    locale = own && typeof own === "object" ? wanted : ENGLISH;
    catalog = locale === ENGLISH ? {} : own;
    translatePage();
    return locale;
  }

  api.t = t;
  api.formatList = formatList;
  Object.defineProperty(api, "locale", { get: () => locale, enumerable: true });
  api.ready = new Promise((resolve) => {
    let settled = false;
    const settle = (context) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(speak(context?.locale));
    };
    const timer = setTimeout(() => settle(null), LANGUAGE_WAIT_MS);
    Promise.resolve()
      .then(() => api.call("context"))
      .then(settle, () => settle(null));
  });
})();
