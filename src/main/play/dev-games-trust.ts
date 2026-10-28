/**
 * A development stand's game hosts in Play's viewer. A local stand serves its games over https with a
 * certificate from its own CA (the local stack's `certs/ca.pem`), which no system trusts. A
 * development profile names that CA's file (`GENEX_DEV_PLAY_GAMES_CA`, `origins.ts devStand`), and
 * Play's session trusts it for the stand's game hosts only: a host one label under the stand's game
 * host, with a certificate that CA signed, in its dates, whose names cover that host. Every other
 * host and certificate, and every connection Chromium already accepts, keeps Chromium's own verdict.
 * A released or fixture launch never makes this trust. Electron-free: the session's verify proc
 * (`setCertificateVerifyProc`) hands its request to the function made here.
 */
import { X509Certificate } from "node:crypto";

/** What the verify proc answers Chromium: trust the connection, or keep Chromium's own verdict. Chromium's codes. */
export const CertificateVerdict = { Trusted: 0, Chromium: -3 } as const;
export type CertificateVerdict = (typeof CertificateVerdict)[keyof typeof CertificateVerdict];

/** The little of Electron's certificate verify request this reads. */
export interface CertificateRequest {
  hostname: string;
  certificate: { data: string };
  /** Chromium's own verdict: 0 when it accepts the connection. */
  errorCode: number;
}

/** One DNS label as a game's subdomain spells it. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** A DNS name in a certificate's subject alternative names. */
const DNS_NAME = /^DNS:(.+)$/;

/** The game a host names under `games` (the stand's game host), or null when it is not one label under it. */
function gameLabel(hostname: string, games: string): string | null {
  const suffix = `.${games}`;
  if (!hostname.endsWith(suffix)) return null;
  const label = hostname.slice(0, -suffix.length);
  return LABEL.test(label) ? label : null;
}

/** The DNS names a certificate is for, lowercased. */
function dnsNames(certificate: X509Certificate): string[] {
  const names = (certificate.subjectAltName ?? "").split(/,\s*/);
  return names.flatMap((name) => DNS_NAME.exec(name.trim())?.[1]?.toLowerCase() ?? []);
}

/** Whether a certificate's names cover `hostname`: exactly, or by a wildcard for its one first label. */
function covers(certificate: X509Certificate, hostname: string): boolean {
  const parent = hostname.slice(hostname.indexOf(".") + 1);
  return dnsNames(certificate).some((name) => name === hostname || name === `*.${parent}`);
}

/** Whether `leaf` is the stand CA's, in its dates at `now`. */
function signedInDate(leaf: X509Certificate, ca: X509Certificate, now: number): boolean {
  const inDate = Date.parse(leaf.validFrom) <= now && now <= Date.parse(leaf.validTo);
  return inDate && leaf.checkIssued(ca) && leaf.verify(ca.publicKey);
}

/** A certificate read from PEM, or null when it is not one. */
function certificateOf(pem: string): X509Certificate | null {
  try {
    return new X509Certificate(pem);
  } catch {
    return null;
  }
}

/**
 * The verify proc's answer for the stand at `games` (its game origin) and its CA (`caPem`), on the
 * clock `now`; null, trusting nothing, when either cannot be read.
 */
export function devGamesTrust(
  games: string,
  caPem: string,
  now: () => number,
): ((request: CertificateRequest) => CertificateVerdict) | null {
  const ca = certificateOf(caPem);
  if (!ca || !URL.canParse(games)) return null;
  const host = new URL(games).hostname;
  return (request) => {
    const hostname = request.hostname.toLowerCase();
    if (request.errorCode === 0 || !gameLabel(hostname, host)) return CertificateVerdict.Chromium;
    const leaf = certificateOf(request.certificate.data);
    const trusted = leaf !== null && signedInDate(leaf, ca, now()) && covers(leaf, hostname);
    return trusted ? CertificateVerdict.Trusted : CertificateVerdict.Chromium;
  };
}
