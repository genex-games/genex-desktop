/**
 * Core startup makes the process sandbox and wires plugin services side by side; this waits for
 * both. A sandbox that cannot start must not end startup while plugin setup is still copying the
 * bundled plugins: the setup screen's Retry (or Windows' Set up) starts a new core at once, and its
 * registry would sweep and copy the same package folders under the first one's copy.
 */

/** The sandbox, once plugin setup beside it has finished too; either's failure, after both settle. */
export async function sandboxBesidePlugins<S extends { dispose(): Promise<void> }>(
  sandbox: Promise<S>,
  plugins: Promise<void>,
): Promise<S> {
  const [made, wired] = await Promise.allSettled([sandbox, plugins]);
  if (made.status === "rejected") throw made.reason;
  if (wired.status === "fulfilled") return made.value;
  await made.value.dispose();
  throw wired.reason;
}
