/**
 * A seat of a native game as Play starts one: it knows only `GENEX_API_URL` (its gateway), asks it
 * for a guest session, joins the authority room the answer's regions name with Studio's Node client
 * (fast@1 on node:dgram by default), walks out and back for `argv[2]` ms and prints one JSON line of
 * what its channel did. Bundled into the game's saves folder and run in the game sandbox by
 * `genex-gateway-sandbox.test.ts`; with `GENEX_GAME` set it joins that game's room as a guest.
 */
import { connectAuthority } from "@genex-ai/multiplayer/authority";

const PLAY_MS = Number(process.argv[2] ?? 10_000);
const FRAME_MS = 8;
const SAMPLE_EVERY_MS = 100;
const LEG_MS = 2_000;

const api = process.env.GENEX_API_URL ?? "";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = (fields) => process.stdout.write(`${JSON.stringify(fields)}\n`);

try {
  const answer = await (
    await fetch(`${api}/api/embed/guest-session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: process.env.GENEX_GAME ?? "" }),
    })
  ).json();
  const { authorityUrls, authorityRegions } = answer.colyseus;
  const session = await connectAuthority({
    urls: authorityUrls,
    regions: authorityRegions,
    // A local room takes any game id; Genex's own takes the game's, with the guest's token.
    room: process.env.GENEX_GAME || "local",
    ...(answer.embedToken ? { auth: { embedToken: answer.embedToken } } : {}),
    name: "sandboxed",
    capacityRetryMs: [],
    predict: false,
  });
  const samples = [];
  const start = performance.now();
  let next = start;
  while (performance.now() - start < PLAY_MS) {
    const now = performance.now();
    session.input.moveX = Math.floor((now - start) / LEG_MS) % 2 === 0 ? 1 : -1;
    session.frame();
    if (now >= next) {
      const { live, fallback, transport, snapshots } = session.fast;
      samples.push({ at: now - start, live, fallback, transport, snapshots, x: session.me()?.x ?? null });
      next += SAMPLE_EVERY_MS;
    }
    await sleep(FRAME_MS);
  }
  report({ url: session.url, line: session.fast.line, authorityUrls, samples });
  await session.leave().catch(() => undefined);
  process.exit(0);
} catch (error) {
  report({ error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
  process.exit(1);
}
