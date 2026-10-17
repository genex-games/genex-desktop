/** Platform address and permissions for the capability-authenticated developer controller. */
import path from "node:path";
import { chmod } from "node:fs/promises";
import { StudioPlatform } from "../../shared/boot.ts";

/** The controller's address inside its private transport folder. */
export function controlSocket(directory: string, instanceId: string, platform = process.platform): string {
  if (platform === StudioPlatform.Windows) return `\\\\.\\pipe\\genex-dev-${instanceId}`;
  return path.join(directory, "s");
}

/** Unix sockets need file permissions after listen; Windows pipes have no filesystem entry. */
export async function secureControlSocket(socket: string, platform = process.platform): Promise<void> {
  if (platform === StudioPlatform.Windows) return;
  await chmod(socket, 0o600);
}
