/**
 * A genex.games page Studio opens in the browser carries `s=desktop`, so the site can tell the
 * visit came from the app. The tag is one constant: nothing else is added, an `s` the link already
 * has stays, and every other link (a published game, the API, another site, plain http, not a link
 * at all) leaves exactly as it came.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tagGenexLink } from "../../src/plugins/genex/http.ts";

describe("tagging a genex.games page for the browser", () => {
  it("adds s=desktop to a page of the website, on either stand", () => {
    assert.equal(tagGenexLink("https://genex.games"), "https://genex.games/?s=desktop");
    assert.equal(tagGenexLink("https://genex.games/tools"), "https://genex.games/tools?s=desktop");
    assert.equal(tagGenexLink("https://dev.genex.games/accept"), "https://dev.genex.games/accept?s=desktop");
    assert.equal(tagGenexLink("https://GENEX.games/tools"), "https://genex.games/tools?s=desktop", "host in any case");
  });

  it("keeps the rest of the link: the path, the other parameters as written, and the hash", () => {
    assert.equal(tagGenexLink("https://genex.games/c/ABCD-EFGH"), "https://genex.games/c/ABCD-EFGH?s=desktop");
    assert.equal(
      tagGenexLink("https://genex.games/device?code=AB%20CD&next=%2Fdraft%2Fx#top"),
      "https://genex.games/device?code=AB%20CD&next=%2Fdraft%2Fx&s=desktop#top",
    );
    assert.equal(
      tagGenexLink("https://genex.games/world/derby?flag"),
      "https://genex.games/world/derby?flag&s=desktop",
    );
    assert.equal(tagGenexLink("https://genex.games/tools#faq"), "https://genex.games/tools?s=desktop#faq");
  });

  it("never overwrites an s the link already carries", () => {
    for (const link of [
      "https://genex.games/?s=x-launch",
      "https://genex.games/tools?a=1&s=",
      "https://genex.games/?s=desktop",
    ])
      assert.equal(tagGenexLink(link), link);
  });

  it("leaves every other link exactly as it came", () => {
    const untouched = [
      "https://derby.genex.technology/",
      "https://api.genex.games/api/cli/device/start",
      "https://mcp.genex.games/mcp",
      "https://plugins.genex.games/catalog.json",
      "https://assets.genex.games/x.glb",
      "https://genex.games.example.com/",
      "https://evilgenex.games/",
      "https://example.com/?next=https://genex.games/",
      "http://genex.games/tools",
      "genex.games/tools",
      "file:///Users/me/genex.games",
      "javascript:alert(1)",
      "not a url",
      "",
    ];
    for (const link of untouched) assert.equal(tagGenexLink(link), link, link);
  });
});
