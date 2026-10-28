/**
 * Throwaway TLS certificates made in memory for a test: a CA and certificates it signs, as PEM. No
 * certificate or key is ever written to disk or kept in Git (`.gitignore`'s code-signing rule); each
 * test process makes its own with Node's crypto, encoding the X.509 structure by hand (DER), ECDSA
 * P-256 with SHA-256.
 */
import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";

/** Object identifiers the certificates use. */
const OID = {
  EcdsaWithSha256: "1.2.840.10045.4.3.2",
  CommonName: "2.5.4.3",
  BasicConstraints: "2.5.29.19",
  SubjectAltName: "2.5.29.17",
} as const;

/** DER tags. */
const TAG = {
  Boolean: 0x01,
  Integer: 0x02,
  BitString: 0x03,
  OctetString: 0x04,
  Oid: 0x06,
  Utf8String: 0x0c,
  UtcTime: 0x17,
  Sequence: 0x30,
  Set: 0x31,
  /** `[0] EXPLICIT` (the version) and `[3] EXPLICIT` (the extensions). */
  Version: 0xa0,
  Extensions: 0xa3,
  /** A subject alternative name's `dNSName`: `[2] IMPLICIT IA5String`. */
  DnsName: 0x82,
} as const;

/** X.509 version 3, as its field counts it. */
const V3 = 2;
/** The largest length the short form encodes. */
const SHORT_LENGTH_MAX = 0x7f;
const BYTE = 0x100;
const LONG_LENGTH = 0x80;
/** The earliest and latest dates a UTCTime holds without ambiguity. */
const UTC_TIME_MIN_YEAR = 1950;
const UTC_TIME_MAX_YEAR = 2049;

/** A DER length. */
function lengthOf(size: number): Buffer {
  if (size <= SHORT_LENGTH_MAX) return Buffer.from([size]);
  const bytes: number[] = [];
  for (let rest = size; rest > 0; rest = Math.floor(rest / BYTE)) bytes.unshift(rest % BYTE);
  return Buffer.from([LONG_LENGTH | bytes.length, ...bytes]);
}

/** One DER element: its tag, its length and its content. */
const der = (tag: number, ...content: Buffer[]): Buffer => {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), lengthOf(body.length), body]);
};

/** An object identifier in DER. */
function oid(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split(".").map(Number);
  const bytes = [first * 40 + second];
  for (const arc of rest) {
    const chunk = [arc % LONG_LENGTH];
    for (let left = Math.floor(arc / LONG_LENGTH); left > 0; left = Math.floor(left / LONG_LENGTH))
      chunk.unshift(LONG_LENGTH | (left % LONG_LENGTH));
    bytes.push(...chunk);
  }
  return der(TAG.Oid, Buffer.from(bytes));
}

/** A small positive integer (below 256) in DER: one byte, or a zero first when its top bit is set. */
const integer = (value: number): Buffer =>
  der(TAG.Integer, Buffer.from(value > SHORT_LENGTH_MAX ? [0, value % BYTE] : [value]));

/** A name with only a common name. */
const name = (commonName: string): Buffer =>
  der(TAG.Sequence, der(TAG.Set, der(TAG.Sequence, oid(OID.CommonName), der(TAG.Utf8String, Buffer.from(commonName)))));

/** A time as UTCTime (`YYMMDDHHMMSSZ`). */
function utcTime(at: Date): Buffer {
  const year = at.getUTCFullYear();
  if (year < UTC_TIME_MIN_YEAR || year > UTC_TIME_MAX_YEAR) throw new Error(`UTCTime cannot hold ${year}`);
  const two = (value: number) => String(value).padStart(2, "0");
  const text = `${two(year % 100)}${two(at.getUTCMonth() + 1)}${two(at.getUTCDate())}${two(at.getUTCHours())}${two(at.getUTCMinutes())}${two(at.getUTCSeconds())}Z`;
  return der(TAG.UtcTime, Buffer.from(text));
}

/** One extension: its id and its DER value, not critical. */
const extension = (id: string, value: Buffer): Buffer => der(TAG.Sequence, oid(id), der(TAG.OctetString, value));

/** A certificate's extensions: whether it is a CA, and the DNS names it is for. */
function extensions(ca: boolean, dns: readonly string[]): Buffer {
  const constraints = ca ? der(TAG.Sequence, der(TAG.Boolean, Buffer.from([0xff]))) : der(TAG.Sequence);
  const list = [extension(OID.BasicConstraints, constraints)];
  if (dns.length > 0)
    list.push(
      extension(OID.SubjectAltName, der(TAG.Sequence, ...dns.map((host) => der(TAG.DnsName, Buffer.from(host))))),
    );
  return der(TAG.Extensions, der(TAG.Sequence, ...list));
}

/** A PEM certificate from its DER. */
const pem = (body: Buffer): string =>
  `-----BEGIN CERTIFICATE-----\n${body.toString("base64").replace(/.{1,64}/g, "$&\n")}-----END CERTIFICATE-----\n`;

/** A certificate authority that signs certificates in memory. */
export interface TestAuthority {
  /** The CA's own certificate. */
  pem: string;
  /** A certificate this CA signs for `dns`, valid from `from` to `to` (UTC, 1950–2049). */
  issue(options: { commonName: string; dns: readonly string[]; from: Date; to: Date }): string;
}

/** What a certificate is: whose, for which names, when, and signed by which key under which issuer. */
interface CertificateSpec {
  serial: number;
  subject: string;
  issuer: string;
  ca: boolean;
  dns: readonly string[];
  from: Date;
  to: Date;
  publicKey: KeyObject;
  signer: KeyObject;
}

/** A certificate signed by `spec.signer`. */
function certificate(spec: CertificateSpec): string {
  const algorithm = der(TAG.Sequence, oid(OID.EcdsaWithSha256));
  const tbs = der(
    TAG.Sequence,
    der(TAG.Version, integer(V3)),
    integer(spec.serial),
    algorithm,
    name(spec.issuer),
    der(TAG.Sequence, utcTime(spec.from), utcTime(spec.to)),
    name(spec.subject),
    spec.publicKey.export({ type: "spki", format: "der" }),
    extensions(spec.ca, spec.dns),
  );
  const signature = sign("sha256", tbs, spec.signer);
  return pem(der(TAG.Sequence, tbs, algorithm, der(TAG.BitString, Buffer.from([0]), signature)));
}

/** A new CA named `commonName`, valid from `from` to `to`, with a key of its own. */
export function testAuthority(commonName: string, from: Date, to: Date): TestAuthority {
  const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  let serial = 1;
  const own = { subject: commonName, issuer: commonName, ca: true, dns: [], from, to };
  return {
    pem: certificate({ ...own, serial, publicKey: keys.publicKey, signer: keys.privateKey }),
    issue: (options) => {
      serial += 1;
      const leaf = generateKeyPairSync("ec", { namedCurve: "P-256" });
      const { commonName: subject, dns, from: start, to: end } = options;
      return certificate({
        serial,
        subject,
        issuer: commonName,
        ca: false,
        dns,
        from: start,
        to: end,
        publicKey: leaf.publicKey,
        signer: keys.privateKey,
      });
    },
  };
}
