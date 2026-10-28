// A Windows canary machine on Azure, for one run: a resource group holding one VM from a Windows
// client image and a storage account for its evidence, driven by Run Command from a GitHub-hosted
// job signed in through OIDC, and deleted afterwards. No runner and no inbound port exist on the VM;
// it only calls out.
//
//   node scripts/canary/azure.ts run --machine windows-11 --image <urn> --tag v0.1.11 \
//     --source <zip> --evidence <dir> [--size <vm size>] [--location <region>[,<region>…]] \
//     [--upgrade-from <release tag>]
//   node scripts/canary/azure.ts sweep     delete canary resource groups past their expiry
//
// The phases on the VM are scripts/canary/windows/azure-vm.ps1.
import { randomBytes } from "node:crypto";
import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { HOUR_MS, MINUTE_MS } from "../../src/shared/duration.ts";
import { PackageKind } from "./links.ts";
import {
  CanaryStep,
  type MachineResult,
  machinePassed,
  Persona,
  RESULT_FILE,
  readResult,
  recorder,
  StepOutcome,
} from "./results.ts";
import { sh } from "./shell.ts";

/** Every canary resource group carries this tag, and an expiry the sweep honours. */
const CANARY_TAG = "genex-canary";
const GROUP_LIFETIME_MS = 3 * HOUR_MS;
const PHASE_TIMEOUT_MS = 90 * MINUTE_MS;
const OWNER_NAME = "genexowner";
/**
 * The owner of an upgrade run: an ordinary administrator Prepare makes, as a person's own PC has.
 * Azure's account is the built-in Administrator, which runs elevated and is never asked to approve.
 */
const UPGRADE_OWNER_NAME = "canary-owner";
/**
 * Files in each Azure account's lived-in profile, fewer than the GitHub runner's 150,000: two cores
 * with Defender scanning every write take about seven seconds per thousand files.
 */
const AZURE_PROFILE_FILES = 60_000;
const USER_NAME = "canary-user";
/**
 * How old a sign-in may be before the next az call signs in again. GitHub's OIDC token lasts five
 * minutes and the Azure token az gets with it about an hour, after which az renews it with the
 * expired OIDC token and fails; a call made on a sign-in this fresh (with az's cached token dropped,
 * `signInCommands`) therefore has most of an hour, and each phase on the VM finishes well within it.
 */
const SIGN_IN_MAX_AGE_MS = 5 * MINUTE_MS;
/** The audience Azure's federated credentials for GitHub expect. */
const AZURE_AUDIENCE = "api://AzureADTokenExchange";
const CONTAINER = "evidence";
const MESSAGE = {
  ownerDidNotStart:
    "owner run did not start: it left no result.json (owner.out.log has what it printed), so the sandbox was never set up",
} as const;
/**
 * Two-core, 8 GB sizes (a modest laptop) by preference, with the quota family each draws on. A new
 * subscription has room in some families and none in others, so the run takes the first with room.
 */
export const SIZE_PREFERENCES = [
  { size: "Standard_D2as_v5", family: "standardDASv5Family" },
  { size: "Standard_D2s_v5", family: "standardDSv5Family" },
  { size: "Standard_D2s_v4", family: "standardDSv4Family" },
  { size: "Standard_D2s_v3", family: "standardDSv3Family" },
  { size: "Standard_B2ms", family: "standardBSFamily" },
] as const;
const VM_CORES = 2;
/** The Windows machines of one run start together, so a family should hold all of them. */
const RUN_VMS = 2;
const REGION_QUOTA = "cores";

/** One quota line of `az vm list-usage`. */
export interface Usage {
  name: string;
  used: number;
  limit: number;
}

/**
 * The preferred sizes whose family, and the region, have room: first those with room for a run's
 * VMs, then those with room for one. Empty when the region has room for none.
 */
export function sizesWithRoom(usages: readonly Usage[]): string[] {
  const free = (name: string) => {
    const usage = usages.find((line) => line.name === name);
    return usage ? usage.limit - usage.used : 0;
  };
  const sizes: string[] = [];
  for (const vms of [RUN_VMS, 1]) {
    const cores = vms * VM_CORES;
    if (free(REGION_QUOTA) < cores) continue;
    for (const { size, family } of SIZE_PREFERENCES)
      if (free(family) >= cores && !sizes.includes(size)) sizes.push(size);
  }
  return sizes;
}

