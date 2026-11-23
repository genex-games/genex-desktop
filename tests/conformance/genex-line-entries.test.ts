/**
 * Genex's own fixed chat lines (a Stop's "Stopped. Finished edits are preserved…") reach the chat
 * in the language the app is set to: the record keeps the English the agents read and the line's
 * code, and the transcript shows the app's words for the code. A code this app doesn't know shows
 * the record's English, and the seed's English for each line is the app's English.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { GENEX_LINE_TEXT } from "../../src/harness-seed/loop/genex-lines.ts";
import { EntryKind, toEntries } from "../../src/renderer/chat-entries.ts";
import { GENEX_LINE_WORDS } from "../../src/renderer/words.ts";
import { type EventData, type EventEnvelope, GenexLine } from "../../src/shared/event-log.ts";
import { setLocale } from "../../src/shared/i18n.ts";
import { Locale } from "../../src/shared/locale.ts";
import { loadCatalog } from "../../src/shared/locales/index.ts";

const STOPPED_EN = "Stopped. Finished edits are preserved; send a message to continue.";

const event = (id: number, data: EventData): EventEnvelope => ({
  id: String(id).padStart(6, "0"),
  thread_id: "t1",
  turn_id: null,
  session_id: null,
  created_at: new Date(id).toISOString(),
  data,
});
const user = event(1, { type: "messages", messages: [{ role: "user", content: "ボタンを追加して" }] });
const reply: EventData = { type: "messages", messages: [{ role: "assistant", content: STOPPED_EN }] };
/** The stop line's record as a log holds it: any code, a newer harness's too, read back from disk. */
const said = (line: string | undefined): EventEnvelope =>
  JSON.parse(JSON.stringify({ ...event(2, reply), data: { ...reply, ...(line ? { genex_line: line } : {}) } }));
const replyText = (events: EventEnvelope[]) => {
  const reply = toEntries(events).find((entry) => entry.kind === EntryKind.Assistant);
  return reply?.kind === EntryKind.Assistant ? reply.text : undefined;
};

describe("Genex's own chat lines", () => {
  afterEach(() => setLocale(Locale.English, {}));

  it("shows a stopped turn's line in Japanese when the app is in Japanese", async () => {
    setLocale(Locale.Japanese, await loadCatalog(Locale.Japanese));
    assert.equal(
      replyText([user, said(GenexLine.Stopped)]),
      "停止しました。編集内容は保存されています。続行するにはメッセージを送信してください。",
    );
  });

  it("gives every line its own words in every language", async () => {
    for (const locale of Object.values(Locale)) {
      if (locale === Locale.English) continue;
      setLocale(locale, await loadCatalog(locale));
      for (const line of Object.values(GenexLine)) {
        assert.notEqual(GENEX_LINE_WORDS[line](), GENEX_LINE_TEXT[line], `${line} in ${locale}`);
      }
    }
  });

  it("keeps the record's English in English, and for a code this app doesn't know", async () => {
    assert.equal(replyText([user, said(GenexLine.Stopped)]), STOPPED_EN);
    setLocale(Locale.Japanese, await loadCatalog(Locale.Japanese));
    assert.equal(replyText([user, said("a_newer_line")]), STOPPED_EN);
    assert.equal(replyText([user, said(undefined)]), STOPPED_EN);
  });

  it("records each line in the English the app shows for it", () => {
    for (const line of Object.values(GenexLine)) assert.equal(GENEX_LINE_TEXT[line], GENEX_LINE_WORDS[line]());
  });
});
