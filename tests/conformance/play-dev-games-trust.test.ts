/**
 * A development stand's game hosts in Play's viewer. A local stand serves its games over https with a
 * certificate from its own CA, which no system trusts; a development profile names that CA's file
 * (`GENEX_DEV_PLAY_GAMES_CA`) and the viewer trusts it for the stand's game hosts only. Every other
 * host, every certificate that CA did not sign, one whose names do not cover the host, one out of its
 * dates, and every connection Chromium already accepts keep Chromium's own verdict. Released and
 * fixture launches never make this trust at all (`play-origins.test.ts`). The certificates are made
 * in memory for each run (`helpers/test-certificates.ts`); none is kept on disk or in Git.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CertificateVerdict, devGamesTrust } from "../../src/main/play/dev-games-trust.ts";
import { testAuthority } from "../helpers/test-certificates.ts";

const FROM = new Date("2020-01-01T00:00:00Z");
const TO = new Date("2049-12-31T00:00:00Z");
/** The stand's own CA, and another CA of the same name. */
const STAND_CA = testAuthority("Genex test stand CA (test only)", FROM, TO);
const OTHER_CA = testAuthority("Genex test stand CA (test only)", FROM, TO);
const CA = STAND_CA.pem;
const LOCAL_NAMES = ["localhost", "*.localhost", "stick-steel.localhost"];
/** Signed by the stand's CA for `localhost`, `*.localhost` and `stick-steel.localhost`. */
const LEAF = STAND_CA.issue({ commonName: "localhost", dns: LOCAL_NAMES, from: FROM, to: TO });
/** The same names, signed by the other CA. */
const OTHER_LEAF = OTHER_CA.issue({ commonName: "localhost", dns: LOCAL_NAMES, from: FROM, to: TO });
/** Signed by the stand's CA for a genex.games game host. */
const GENEX_LEAF = STAND_CA.issue({
  commonName: "stick-steel.genex.technology",
  dns: ["stick-steel.genex.technology"],
  from: FROM,
  to: TO,
});
/** Chromium's verdict for an authority it does not know. */
const AUTHORITY_INVALID = -202;
/** A day inside every certificate's dates. */
const NOW = Date.parse("2027-01-01T00:00:00Z");
const GAMES = "https://localhost:8443";

const ask = (hostname: string, data: string, errorCode = AUTHORITY_INVALID) => ({
  hostname,
  certificate: { data },
  errorCode,
});

describe("a development stand's game hosts", () => {
  it("are trusted with a certificate the stand's CA signed for them", () => {
    const trust = devGamesTrust(GAMES, CA, () => NOW);
    assert.ok(trust);
    assert.equal(trust(ask("stick-steel.localhost", LEAF)), CertificateVerdict.Trusted);
    // A game the certificate names by its wildcard: one label under the stand's host.
    assert.equal(trust(ask("dev-forge.localhost", LEAF)), CertificateVerdict.Trusted);
    assert.equal(trust(ask("preview--skate-dog.localhost", LEAF)), CertificateVerdict.Trusted);
  });

  it("keep Chromium's verdict for anything else", () => {
    const trust = devGamesTrust(GAMES, CA, () => NOW);
    assert.ok(trust);
    const kept: Array<[string, ReturnType<typeof ask>]> = [
      ["already accepted", ask("stick-steel.localhost", LEAF, 0)],
      ["another CA's certificate", ask("stick-steel.localhost", OTHER_LEAF)],
      ["the stand's host itself, not a game", ask("localhost", LEAF)],
      ["two labels under the stand's host", ask("a.b.localhost", LEAF)],
      ["a host merely ending like the stand's", ask("evil-localhost", LEAF)],
      ["genex.games' game host", ask("stick-steel.genex.technology", GENEX_LEAF)],
      ["any other host", ask("accounts.google.com", LEAF)],
      ["a certificate that names another host", ask("stick-steel.localhost", GENEX_LEAF)],
      ["no certificate it can read", ask("stick-steel.localhost", "not a certificate")],
    ];
    for (const [name, request] of kept) assert.equal(trust(request), CertificateVerdict.Chromium, name);
  });

  it("keep Chromium's verdict for a certificate outside its dates", () => {
    const later = devGamesTrust(GAMES, CA, () => Date.parse("2200-01-01T00:00:00Z"));
    const earlier = devGamesTrust(GAMES, CA, () => Date.parse("2001-01-01T00:00:00Z"));
    assert.equal(later?.(ask("stick-steel.localhost", LEAF)), CertificateVerdict.Chromium);
    assert.equal(earlier?.(ask("stick-steel.localhost", LEAF)), CertificateVerdict.Chromium);
  });

  it("trusts nothing when the CA file is not a certificate, or the games origin is not one", () => {
    assert.equal(
      devGamesTrust(GAMES, "", () => NOW),
      null,
    );
    assert.equal(
      devGamesTrust(GAMES, "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n", () => NOW),
      null,
    );
    assert.equal(
      devGamesTrust("not an origin", CA, () => NOW),
      null,
    );
  });
});