/** The sizes to try in `location`: the one asked for, else those with quota there. */
async function sizesFor(asked: string, location: string): Promise<string[]> {
  if (asked) return [asked];
  const listed = await azWith("vm list-usage", {
    "-l": location,
    "--query": "[].{name:name.value, used:currentValue, limit:limit}",
    "-o": "json",
  });
  return sizesWithRoom(JSON.parse(listed || "[]") as Usage[]);
}
/**
 * Regions tried in turn, those that have had capacity for two-core VMs first: a region can stop
 * taking new customers' resources, have no quota for the sizes or no capacity for them right now,
 * and the next one may.
 */
export const DEFAULT_LOCATIONS = [
  "westus3",
  "eastus2",
  "centralus",
  "canadacentral",
  "swedencentral",
  "northeurope",
  "germanywestcentral",
  "francecentral",
  "uksouth",
];
/**
 * What Azure answers when a region takes no new customers' resources, has no capacity for a size
 * right now, or has no quota left (the run's other machine may have taken the room both read as
 * free): either way another size or region may work.
 */
const TRY_ELSEWHERE =
  /locationineligible|not accepting new customers|SkuNotAvailable|Capacity Restrictions|not available in location|QuotaExceeded/i;

/** Whether Azure's refusal `error` leaves another size or region worth trying. */
export function triesElsewhere(error: string): boolean {
  return TRY_ELSEWHERE.test(error);
}
const VM_SCRIPT = path.join(import.meta.dirname, "windows", "azure-vm.ps1");
/** The Marketplace publisher of the Windows 11 and 10 images. */
const CLIENT_PUBLISHER = "MicrosoftWindowsDesktop";

/** A password Windows accepts: long, random, with every character class. */
export function windowsPassword(bytes = randomBytes(18)): string {
  return `Gx${bytes.toString("base64url")}aZ9!`;
}

/** The run's resource group name: unique per run, attempt and machine, within Azure's 90 characters. */
export function groupName(runId: string, attempt: string, machine: string): string {
  return `${CANARY_TAG}-${runId}-${attempt}-${machine}`.replace(/[^\w.-]/g, "-").slice(0, 90);
}

/** A storage account name: 3–24 lowercase letters and digits, globally unique enough per run. */
export function storageName(runId: string, attempt: string, machine: string): string {
  const digits = `${runId}${attempt}`.replace(/\D/g, "");
  const tagged = machine.replace(/\D/g, "");
  return `gxc${digits}${tagged}`.slice(0, 24);
}

/** What a GitHub job needs to sign az in with an OIDC token of its own. */
export interface GitHubSignIn {
  requestUrl: string;
  requestToken: string;
  clientId: string;
  tenantId: string;
  subscriptionId: string;
}

/**
 * The job's sign-in from its environment (Actions sets the request URL and token for a job with
 * `id-token: write`; the workflow passes the IDs), or null outside Actions, where the person's own
 * `az login` is used as it is.
 */
export function gitHubSignIn(env: NodeJS.ProcessEnv): GitHubSignIn | null {
  const signIn = {
    requestUrl: env.ACTIONS_ID_TOKEN_REQUEST_URL ?? "",
    requestToken: env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ?? "",
    clientId: env.AZURE_CLIENT_ID ?? "",
    tenantId: env.AZURE_TENANT_ID ?? "",
    subscriptionId: env.AZURE_SUBSCRIPTION_ID ?? "",
  };
  return Object.values(signIn).every(Boolean) ? signIn : null;
}

/** A fresh GitHub OIDC token for Azure. */
export async function gitHubToken(signIn: GitHubSignIn, fetchImpl: typeof fetch = fetch): Promise<string> {
  const url = new URL(signIn.requestUrl);
  url.searchParams.set("audience", AZURE_AUDIENCE);
  const response = await fetchImpl(url, { headers: { Authorization: `bearer ${signIn.requestToken}` } });
  if (!response.ok) throw new Error(`GitHub refused an OIDC token: HTTP ${response.status}`);
  const { value } = (await response.json()) as { value?: unknown };
  if (typeof value !== "string" || value === "") throw new Error("GitHub's OIDC answer held no token");
  return value;
}

/** Whether a sign-in made at `signedInAt` (null: none yet) is too old for an az call at `now`. */
export function signInDue(signedInAt: number | null, now: number): boolean {
  return signedInAt === null || now - signedInAt >= SIGN_IN_MAX_AGE_MS;
}

/**
 * The az calls that sign in with OIDC `token`: the cached account first, because az keeps an Azure
 * token across sign-ins and renews it near its expiry with the latest OIDC token, by then minutes
 * stale (AADSTS700024); then the sign-in, then the subscription.
 */
