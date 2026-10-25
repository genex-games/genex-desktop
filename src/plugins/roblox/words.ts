/**
 * What the Roblox Studio plugin says. To the person: the toolbar button's words for each state of
 * Studio, the setup card and the panel's answers, its confirmations and refusals; each is a function
 * that calls t() when it is said, so it comes in Genex's language of that moment. To the agent: the
 * Luau checks' results (`Checks`), the tool refusals and the chat's task (`Assist.Task`), in English.
 * Names that land in files, on Roblox or in a save point's history stay English too. Plain words;
 * never the Roblox logo or a promise for later.
 */
import { t, tc } from "../../shared/i18n.ts";

/** Studio's version as people read it: its first two parts (0.743 of 0.743.0.7431133). */
export const shortVersion = (version: string) => version.split(".").slice(0, 2).join(".");

/** A count with its noun, for the agent's words: "1 error", "3 errors". */
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** Where Studio's own MCP switch is, as the person clicks it. */
export const MCP_SWITCH_CLICK_PATH = "Assistant › ⋯ › Settings › MCP Servers › Enable Studio as MCP server";

/** Where Studio publishes the open place, as the person clicks it: an update, and a place's first publish too. */
export const PUBLISH_CLICK_PATH = "File › Publish to Roblox";

/** Where Studio's switch for a place's live saved data is, as the person clicks it to turn it off. */
export const LIVE_DATA_CLICK_PATH = "Game Settings › Security › Enable Studio Access to API Services";

/** Roblox's own button on Studio's sign-in screen: Roblox's words, never translated by Genex. */
const SIGN_UP_BUTTON = "Sign up";

/** Studio's MCP switch, as the sentences that name it take it. */
const mcpClicks = { clicks: MCP_SWITCH_CLICK_PATH };
/** Studio's publish clicks, as the sentences that name them take them. */
const publishClicks = { clicks: PUBLISH_CLICK_PATH };

