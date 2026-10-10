/**
 * Publish handed people the game's public page as `genex.games/world/<slug>`. genex.games moved
 * that page to `genex.games/<slug>` and answers the old form with a permanent redirect, and the
 * Genex CLI prints the new form — but every read of the publish record rebuilt the link from the
 * hosted project in the old form, over the one the CLI printed, so the Publish dialog showed and
 * copied the stale address.
 *
 * The pages Studio derives for a hosted game are the ones genex.games serves: the public page at
 * `<dashboard>/<slug>`, the draft page at `<dashboard>/draft/<slug>`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeMeta, publishUrls } from "../../src/plugins/genex/publish.ts";
import type { GenexPublishState } from "../../src/shared/genex.ts";

describe("the pages a hosted game is linked by", () => {
  it("names the public page at the dashboard root and the draft page under draft/", () => {
    assert.deepEqual(publishUrls({ slug: "quiet-ride", dashboardOrigins: ["https://genex.games"] }), {
      draftUrl: "https://genex.games/draft/quiet-ride",
      galleryUrl: "https://genex.games/quiet-ride",
    });
  });

  it("keeps the stand the project names for itself", () => {
    assert.equal(
      publishUrls({ slug: "quiet-ride", dashboardOrigins: ["https://dev.genex.games/"] }).galleryUrl,
      "https://dev.genex.games/quiet-ride",
    );
  });

  it("leaves a record read after a publish on the page the CLI printed", () => {
    const state = { galleryUrl: "https://genex.games/quiet-ride" } as GenexPublishState;
    mergeMeta(state, { slug: "quiet-ride", status: "published", dashboardOrigins: ["https://genex.games"] });
    assert.equal(state.galleryUrl, "https://genex.games/quiet-ride");
  });
});
