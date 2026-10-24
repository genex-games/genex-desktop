/**
 * Where a developer launch's control listens, so `scripts/studio-dev` can reach it. Node listens
 * locally on a Unix socket on macOS and Linux and only on a named pipe on Windows.
 *
 * - **macOS and Linux.** A socket in a private temporary folder (0700), itself owner-only (0600).
 * - **Windows.** A named pipe with a fresh random name. Node cannot give a pipe its own access
 *   list, so it keeps Windows' default one: full access for this account, SYSTEM and
 *   administrators, read-only for everyone else, who can then send no request.
 */
import fsp from "node:fs/promises";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { StudioPlatform } from "../../shared/boot.ts";

/** Why a launch has no endpoint. */
const MESSAGE = {
  socketPathTooLong: "temporary IPC path too long",
} as const;

/** A socket path longer than this does not fit macOS's `sockaddr_un`. */
const MAX_SOCKET_PATH_BYTES = 102;
/** The start of each launch's private folder's name. */
const FOLDER_PREFIX = "ags-";
/** What `mkdtemp` appends to the prefix. */
const FOLDER_SUFFIX = "XXXXXX";
/** The socket's name in the private folder: short, for the path limit. */
const SOCKET_NAME = "s";
/** Where Windows keeps named pipes, and the start of each launch's pipe name there. */
const PIPE_PREFIX = "\\\\.\\pipe\\ags-";
/** Random bytes in a pipe's name, so no other process can guess it before the launch takes it. */
const PIPE_NAME_BYTES = 16;

/** Where one launch's control listens: its socket or pipe, and the private folder to remove after it, if any. */
export interface ControlEndpoint {
  socket: string;
  dir: string | null;
}

/**
 * A new launch's endpoint: on Windows a named pipe no earlier launch used, with no file and no path
 * limit; elsewhere a socket in a private folder (0700) of its own under `tempRoot`, refused before
 * the folder is made when its path is too long for a socket.
 */
export async function controlEndpoint(
  platform: NodeJS.Platform = process.platform,
  tempRoot = os.tmpdir(),
): Promise<ControlEndpoint> {
  if (platform === StudioPlatform.Windows)
    return { socket: `${PIPE_PREFIX}${randomBytes(PIPE_NAME_BYTES).toString("hex")}`, dir: null };
  const planned = path.join(tempRoot, `${FOLDER_PREFIX}${FOLDER_SUFFIX}`, SOCKET_NAME);
  if (Buffer.byteLength(planned) > MAX_SOCKET_PATH_BYTES) throw new Error(MESSAGE.socketPathTooLong);
  const dir = await fsp.mkdtemp(path.join(tempRoot, FOLDER_PREFIX));
  await fsp.chmod(dir, 0o700);
  return { socket: path.join(dir, SOCKET_NAME), dir };
}

/** Listens `server` on the endpoint; a socket file (not a pipe) is then readable and writable by its owner only. */
export async function listenControl(server: net.Server, endpoint: ControlEndpoint): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint.socket, () => resolve());
  });
  if (endpoint.dir !== null) await fsp.chmod(endpoint.socket, 0o600);
}

/** Removes the endpoint's private folder, if it has one; a pipe goes away with its server. */
export async function removeControlEndpoint(endpoint: ControlEndpoint): Promise<void> {
  if (endpoint.dir !== null) await fsp.rm(endpoint.dir, { recursive: true, force: true });
}