export const MESSAGE = {
  UnknownAction: (name: string) => t("Unknown Roblox Studio action: {name}", { name }),
  /** The agent's: a tool's refusal stays English. */
  UnknownTool: (name: string) => `Unknown Roblox Studio tool: ${name}`,
  /** What check-scripts and the Luau moments tell the agent: English. */
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
      t("Download luau-lsp, selene and StyLua from GitHub (about {megabytes} MB) for checking this game's scripts?", {
        megabytes,
      }),
    Plan: () =>
      t(
        "Genex downloads the pinned releases only, checks each file's size and fingerprint, and keeps them in its own storage. They run on this computer to check scripts, outside Genex's sandbox, as copies you installed yourself would.",
      ),
    Added: () => t("Luau checks are added: scripts are checked at each worker's end and before a build finishes."),
    AlreadyAdded: () => t("Luau checks are already on this computer."),
    Refused: {
      unsupported: () => t("Genex has no Luau checks to add for this computer."),
      "not-https": () => t("A download wasn't over a secure link, so Genex stopped. Nothing was kept."),
      "other-host": () => t("A download pointed away from GitHub, so Genex stopped. Nothing was kept."),
      "too-large": () => t("A download was larger than the release Genex expects, so Genex stopped. Nothing was kept."),
      mismatch: () => t("A download didn't match the release Genex expects, so Genex stopped. Nothing was kept."),
      "download-failed": () =>
        t("Genex couldn't download the Luau checks. Check the connection and press Add Luau checks again."),
      "unpack-failed": () => t("A download couldn't be unpacked, so Genex stopped. Nothing was kept."),
      linked: () => t("Genex's folder for the Luau checks isn't a plain folder, so Genex wrote nothing."),
      cancelled: () => t("Stopped adding the Luau checks. Nothing was kept."),
    },
  },
  Badge: {
    Get: () => t("Not installed"),
    SetUp: () => tc("badge", "Set up"),
    NotOpen: () => t("Not open"),
    Starting: () => t("Starting"),
    Ready: () => t("Ready"),
  },
  Title: {
    Get: () => t("Roblox Studio isn't on this computer. Open this to get it."),
    SetUp: () => t("Add the Genex helper to Roblox Studio and turn on its MCP server."),
    NotOpen: (version: string | undefined) =>
      version
        ? t("Roblox Studio {version} is set up but not open.", { version: shortVersion(version) })
        : t("Roblox Studio is set up but not open."),
    Starting: () => t("Roblox Studio is open. Genex is waiting for it to answer."),
    Ready: () => t("Roblox Studio is open and answering Genex."),
  },
  Setup: {
    StudioRunning: () =>
      t(
        "Roblox Studio is open. Genex changes Studio's settings only while it is closed: press Restart Studio, or turn the switch on yourself in Studio.",
      ),
    OtherSystem: () =>
      t("Genex can't find this computer's Roblox folders: its home folder isn't a full path of this system."),
    NoRobloxFolder: (folder: string) =>
      t("{folder} isn't there yet. Open Roblox Studio once, then press Set up again.", { folder }),
    Linked: (file: string) =>
      t("{file} is a link, so Genex leaves it alone. Make it a real folder or file, then press Set up again.", {
        file,
      }),
    NotAFolder: (file: string) => t("Something Genex doesn't expect is at {file}, so Genex leaves it alone.", { file }),
    Unreadable: (file: string) =>
      t(
        "Genex can't read {file} as Roblox Studio's settings, so it changes no settings file. Turn Studio's MCP server on in Studio: {clicks}.",
        { file, ...mcpClicks },
      ),
    NotSettings: () => t("These aren't Roblox Studio's settings: Studio keeps one JSON object."),
    TwiceNamed: (key: string) => t('The settings name "{key}" twice, so Genex leaves them alone.', { key }),
    NotSetUp: () => t("Genex hasn't set up Roblox Studio on this computer, so there's nothing to undo."),
    DocumentsNote: () => t("macOS may ask to let Genex use your Documents folder: Roblox keeps its plugins there."),
    Done: () => t("The Genex helper is in Studio's Plugins folder and Studio's MCP server is on."),
    DoneNoSettings: () =>
      t("The Genex helper is in Studio's Plugins folder. Turn Studio's MCP server on in Studio: {clicks}.", mcpClicks),
    NewerHelper: () => t("A newer Genex helper is already in Studio's Plugins folder, so Genex left it."),
    Undone: () => t("Genex took back what it set up in Roblox Studio."),
    UndoneKept: (count: number) =>
      t(
        "Genex took back what it set up in Roblox Studio and left {count, plural, one {# file} other {# files}} changed since as they are.",
        { count },
      ),
    NotInstalled: () => t("Roblox Studio isn't on this computer."),
    StillOpen: () =>
      t("Roblox Studio is still open. If it asked to save your place, answer it, then press Restart Studio again."),
    Reopened: () => t("Roblox Studio is opening again with the Genex helper."),
  },
  Choice: {
    RestartStudio: () => t("Restart Studio"),
    DoItForMe: () => t("Do it for me"),
  },
  /** Set it up for me's answers when it had nothing to run. */
  ForMe: {
    SignIn: () =>
      t("Genex has done every step it can. Sign in to Roblox in Studio; once Studio answers, agents can build."),
    Done: () => t("Roblox Studio is set up and answering Genex, and this game builds in its place."),
  },
  Assist: {
    /** The task the game's chat is asked to click, verbatim in the chat: the agent's, in English, then Studio's own click path. */
    Task: `Turn on Studio's MCP server: ${MCP_SWITCH_CLICK_PATH}. Click only that path, now, with the desktop tool (not do-it-for-me). If Studio shows any other dialog or question (saving, signing in, updates, terms), stop and tell the person.`,
    Started: () =>
      t(
        "This game's chat is turning on Studio's MCP server. If Genex asks you something first, answer it in this game's chat, then watch Roblox Studio.",
      ),
    Unavailable: () =>
      t("Genex can't click in Roblox Studio on this computer. Turn it on yourself: {clicks}.", mcpClicks),
    Declined: () => t("Nothing was clicked. Turn it on yourself: {clicks}.", mcpClicks),
    NoChat: () =>
      t("Open a game first, so its chat can click it for you, or turn it on yourself: {clicks}.", mcpClicks),
    NotStarted: () => t("Genex didn't click anything. Turn it on yourself: {clicks}.", mcpClicks),
  },
  Publish: {
    /** The panel's card for a published place: its name, then what happens and whose account it is on. */
    Confirm: (name: string) => t("Publish an update of {name} to Roblox?", { name }),
    /** The same card for a place without a name to show. */
    ConfirmUnnamed: () => t("Publish an update of this game's place to Roblox?"),
    Plan: () =>
      t(
        "This game's chat clicks {clicks} in Roblox Studio with computer control. Everyone who plays the game gets the update, and it is published on your Roblox account.",
        publishClicks,
      ),
    Started: () =>
      t(
        "This game's chat is publishing the update in Roblox Studio. If Genex asks you something first, answer it in this game's chat, then watch Studio.",
      ),
    Unavailable: () =>
      t("Genex can't click in Roblox Studio on this computer. Publish it yourself in Studio: {clicks}.", publishClicks),
    Declined: () => t("Nothing was published. To publish it yourself in Studio: {clicks}.", publishClicks),
    NoChat: () =>
      t("Open this game first, so its chat can publish it, or publish it yourself in Studio: {clicks}.", publishClicks),
    NotStarted: () => t("Genex didn't publish anything. To publish it yourself in Studio: {clicks}.", publishClicks),
    FirstPublish: (name: string) =>
      t("This place isn't on Roblox yet: press Publish to Roblox to publish it the first time, as {name}.", { name }),
    NoPlace: () => t("This game doesn't build in a Roblox place yet. Choose one with Choose your place first."),
    /** A first publish's card: the name the game gets on Roblox. */
    ConfirmFirst: (name: string) => t("Publish {name} to Roblox as a new game?", { name }),
    PlanFirst: () =>
      t(
        "This game's chat clicks {clicks} in Roblox Studio with computer control. It keeps the privacy and settings Studio gives a new game and leaves the description empty. It is published on your Roblox account; if Roblox asks for your age, ID, a two-step code, terms or a payment, Genex stops and leaves that to you.",
        publishClicks,
      ),
    FirstStarted: (name: string) =>
      t(
        "This game's chat is publishing {name} to Roblox in Studio. If Genex asks you something first, answer it in this game's chat, then watch Studio.",
        { name },
      ),
    AlreadyPublished: () => t("This place is already on Roblox: press Publish an update instead."),
    /** The name of a game with no title or place name of its own: its name on Roblox, so English. */
    DefaultName: "My Roblox game",
  },
  Install: {
    Started: () => t("Getting Roblox Studio. Studio asks you to sign in when it opens."),
    AlreadyInstalled: (version: string | undefined) =>
      version
        ? t("Roblox Studio {version} is already on this computer.", { version: shortVersion(version) })
        : t("Roblox Studio is already on this computer."),
    AlreadyGetting: () => t("Genex is already getting Roblox Studio."),
    NothingToStop: () => t("Genex isn't getting Roblox Studio right now."),
    Stopped: () => t("Stopped getting Roblox Studio. Anything Roblox's installer already put on this computer stays."),
    Reopened: () => t("Roblox Studio is opening again with the Genex helper."),
    Phase: {
      downloading: () => t("Downloading Roblox's installer."),
      checking: () => t("Checking that Roblox signed the installer."),
      installing: () => t("Roblox's installer is installing Studio."),
      "waiting-for-studio": () => t("Waiting for Roblox Studio to finish installing."),
      "signing-in": () =>
        t("Sign in to Roblox in the Studio that just opened. Genex then closes it, sets it up and opens it again."),
      "setting-up": () => t("Setting Roblox Studio up for Genex."),
      opening: () => t("Opening Roblox Studio."),
      done: () => t("Roblox Studio is installed and set up."),
      failed: () => t("Genex couldn't get Roblox Studio."),
    },
    Refused: {
      unsupported: () => t("Roblox Studio runs on a Mac or on Windows only."),
      "not-https": () =>
        t("Genex downloads Roblox Studio only over a secure link, and this one isn't. Nothing was installed."),
      "other-host": () =>
        t("The download pointed away from Roblox's own site, so Genex stopped. Nothing was installed."),
      "too-large": () =>
        t("The download was much larger than Roblox's installer, so Genex stopped. Nothing was installed."),
      "download-failed": () =>
        t("Genex couldn't download Roblox's installer. Check the connection and press Get Roblox Studio again."),
      unsigned: () => t("The installer isn't signed as Roblox's, so Genex didn't run it. Nothing was installed."),
      "wrong-signer": () =>
        t("The installer is signed by someone other than Roblox, so Genex didn't run it. Nothing was installed."),
      "no-installer": () => t("Roblox's download didn't hold its installer, so Genex didn't run anything."),
      "installer-failed": () =>
        t("Roblox's installer stopped before it finished. Press Get Roblox Studio to try again."),
      cancelled: () => t("Stopped getting Roblox Studio."),
      "not-installed": () =>
        t("Roblox's installer finished, but Roblox Studio didn't appear. Press Get Roblox Studio to try again."),
      "still-open": () =>
        t(
          "Roblox Studio is still open, and nobody signed in to Roblox there in time. Sign in there, then press Set it up for me so Genex can finish.",
        ),
    },
  },
  Steps: {
    Title: () => t("Roblox Studio setup"),
    /** How many steps are open, in words up to the five the card holds. */
    Intro: (open: number) =>
      t(
        "{count, plural, =1 {One step left so agents can build in Roblox Studio.} =2 {Two steps left so agents can build in Roblox Studio.} =3 {Three steps left so agents can build in Roblox Studio.} =4 {Four steps left so agents can build in Roblox Studio.} =5 {Five steps left so agents can build in Roblox Studio.} other {# steps left so agents can build in Roblox Studio.}}",
        { count: open },
      ),
    AllDone: () => t("Everything Roblox Studio needs from you is done."),
    /** After the intro while signing in is open: the one step that is the person's. */
    SignInYours: () => t("Signing in to Roblox is yours; Genex does the rest."),
    /** The card's own button: every step Genex can do now. */
    ForMe: () => t("Set it up for me"),
    StudioDone: (version: string | undefined) =>
      version
        ? t("Roblox Studio {version} is on this computer", { version: shortVersion(version) })
        : t("Roblox Studio is on this computer"),
    StudioDoneDetail: () => t("Genex uses your own Studio."),
    GetStudio: () => t("Get Roblox Studio"),
    GetStudioDetail: () => t("Genex downloads it from Roblox, checks that Roblox signed it, and installs it."),
    Getting: () => t("Getting Roblox Studio"),
    Stop: () => t("Stop"),
    SignIn: () => t("Sign in to Roblox"),
    SignInDetail: () =>
      t(
        "Studio asks you to sign in when it opens. No Roblox account yet? Choose {signUp} on Studio's sign-in screen. Genex never sees your password.",
        { signUp: SIGN_UP_BUTTON },
      ),
    /** Before the MCP step's own line while Studio doesn't answer: a Studio on its sign-in screen answers nothing. */
    SignInFirst: () => t("If Studio shows its sign-in screen, sign in there first."),
    SignedIn: () => t("Signed in to Roblox"),
    OpenStudio: () => t("Open Studio"),
    Helper: () => t("Add the Genex helper"),
    HelperDetail: () =>
      t("Genex adds it to Studio's Plugins folder and turns on Studio's MCP server while Studio is closed."),
    /** A step Genex does after the sign-in that Get Roblox Studio waits for. */
    AfterSignIn: () => t("Genex does this once you've signed in."),
    HelperStudioOpen: () =>
      t(
        "Roblox Studio is open, and Genex adds its helper only while Studio is closed. Restart Studio closes it, sets it up and opens it again.",
      ),
    HelperDone: () => t("The Genex helper is in Studio"),
    HelperDoneDetail: () =>
      t("It keeps your scripts as files in this game's folder and tells Genex which Studio is this game's."),
    SetUp: () => t("Set up"),
    Mcp: () => t("Turn on Studio's MCP server"),
    McpLater: () => t("Genex turns it on while Studio is closed."),
    McpWhenOpen: () => t("Studio answers Genex once it's open."),
    McpOff: () => t("Studio was already open, so Genex couldn't switch it on by itself."),
    McpOnWaiting: () => t("It's switched on in Studio's settings. Studio answers once it has finished opening."),
    McpOnNoPlace: () =>
      t(
        "It's switched on in Studio's settings. Studio answers once a place is open: open one in Studio, or press New Roblox game.",
      ),
    McpDone: () => t("Studio's MCP server is on and answering Genex"),
    McpDoneDetail: () => t("Agents work in your open place through it."),
    Waiting: () => t("Waiting for Studio to answer"),
    /** The card's line for a step the panel shows Studio's own clicks for. */
    OrInStudio: (clicks: string) => t("Or in Studio: {clicks}.", { clicks }),
    Place: () => t("Choose this game's place"),
    PlaceDetail: () => t("Genex makes a new place for this game."),
    /** The chat's card's line after the place step's: where to choose one of the person's own instead. */
    PlaceCardHint: () => t("To build in one of yours instead, choose it with the Roblox Studio button."),
    PlaceDone: () => t("This game builds in a Roblox place"),
    PlaceDoneNamed: (name: string) => t("This game builds in {name}", { name }),
    PlaceDoneDetail: () => t("Agents build in it in your Studio, and its scripts are files in this game's folder."),
    PlaceRojo: () => t("Rojo keeps your scripts in step, so Genex leaves them to it."),
    LiveData: () =>
      t(
        "Studio can reach this game's live saved data, so play tests here read and write what real players saved. To test without it, turn this off in Studio:",
      ),
  },
  Open: {
    Opening: () => t("Opening Roblox Studio."),
    AlreadyOpen: () => t("Roblox Studio is already open."),
    NotInstalled: () => t("Roblox Studio isn't on this computer. Press Get Roblox Studio first."),
    OpeningPlace: (name: string) => t("Opening {name} in Roblox Studio.", { name }),
    PlaceAlreadyOpen: (name: string) => t("{name} is already open in Roblox Studio.", { name }),
    NotSaved: (name: string) =>
      t(
        "{name} was never saved to a file, so Genex can't open it. Open it in Roblox Studio, or choose another place.",
        { name },
      ),
  },
  Quit: {
    Quitting: () => t("Roblox Studio closed. It asked to save anything unsaved first."),
    NotRunning: () => t("Roblox Studio isn't open."),
    StillOpen: () =>
      t("Roblox Studio is still open. If it asked to save your place, answer it, then press Quit Studio again."),
    InUse: (title: string) => t("A build of {title} is using Roblox Studio, so Genex leaves it open.", { title }),
  },
  Places: {
    BadFile: (file: string) =>
      file
        ? t("{file} isn't a Roblox place file (.rbxl or .rbxlx) on this computer.", { file })
        : t("Choose a place first."),
    NotPlace: (file: string) => t("There's no place file at {file}.", { file }),
    LinkedFile: (file: string) => t("{file} is a link, so Genex leaves it. Choose the place file itself.", { file }),
    NotListed: () => t("That Studio isn't open any more. Choose your place again."),
    /** The agent's `use-project` only: English. */
    NotOpenNamed: (name: string) => `No Roblox Studio has a place named ${JSON.stringify(name)} open.`,
    SameName: (name: string) =>
      t(
        "Two open Studios have a place named {name}, so Genex can't tell them apart. Save one under another name in Studio, then choose it again.",
        { name },
      ),
    NoAnswer: (name: string) =>
      t(
        "Roblox Studio didn't say what {name} is. If a play test or a dialog is open in Studio, finish it, then choose the place again.",
        { name },
      ),
    NoGame: () => t("Open a game first, then choose the place it builds in."),
    Taken: (name: string, title: string) => t("{name} already builds in {title}.", { name, title }),
    ProjectInTheWay: (file: string) =>
      t("{file} in this game's folder is a link or not a file, so Genex leaves it.", { file }),
    /** A save point's reason, kept in the game's history: English. */
    SnapshotReason: "Before linking a Roblox place",
    Linked: (name: string) => t("This game builds in {name} now.", { name }),
    LinkedByName: (name: string) =>
      t(
        "This game builds in {name} now. It isn't saved to a file, so Genex finds it in Studio by its name; save points keep its scripts and parts in this game's folder.",
        { name },
      ),
  },
  Create: {
    /** A new game's title when none is given; its place file is named after it, so English. */
    DefaultTitle: "Roblox game",
    /** A save point's reason, kept in the game's history: English. */
    SnapshotReason: "Before New Roblox game",
    Created: (name: string) => t("Made {name} in this game's folder and opened it in Roblox Studio.", { name }),
    CreatedNotOpened: (name: string, why: string) =>
      t("Made {name} in this game's folder and linked it, but Roblox Studio didn't open: {why}", { name, why }),
    Exists: () => t("This game already builds in a Roblox place. Choose another place from the list instead."),
  },
} as const;