export function signInCommands(signIn: GitHubSignIn, token: string): string[][] {
  return [
    ["account", "clear"],
    [
      "login",
      "--service-principal",
      "-u",
      signIn.clientId,
      "-t",
      signIn.tenantId,
      "--federated-token",
      token,
      "--allow-no-subscriptions",
      "-o",
      "none",
    ],
    ["account", "set", "-s", signIn.subscriptionId],
  ];
}

let signedInAt: number | null = null;

/** In a GitHub job, sign az in again with a fresh OIDC token once the last sign-in is old. */
async function freshSignIn(): Promise<void> {
  const signIn = gitHubSignIn(process.env);
  if (!signIn || !signInDue(signedInAt, Date.now())) return;
  const token = await gitHubToken(signIn);
  console.log(`::add-mask::${token}`);
  for (const args of signInCommands(signIn, token)) {
    const ran = await sh("az", args);
    if (ran.code !== 0) throw new Error(`az ${args.slice(0, 2).join(" ")} failed:\n${ran.stderr || ran.stdout}`);
  }
  signedInAt = Date.now();
}

/** Delete resource group `name` without waiting; a failure is left to the sweep. */
async function deleteGroup(name: string): Promise<void> {
  await freshSignIn().catch((error: unknown) => console.log(`signing in to delete ${name}: ${String(error)}`));
  await sh("az", ["group", "delete", "-n", name, "--yes", "--no-wait"]);
}

async function az(args: string[], timeoutMs = 30 * MINUTE_MS): Promise<string> {
  await freshSignIn();
  const ran = await sh("az", [...args, "--only-show-errors"], { timeoutMs });
  // The CLI sometimes buries Azure's own error under a traceback of its own; keep all of it, since
  // the retries read the reason from it.
  if (ran.code !== 0) throw new Error(`az ${args.slice(0, 3).join(" ")} failed:\n${ran.stderr || ran.stdout}`);
  return ran.stdout.trim();
}

/** `az <command>` with `flags` as name–value pairs (`true` for a bare switch). */
function azWith(command: string, flags: Record<string, string | true>, timeoutMs?: number): Promise<string> {
  const args = command.split(" ");
  for (const [name, value] of Object.entries(flags)) args.push(name, ...(value === true ? [] : [value]));
  return az(args, timeoutMs);
}

/** Run one azure-vm.ps1 phase on the VM as SYSTEM; what it printed. */
async function phase(group: string, name: string, values: Record<string, string>): Promise<string> {
  // Base64 values: a SAS URL's & and % would otherwise reach the script through Run Command's own
  // command line. azure-vm.ps1 decodes each one.
  const parameters = Object.entries(values).map(([key, value]) =>
    key === "Files" ? `${key}=${value}` : `${key}=${Buffer.from(value).toString("base64")}`,
  );
  const flags = { "-g": group, "-n": "vm", "--command-id": "RunPowerShellScript", "--scripts": `@${VM_SCRIPT}` };
  const out = await az(
    [
      "vm",
      "run-command",
      "invoke",
      ...Object.entries(flags).flat(),
      "--parameters",
      `Phase=${Buffer.from(name).toString("base64")}`,
      ...parameters,
      "--query",
      "value[].message",
      "-o",
      "tsv",
    ],
    PHASE_TIMEOUT_MS,
  );
  console.log(`── ${name}\n${out}`);
  return out;
}

async function restart(group: string): Promise<void> {
  await azWith("vm restart", { "-g": group, "-n": "vm" });
}

/** The account and key every storage call signs with. */
interface Storage {
  "--account-name": string;
  "--account-key": string;
}

/** A SAS URL for one blob, valid for the group's lifetime. */
async function blobUrl(storage: Storage, blob: string, permissions: string): Promise<string> {
  const expiry = `${new Date(Date.now() + GROUP_LIFETIME_MS).toISOString().slice(0, 16)}Z`;
  const sas = await azWith("storage blob generate-sas", {
    ...storage,
    "-c": CONTAINER,
    "-n": blob,
    "--permissions": permissions,
    "--expiry": expiry,
    "--https-only": true,
    "-o": "tsv",
  });
  return `https://${storage["--account-name"]}.blob.core.windows.net/${CONTAINER}/${blob}?${sas}`;
}

interface RunOptions {
  machine: string;
  image: string;
  tag: string;
  /** Upgrade mode: the release the owner installs before the build (canary.yml `upgrade_from`). */
  upgradeFrom?: string;
  source: string;
  evidence: string;
  size: string;
  location: string;
  nodeVersion: string;
}

/** Windows 11 and 10 images run on the owner's own Windows license; a server image includes its own. */
export function licenseFlags(image: string): Record<string, string> {
  return image.startsWith(`${CLIENT_PUBLISHER}:`) ? { "--license-type": "Windows_Client" } : {};
}

