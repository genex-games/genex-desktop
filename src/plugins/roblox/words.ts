/**
 * What the Roblox Studio plugin says to the person: the toolbar button's words for each state of
 * Studio, and its refusals. Plain words; never the Roblox logo or a promise for later.
 */

/** Studio's version as people read it: its first two parts (0.743 of 0.743.0.7431133). */
export const shortVersion = (version: string) => version.split(".").slice(0, 2).join(".");

/** How the steps card counts its open steps: in words, up to the five it holds. */
const COUNT_WORDS = ["", "One", "Two", "Three", "Four", "Five"] as const;

/** A count with its noun: "1 error", "3 errors". */
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** Where Studio's own MCP switch is, as the person clicks it. */
export const MCP_SWITCH_CLICK_PATH = "Assistant › ⋯ › Settings › MCP Servers › Enable Studio as MCP server";

/** Where Studio publishes the open place, as the person clicks it: an update, and a place's first publish too. */
export const PUBLISH_CLICK_PATH = "File › Publish to Roblox";

/** Where Studio's switch for a place's live saved data is, as the person clicks it to turn it off. */
export const LIVE_DATA_CLICK_PATH = "Game Settings › Security › Enable Studio Access to API Services";

export const MESSAGE = {
  UnknownAction: (name: string) => `Unknown Roblox Studio action: ${name}`,
  UnknownTool: (name: string) => `Unknown Roblox Studio tool: ${name}`,
  Checks: {
    NoGame: "check-scripts checks a game's scripts, and this call has no game.",
    NoScripts: "This game has no .luau scripts under src/ to check.",
    AllClean: "Every script under src/ passed its last check and hasn't changed since.",
    /** What was found, the counts above zero only: "2 errors, 1 format difference". */
    Counts: (errors: number, warnings: number, format: number) =>
      [
        errors > 0 ? plural(errors, "error") : "",
        warnings > 0 ? plural(warnings, "warning") : "",
        format > 0 ? plural(format, "format difference") : "",
      ]
        .filter(Boolean)
        .join(", ") || "nothing to fix",
    Summary: (files: number, counts: string) => `Luau checks of ${plural(files, "file")}: ${counts}.`,
    Clean: (files: number) => `Luau checks of ${plural(files, "file")} found nothing to fix.`,
    Format: (start: number, end: number) =>
      start === end ? `StyLua lays out line ${start} differently` : `StyLua lays out lines ${start}–${end} differently`,
    Missing: (tools: string[]) =>
      `Not checked by ${tools.join(" or ")}: ${tools.length === 1 ? "it isn't" : "they aren't"} on this computer.`,
    NoDefinitions:
      "luau-lsp didn't run: Roblox's type definitions aren't added (Add Luau checks in the Roblox Studio panel adds them).",
    Failed: (tool: string, why: string) => `${tool} didn't check: ${why}.`,
    TimedOut: (seconds: number) => `it didn't finish within ${seconds} seconds`,
    Cut: (megabytes: number) => `it printed more than ${megabytes} MB`,
    Code: (code: number) => `it stopped with code ${code}`,
    CouldNotStart: (why: string) => `it couldn't start (${why})`,
    Stopped: "it was stopped",
    Left: (files: number) =>
      files === 1 ? "1 more file waits for the next check." : `${files} more files wait for the next check.`,
    FinishHeld: (errors: number, first: string) =>
      `The game's Luau has ${plural(errors, "error")}. First: ${first} Fix them (check-scripts lists them all), then finish again.`,
    WorkerNote: (title: string, counts: string) => `Luau checks after ${title}: ${counts}.`,
    AWorker: "a worker",
  },
  Luau: {
    Confirm: (megabytes: number) =>
      `Download luau-lsp, selene and StyLua from GitHub (about ${megabytes} MB) for checking this game's scripts?`,
    Plan: "Genex downloads the pinned releases only, checks each file's size and fingerprint, and keeps them in its own storage. They run on this computer to check scripts, outside Genex's sandbox, as copies you installed yourself would.",
    Added: "Luau checks are added: scripts are checked at each worker's end and before a build finishes.",
    AlreadyAdded: "Luau checks are already on this computer.",
    Refused: {
      unsupported: "Genex has no Luau checks to add for this computer.",
      "not-https": "A download wasn't over a secure link, so Genex stopped. Nothing was kept.",
      "other-host": "A download pointed away from GitHub, so Genex stopped. Nothing was kept.",
      "too-large": "A download was larger than the release Genex expects, so Genex stopped. Nothing was kept.",
      mismatch: "A download didn't match the release Genex expects, so Genex stopped. Nothing was kept.",
      "download-failed":
        "Genex couldn't download the Luau checks. Check the connection and press Add Luau checks again.",
      "unpack-failed": "A download couldn't be unpacked, so Genex stopped. Nothing was kept.",
      linked: "Genex's folder for the Luau checks isn't a plain folder, so Genex wrote nothing.",
      cancelled: "Stopped adding the Luau checks. Nothing was kept.",
    },
  },
  Badge: {
    Get: "Not installed",
    SetUp: "Set up",
    NotOpen: "Not open",
    Starting: "Starting",
    Ready: "Ready",
  },
  Title: {
    Get: "Roblox Studio isn't on this computer. Open this to get it.",
    SetUp: "Add the Genex helper to Roblox Studio and turn on its MCP server.",
    NotOpen: (version: string | undefined) =>
      version
        ? `Roblox Studio ${shortVersion(version)} is set up but not open.`
        : "Roblox Studio is set up but not open.",
    Starting: "Roblox Studio is open. Genex is waiting for it to answer.",
    Ready: "Roblox Studio is open and answering Genex.",
  },
  Setup: {
    Confirm: "Add the Genex helper to Roblox Studio's Plugins folder and turn on Studio's MCP server?",
    StudioRunning:
      "Roblox Studio is open. Genex changes Studio's settings only while it is closed: press Restart Studio, or turn the switch on yourself in Studio.",
    OtherSystem: "Genex can't find this computer's Roblox folders: its home folder isn't a full path of this system.",
    NoRobloxFolder: (folder: string) => `${folder} isn't there yet. Open Roblox Studio once, then press Set up again.`,
    Linked: (file: string) =>
      `${file} is a link, so Genex leaves it alone. Make it a real folder or file, then press Set up again.`,
    NotAFolder: (file: string) => `Something Genex doesn't expect is at ${file}, so Genex leaves it alone.`,
    Unreadable: (file: string) =>
      `Genex can't read ${file} as Roblox Studio's settings, so it changes no settings file. Turn Studio's MCP server on in Studio: ${MCP_SWITCH_CLICK_PATH}.`,
    NotSettings: "These aren't Roblox Studio's settings: Studio keeps one JSON object.",
    TwiceNamed: (key: string) => `The settings name "${key}" twice, so Genex leaves them alone.`,
    NotSetUp: "Genex hasn't set up Roblox Studio on this computer, so there's nothing to undo.",
    DocumentsNote: "macOS may ask to let Genex use your Documents folder: Roblox keeps its plugins there.",
    PlanHelper: (folder: string) => `Add the Genex helper to ${folder}.`,
    PlanSwitch: (count: number) =>
      `Turn on Studio's MCP server in the settings of ${count} Roblox ${count === 1 ? "account" : "accounts"} on this computer.`,
    PlanNoSettings: `Studio hasn't saved its settings yet, so turn its MCP server on in Studio: ${MCP_SWITCH_CLICK_PATH}.`,
    PlanUndo: "Genex keeps what was there first, and Undo Set up takes these changes back.",
    Done: "The Genex helper is in Studio's Plugins folder and Studio's MCP server is on.",
    DoneNoSettings: `The Genex helper is in Studio's Plugins folder. Turn Studio's MCP server on in Studio: ${MCP_SWITCH_CLICK_PATH}.`,
    NewerHelper: "A newer Genex helper is already in Studio's Plugins folder, so Genex left it.",
    Undone: "Genex took back what it set up in Roblox Studio.",
    UndoneKept: (count: number) =>
      `Genex took back what it set up in Roblox Studio and left ${count} ${count === 1 ? "file" : "files"} changed since as they are.`,
    NotInstalled: "Roblox Studio isn't on this computer.",
    StillOpen:
      "Roblox Studio is still open. If it asked to save your place, answer it, then press Restart Studio again.",
    Reopened: "Roblox Studio is opening again with the Genex helper.",
  },
  Choice: {
    RestartStudio: "Restart Studio",
    DoItForMe: "Do it for me",
  },
  Assist: {
    /** The task the game's chat is asked to click, verbatim in the chat: plain words, then Studio's own click path. */
    Task: `Turn on Studio's MCP server: ${MCP_SWITCH_CLICK_PATH}. Click only that path, now, with the desktop tool (not do-it-for-me). If Studio shows any other dialog or question (saving, signing in, updates, terms), stop and tell the person.`,
    Started:
      "This game's chat is turning on Studio's MCP server. If Genex asks you something first, answer it in this game's chat, then watch Roblox Studio.",
    Unavailable: `Genex can't click in Roblox Studio on this computer. Turn it on yourself: ${MCP_SWITCH_CLICK_PATH}.`,
    Declined: `Nothing was clicked. Turn it on yourself: ${MCP_SWITCH_CLICK_PATH}.`,
    NoChat: `Open a game first, so its chat can click it for you, or turn it on yourself: ${MCP_SWITCH_CLICK_PATH}.`,
    NotStarted: `Genex didn't click anything. Turn it on yourself: ${MCP_SWITCH_CLICK_PATH}.`,
  },
  Publish: {
    /** The panel's card for a published place: its name, then what happens and whose account it is on. */
    Confirm: (name: string) => `Publish an update of ${name} to Roblox?`,
    Plan: `This game's chat clicks ${PUBLISH_CLICK_PATH} in Roblox Studio with computer control. Everyone who plays the game gets the update, and it is published on your Roblox account.`,
    Started:
      "This game's chat is publishing the update in Roblox Studio. If Genex asks you something first, answer it in this game's chat, then watch Studio.",
    Unavailable: `Genex can't click in Roblox Studio on this computer. Publish it yourself in Studio: ${PUBLISH_CLICK_PATH}.`,
    Declined: `Nothing was published. To publish it yourself in Studio: ${PUBLISH_CLICK_PATH}.`,
    NoChat: `Open this game first, so its chat can publish it, or publish it yourself in Studio: ${PUBLISH_CLICK_PATH}.`,
    NotStarted: `Genex didn't publish anything. To publish it yourself in Studio: ${PUBLISH_CLICK_PATH}.`,
    FirstPublish: (name: string) =>
      `This place isn't on Roblox yet: press Publish to Roblox to publish it the first time, as ${name}.`,
    NoPlace: "This game doesn't build in a Roblox place yet. Choose one with Choose your place first.",
    /** A first publish's card: the name the game gets on Roblox. */
    ConfirmFirst: (name: string) => `Publish ${name} to Roblox as a new game?`,
    PlanFirst: `This game's chat clicks ${PUBLISH_CLICK_PATH} in Roblox Studio with computer control. It keeps the privacy and settings Studio gives a new game and leaves the description empty. It is published on your Roblox account; if Roblox asks for your age, ID, a two-step code, terms or a payment, Genex stops and leaves that to you.`,
    FirstStarted: (name: string) =>
      `This game's chat is publishing ${name} to Roblox in Studio. If Genex asks you something first, answer it in this game's chat, then watch Studio.`,
    AlreadyPublished: "This place is already on Roblox: press Publish an update instead.",
    /** The name of a game with no title or place name of its own. */
    DefaultName: "My Roblox game",
  },
  Install: {
    /** Get Roblox Studio's question, for this computer's installer size. */
    Confirm: (megabytes: number) =>
      `Download Roblox Studio from Roblox (about ${megabytes} MB), check that Roblox signed it, and install it?`,
    Plan: (host: string) =>
      [
        `Genex downloads Roblox's own installer from ${host} and checks that Roblox signed it before it runs.`,
        "Roblox's installer then installs Studio and opens it. Studio asks you to sign in: Genex never sees your password.",
        "Once you've signed in, that Studio closes by itself. Genex then adds its helper, turns on Studio's MCP server, and opens Studio again.",
      ].join("\n"),
    Started: "Getting Roblox Studio. Studio asks you to sign in when it opens.",
    AlreadyInstalled: (version: string | undefined) =>
      version
        ? `Roblox Studio ${shortVersion(version)} is already on this computer.`
        : "Roblox Studio is already on this computer.",
    AlreadyGetting: "Genex is already getting Roblox Studio.",
    NothingToStop: "Genex isn't getting Roblox Studio right now.",
    Stopped: "Stopped getting Roblox Studio. Anything Roblox's installer already put on this computer stays.",
    Reopened: "Roblox Studio is opening again with the Genex helper.",
    Phase: {
      downloading: "Downloading Roblox's installer.",
      checking: "Checking that Roblox signed the installer.",
      installing: "Roblox's installer is installing Studio.",
      "waiting-for-studio": "Waiting for Roblox Studio to finish installing.",
      "signing-in": "Sign in to Roblox in the Studio that just opened. It closes by itself once you have.",
      "setting-up": "Setting Roblox Studio up for Genex.",
      opening: "Opening Roblox Studio.",
      done: "Roblox Studio is installed and set up.",
      failed: "Genex couldn't get Roblox Studio.",
    },
    Refused: {
      unsupported: "Roblox Studio runs on a Mac or on Windows only.",
      "not-https": "Genex downloads Roblox Studio only over a secure link, and this one isn't. Nothing was installed.",
      "other-host": "The download pointed away from Roblox's own site, so Genex stopped. Nothing was installed.",
      "too-large": "The download was much larger than Roblox's installer, so Genex stopped. Nothing was installed.",
      "download-failed":
        "Genex couldn't download Roblox's installer. Check the connection and press Get Roblox Studio again.",
      unsigned: "The installer isn't signed as Roblox's, so Genex didn't run it. Nothing was installed.",
      "wrong-signer":
        "The installer is signed by someone other than Roblox, so Genex didn't run it. Nothing was installed.",
      "no-installer": "Roblox's download didn't hold its installer, so Genex didn't run anything.",
      "installer-failed": "Roblox's installer stopped before it finished. Press Get Roblox Studio to try again.",
      cancelled: "Stopped getting Roblox Studio.",
      "not-installed":
        "Roblox's installer finished, but Roblox Studio didn't appear. Press Get Roblox Studio to try again.",
      "still-open":
        "Roblox Studio is still open. Sign in there; once it has closed by itself, press Set up so Genex can finish.",
    },
  },
  Steps: {
    Title: "Roblox Studio setup",
    Intro: (open: number) =>
      open === 1
        ? "One step left so agents can build in Roblox Studio."
        : `${COUNT_WORDS[open] ?? open} steps left so agents can build in Roblox Studio.`,
    AllDone: "Everything Roblox Studio needs from you is done.",
    StudioDone: (version: string | undefined) =>
      version ? `Roblox Studio ${shortVersion(version)} is on this computer` : "Roblox Studio is on this computer",
    StudioDoneDetail: "Genex uses your own Studio.",
    GetStudio: "Get Roblox Studio",
    GetStudioDetail: "Genex downloads it from Roblox, checks that Roblox signed it, and installs it.",
    Getting: "Getting Roblox Studio",
    Stop: "Stop",
    SignIn: "Sign in to Roblox",
    SignInDetail:
      "Studio asks you to sign in when it opens. No Roblox account yet? Choose Sign up on Studio's sign-in screen. Genex never sees your password.",
    /** Before the MCP step's own line while Studio doesn't answer: a Studio on its sign-in screen answers nothing. */
    SignInFirst: "If Studio shows its sign-in screen, sign in there first.",
    SignedIn: "Signed in to Roblox",
    OpenStudio: "Open Studio",
    Helper: "Add the Genex helper",
    HelperDetail: "Set up adds it to Studio's Plugins folder and turns on Studio's MCP server while Studio is closed.",
    HelperStudioOpen:
      "Roblox Studio is open, and Genex adds its helper only while Studio is closed. Restart Studio closes it, sets it up and opens it again.",
    HelperDone: "The Genex helper is in Studio",
    HelperDoneDetail:
      "It keeps your scripts as files in this game's folder and tells Genex which Studio is this game's.",
    SetUp: "Set up",
    Mcp: "Turn on Studio's MCP server",
    McpLater: "Set up turns it on while Studio is closed.",
    McpWhenOpen: "Studio answers Genex once it's open.",
    McpOff: "Studio was already open, so Genex couldn't switch it on by itself.",
    McpOnWaiting: "It's switched on in Studio's settings. Studio answers once it has finished opening.",
    McpOnNoPlace:
      "It's switched on in Studio's settings. Studio answers once a place is open: open one in Studio, or press New Roblox game.",
    McpDone: "Studio's MCP server is on and answering Genex",
    McpDoneDetail: "Agents work in your open place through it.",
    Waiting: "Waiting for Studio to answer",
    /** The card's line for a step the panel shows Studio's own clicks for. */
    OrInStudio: (clicks: string) => `Or in Studio: ${clicks}.`,
    Place: "Choose this game's place",
    PlaceDetail: "A place open in Roblox Studio, or a new one.",
    /** The chat's card's line after the place step's: where to choose it. */
    PlaceCardHint: "Choose it with the Roblox Studio button.",
    PlaceDone: "This game builds in a Roblox place",
    PlaceDoneNamed: (name: string) => `This game builds in ${name}`,
    PlaceDoneDetail: "Agents build in it in your Studio, and its scripts are files in this game's folder.",
    PlaceRojo: "Rojo keeps your scripts in step, so Genex leaves them to it.",
    LiveData:
      "Studio can reach this game's live saved data, so play tests here read and write what real players saved. To test without it, turn this off in Studio:",
  },
  Open: {
    Opening: "Opening Roblox Studio.",
    AlreadyOpen: "Roblox Studio is already open.",
    NotInstalled: "Roblox Studio isn't on this computer. Press Get Roblox Studio first.",
    OpeningPlace: (name: string) => `Opening ${name} in Roblox Studio.`,
    PlaceAlreadyOpen: (name: string) => `${name} is already open in Roblox Studio.`,
    NotSaved: (name: string) =>
      `${name} was never saved to a file, so Genex can't open it. Open it in Roblox Studio, or choose another place.`,
  },
  Quit: {
    Quitting: "Roblox Studio closed. It asked to save anything unsaved first.",
    NotRunning: "Roblox Studio isn't open.",
    StillOpen: "Roblox Studio is still open. If it asked to save your place, answer it, then press Quit Studio again.",
    InUse: (title: string) => `A build of ${title} is using Roblox Studio, so Genex leaves it open.`,
  },
  Places: {
    BadFile: (file: string) =>
      file ? `${file} isn't a Roblox place file (.rbxl or .rbxlx) on this computer.` : "Choose a place first.",
    NotPlace: (file: string) => `There's no place file at ${file}.`,
    LinkedFile: (file: string) => `${file} is a link, so Genex leaves it. Choose the place file itself.`,
    NotListed: "That Studio isn't open any more. Choose your place again.",
    NotOpenNamed: (name: string) => `No Roblox Studio has a place named ${JSON.stringify(name)} open.`,
    SameName: (name: string) =>
      `Two open Studios have a place named ${name}, so Genex can't tell them apart. Save one under another name in Studio, then choose it again.`,
    NoAnswer: (name: string) =>
      `Roblox Studio didn't say what ${name} is. If a play test or a dialog is open in Studio, finish it, then choose the place again.`,
    NoGame: "Open a game first, then choose the place it builds in.",
    Taken: (name: string, title: string) => `${name} already builds in ${title}.`,
    ProjectInTheWay: "default.project.json in this game's folder is a link or not a file, so Genex leaves it.",
    SnapshotReason: "Before linking a Roblox place",
    Linked: (name: string) => `This game builds in ${name} now.`,
    LinkedByName: (name: string) =>
      `This game builds in ${name} now. It isn't saved to a file, so Genex finds it in Studio by its name; save points keep its scripts and parts in this game's folder.`,
  },
  Create: {
    DefaultTitle: "Roblox game",
    SnapshotReason: "Before New Roblox game",
    Created: (name: string) => `Made ${name} in this game's folder and opened it in Roblox Studio.`,
    CreatedNotOpened: (name: string, why: string) =>
      `Made ${name} in this game's folder and linked it, but Roblox Studio didn't open: ${why}`,
    Exists: "This game already builds in a Roblox place. Choose another place from the list instead.",
  },
} as const;