/** The VM: a Windows image on Trusted Launch (Windows 11 needs its TPM), no inbound port. */
async function createVm(group: string, options: RunOptions, ownerPassword: string): Promise<void> {
  await azWith("vm create", {
    ...licenseFlags(options.image),
    "-g": group,
    "-n": "vm",
    "--image": options.image,
    "--size": options.size,
    "--admin-username": OWNER_NAME,
    "--admin-password": ownerPassword,
    "--security-type": "TrustedLaunch",
    "--enable-secure-boot": "true",
    "--enable-vtpm": "true",
    "--public-ip-sku": "Standard",
    "--nsg-rule": "NONE",
    "--os-disk-delete-option": "Delete",
    "--nic-delete-option": "Delete",
    "--tags": `${CANARY_TAG}=1`,
    "-o": "none",
  });
}

/** The run's storage: a private container holding the scripts going in and the evidence coming out. */
async function createStorage(group: string, account: string, options: RunOptions): Promise<Storage> {
  await azWith("storage account create", {
    "-g": group,
    "-n": account,
    "-l": options.location,
    "--sku": "Standard_LRS",
    "--allow-blob-public-access": "false",
    "--min-tls-version": "TLS1_2",
    "-o": "none",
  });
  const key = await azWith("storage account keys list", {
    "-g": group,
    "-n": account,
    "--query": "[0].value",
    "-o": "tsv",
  });
  const storage = { "--account-name": account, "--account-key": key };
  await azWith("storage container create", { ...storage, "-n": CONTAINER, "-o": "none" });
  await azWith("storage blob upload", {
    ...storage,
    "-c": CONTAINER,
    "-n": "src.zip",
    "-f": options.source,
    "--overwrite": true,
    "-o": "none",
  });
  return storage;
}

/** The resource group with the VM and the storage, ready for the phases. */
async function create(group: string, account: string, options: RunOptions, ownerPassword: string): Promise<Storage> {
  const expires = new Date(Date.now() + GROUP_LIFETIME_MS).toISOString();
  await az(["group", "create", "-n", group, "-l", options.location, "--tags", `${CANARY_TAG}=1`, `expires=${expires}`]);
  await createVm(group, options, ownerPassword);
  return createStorage(group, account, options);
}

/** Azure's own sentence in a failed call's output (its last `Message:` line), for the log. */
export function azureReason(output: string): string {
  const messages = [...output.matchAll(/Message: (.+)/g)].map((match) => match[1]?.trim() ?? "");
  return messages.at(-1) ?? output.trim().split("\n").at(-1) ?? "";
}

/** Where the run's machine was made. */
interface Placed {
  group: string;
  storage: Storage;
}

/**
 * Make the machine in the first region and size that take it: quota for the size, the region open
 * to this subscription and capacity there now. Each refusal leaves its group deleted behind it; any
 * other failure stops.
 */
async function createSomewhere(
  options: Omit<RunOptions, "size" | "location">,
  sizeAsked: string,
  locations: readonly string[],
  ownerPassword: string,
): Promise<Placed> {
  const runId = process.env.GITHUB_RUN_ID ?? `${Date.now()}`;
  const attempt = process.env.GITHUB_RUN_ATTEMPT ?? "1";
  let tries = 0;
  for (const location of locations) {
    const sizes = await sizesFor(sizeAsked, location).catch((error: Error) => {
      console.log(`${location}: ${error.message}`);
      return [];
    });
    if (sizes.length === 0) console.log(`${location}: no quota for ${SIZE_PREFERENCES.map((p) => p.size).join(", ")}`);
    for (const size of sizes) {
      const group = groupName(runId, `${attempt}${tries}`, options.machine);
      const account = storageName(runId, `${attempt}${tries}`, options.machine);
      tries++;
      try {
        console.log(`trying ${size} in ${location}`);
        return { group, storage: await create(group, account, { ...options, size, location }, ownerPassword) };
      } catch (error) {
        await deleteGroup(group);
        if (!triesElsewhere(String(error))) throw error;
        console.log(`${location} refused ${size}: ${azureReason(String(error))}`);
      }
    }
  }
  throw new Error(`no size and region of ${locations.join(", ")} could make the machine`);
}

/** The whole run on one VM: create, the owner's pass, the standard user's pass, evidence back, delete. */
async function runMachine(
  options: Omit<RunOptions, "size" | "location">,
  sizeAsked: string,
  locations: readonly string[],
): Promise<void> {
  const ownerPassword = windowsPassword();
  const userPassword = windowsPassword();
  for (const secret of [ownerPassword, userPassword]) console.log(`::add-mask::${secret}`);
  await mkdir(options.evidence, { recursive: true });
  let group: string | null = null;
  try {
    const placed = await createSomewhere(options, sizeAsked, locations, ownerPassword);
    group = placed.group;
    const { storage } = placed;
    const owner = options.upgradeFrom ? UPGRADE_OWNER_NAME : OWNER_NAME;
    const common = {
      Machine: options.machine,
      Tag: options.tag,
      UserName: USER_NAME,
      UserPassword: userPassword,
      Files: String(AZURE_PROFILE_FILES),
      ...(options.upgradeFrom ? { UpgradeFrom: options.upgradeFrom } : {}),
    };
    await phase(group, "Prepare", {
      ...common,
      SourceUrl: await blobUrl(storage, "src.zip", "r"),
      NodeVersion: options.nodeVersion,
      OwnerName: owner,
      OwnerPassword: ownerPassword,
    });
    await restart(group);
    await phase(group, "Owner", { ...common, OwnerName: owner });
    await restart(group);
    await phase(group, "Standard", common);
    await phase(group, "Collect", { UploadUrl: await blobUrl(storage, "evidence.zip", "cw") });
    const zip = path.join(options.evidence, "evidence.zip");
    await azWith("storage blob download", {
      ...storage,
      "-c": CONTAINER,
      "-n": "evidence.zip",
      "-f": zip,
      "-o": "none",
    });
    await sh("unzip", ["-q", "-o", zip, "-d", options.evidence]);
    await ownerResult(options.evidence, options.machine, options.tag);
    if (!(await allPassed(options.evidence))) process.exitCode = 1;
  } catch (error) {
    await writeFile(path.join(options.evidence, "azure-error.txt"), String(error));
    throw error;
  } finally {
    if (group) await deleteGroup(group);
  }
}

/**
 * The owner's result in a VM's evidence (azure-vm.ps1 keeps it in a folder named after the persona),
 * or a failed stand-in written in its place when the owner's run left none: its first start is what
 * sets the sandbox up, so a machine whose owner never ran fails as such, not as the standard user's.
 */
export async function ownerResult(evidence: string, machine: string, tag: string): Promise<MachineResult> {
  const dir = path.join(evidence, Persona.Owner);
  const file = path.join(dir, RESULT_FILE);
  const written = await access(file).then(
    () => true,
    () => false,
  );
  if (written) return readResult(file);
  const record = recorder(dir, { machine, kind: PackageKind.Exe, tag });
  await record.add({
    step: CanaryStep.Link,
    outcome: StepOutcome.Fail,
    persona: Persona.Owner,
    detail: MESSAGE.ownerDidNotStart,
  });
  return record.result;
}

/** Whether every result.json the VM sent back passed (none at all is a failure). */
async function allPassed(dir: string): Promise<boolean> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && entry.name === RESULT_FILE);
  const results = await Promise.all(files.map((entry) => readResult(path.join(entry.parentPath, entry.name))));
  return results.length > 0 && results.every(machinePassed);
}

/** Delete canary resource groups whose expiry has passed (a cancelled run leaves its group behind). */
async function sweep(now = Date.now()): Promise<void> {
  const listed = await az([
    "group",
    "list",
    "--tag",
    `${CANARY_TAG}=1`,
    "--query",
    "[].{name:name, expires:tags.expires}",
    "-o",
    "json",
  ]);
  const groups = JSON.parse(listed || "[]") as Array<{ name: string; expires?: string }>;
  for (const { name, expires } of groups) {
    if (expires && Date.parse(expires) > now) continue;
    console.log(`deleting expired ${name}`);
    await deleteGroup(name);
  }
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      machine: { type: "string" },
      image: { type: "string" },
      tag: { type: "string" },
      source: { type: "string" },
      evidence: { type: "string" },
      size: { type: "string", default: "" },
      location: { type: "string", default: "" },
      "upgrade-from": { type: "string", default: "" },
    },
  });
  if (positionals[0] === "sweep") return sweep();
  const { machine, image, tag, source, evidence } = values;
  if (positionals[0] !== "run" || !machine || !image || !tag || !source || !evidence)
    throw new Error("usage: azure.ts run --machine --image --tag --source --evidence | azure.ts sweep");
  const nodeVersion = process.version.replace(/^v/, "");
  const locations = values.location ? values.location.split(",").map((name) => name.trim()) : DEFAULT_LOCATIONS;
  const upgradeFrom = values["upgrade-from"] ? { upgradeFrom: values["upgrade-from"] } : {};
  await runMachine({ machine, image, tag, source, evidence, nodeVersion, ...upgradeFrom }, values.size, locations);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
