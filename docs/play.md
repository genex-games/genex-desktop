# Play and the Genex account

Play is genex.games inside the app: its games, tools and assets, the person's Genex account, their
friends, profiles and stats. The sidebar's Play/Create switch opens it; Create is the studio.
What Play sends is in [PRIVACY](../PRIVACY.md#play).

## The account belongs to the app

- Main owns it (`src/main/core/genex-account.ts`): one view the plate, Settings and Publish read
  (signed out, signing in, signed in, or ended), sign-in, cancel and sign-out. It rides on the
  bundled Genex plugin's account: the registry's `appAccount` keeps that account, its credential
  and the account and Publish actions (`GENEX_ACCOUNT_ACTIONS`) while Genex is off, and keeps its
  backend running. Off takes only the agent's tools, MCP servers and skills. Genex can be turned
  off, never removed.
- Sign-in opens genex.games in the browser; two presses open one page, and a cancel while it starts
  wins. When it finishes, Genex turns on unless the person turned it off themselves (the record's
  `turnedOff`).
- Only genex.games refusing the token (a 401 on any account call) ends a sign-in. Offline is never
  signed out: the last account and balance are remembered on this Mac (`studio.genex.me`,
  `studio.genex.credits`); signing out, which Studio asks first, forgets them.
- The sidebar plate: signed out (a quiet generated face, Sign in to Genex), finishing in the
  browser (× cancels), signed in (avatar, name, and beside it the credits opening Credits in
  Create, or in Play the Nex the account may spend (`studio:store.coins`, read as Play opens, as
  the purchase sheet closes and on focus) opening Get Nex; the credits stay while the balance is
  unknown or coin is off; a Pro's name has a PRO tag and their row lights up with their nameplate
  under the pointer), offline (the last account with the offline mark), ended (dimmed, Sign in
  again). Its menu: Profile, Friends, Credits (the Genex plugin page's Credits tab), Nex (Get Nex),
  Nameplate (Pro), Account settings, Sign out.
- The sidebar's friends, signed in, in Play and Create: right under the games, the word Friends
  (the Friends page, with the requests waiting) and each friend in the API's order, their game on
  one green line while they play (no online or offline); a Pro friend's row lights up with their first nameplate under the pointer. A row opens the profile; hovering a friend
  in a game offers Join. About 4½ rows show, then they scroll; the page is read every 20 seconds,
  as genex.games polls. Offline nobody is playing.
- Settings › Genex account: avatar (generated or photo, Regenerate), a Pro's nameplate (New one), name, nickname (`@handle` and
  Edit, once genex.games knows nicknames), credits with Buy credits, Sign out by the title. Signed
  out it is the sign-in stage, with the account-card drawing.
- Publish needs only the account: signed out it asks to sign in. Its "Share its N assets on Play"
  switch (off; shown while some Genex asset is not on Play) shares them when the game goes live. Multiplayer needs the Genex plugin
  on, since the agent builds it with Genex's tools.

## The dashboard

- Games, Tools and Assets, each with tabs and search; Recent once something was played; Top
  creators (the last 30 days) above Games' tabs. The promo card shows until the first sign-in or
  its ×.
- Assets are square tiles under two switchers: kind (All · 3D · Images · Sounds · Videos, a kind
  read from the whole catalog) and Everyone · Mine (the account's library, Saved/Shared tags, signed
  out a sign-in line). A tile with no thumbnail shows the file the library keeps, by what that file
  is (its content type, else its `ext`, else its address's extension): a picture an `<img>` shows,
  loaded as its tile nears the screen, or a model drawn by the Assets tab's viewer. Main reads the
  file (`studio:assets.file`: https on genex.games' asset hosts, no redirects, 32 MiB, one minute)
  and answers a refusal as a code; tiles on screen draw two at a time, and each picture is kept for
  the session. Main also says the file's format (`fbx`, `gltf`), which picks the 3D loader. A file
  that is too large, redirected, refused (a 4xx other than 408 or 429) or unreadable as a model is
  not tried again; one that failed otherwise (a 5xx, a 408 or 429, offline, a timeout, a lost
  graphics context) is tried when its tile is next on screen, 30 s on, three tries in all. Until
  then, and for sounds, the kind's glyph stays.
  Sounds with a known file play on the tile; Use (on hover) adds the asset to one of the person's
  games (`studio:assets.add`). No Remix or plays on assets.
- A card's five-second clip plays while hovered (after a short dwell). The first row of Games' feed
  plays up to four clips by itself, as genex.games' Featured grid does: after its covers and an
  idle moment, staggered, only while half in view and the window shows (none under the viewer);
  out of view for 10 s a clip lets its decoder go. One pause after the tabs stops every clip and is
  remembered; Reduce Motion, a failed clip or a refused play stops them for the session.
- A card's ⋯ (on the cover's corner while hovered or focused, or a right-click on the card) is
  genex.games' card menu (`src/renderer/play/card-menu/`). The game's owner gets Copy link,
  remixing off or on, Change cover, Unpublish and Delete game; an account `/api/me` names
  `isAdmin` also gets, on any game, an Admin block with Mobile support and Edit tags. Anyone else
  gets no ⋯, and neither does a search's card. Featuring stays on genex.games. Its server checks
  every call against its own admin list, so the app only decides what shows
  (`src/shared/play-manage.ts`). A change shows on every card at once. Change cover crops the
  picture to 1536×864 in the renderer and sends it through main (presigned PUT, then commit);
  genex.games may keep the old cover and says why.
- Friends: requests, playing now (Join), friends, sent, people search, the invite card and whether
  friends see the game the account is in. The invite link (`/api/referrals/me`, on the website
  only) opens genex.games' download page with a card from the account; the card has Copy, Post on
  X and, on a Mac, Share… (its share menu). Its credits are the API's `inviterBonus`. Offline it
  shows the page as last read with nobody playing, and every press waits.
- Profiles: the avatar, name, `@handle`, chips, friends and games. The account's own adds Share
  beside the pencil (a popover: the link preview drawn in the app, its avatar body flat as the
  preview draws it, the link, Copy, Post on X, Share…) and a 7-day strip opening Stats (7, 30 or 90 days; tiles, plays per day, every game).
- Nicknames: a handle is the profile's address, `genex.games/@<handle>` (by id while there is
  none). Its shape (3–20 of a–z, 0–9 and inner dashes) is judged as it is typed
  (`src/shared/handle.ts`, genex.games' rules); whether it is free is genex.games' to say. The
  avatar welcome asks for one once while `/api/me` says `handleChosen: false` (a new account, and
  each older one once, whichever of app or site comes first), and never after; a genex.games
  without handles gets the avatar-only welcome once per account on this Mac.
- Generated avatars come from the account's id (`src/shared/avatar-recipe.ts`, the same recipe
  genex.games draws): a WebGPU body with a 2D fallback, eyes and gear in 2D, 25 frames a second,
  at most 28 avatars a frame, still under Reduce Motion, while idle and under a modal. The
  avatar welcome builds the account's under a beam and offers Regenerate beside Continue.
- Pro nameplates: moving art behind a Pro's name (`src/shared/plate-recipe.ts`): 20 abstract
  pieces, each with its own takes and eight shared dials (zoom, speed, warp, mirror, hue, glow,
  grain, colour steps). The first plate is one of the avatar body's pieces in its colours; New one
  rolls any piece (`studio.genex.plateVariant.<id>`, this Mac only). A light theme draws the piece
  on paper (its lightness turned over: a pale ground, deep colour). A sidebar plate is lit only under
  the pointer, never while its menu is open (always in Settings' preview); WebGPU, a 2D still without it, 30
  frames a second only while lit and on screen, held while idle, under a modal or Reduce Motion.

## Playing a game

- A game plays in a sandboxed view (`persist:genex-play`) filling the window below the app's bar, a
  48px strip of its own across the top that never covers the game and never fades, as on the
  genex.games game page. The bar is drawn in a transparent view of its own above the game's
  (`renderer/play-bar.html`, `main/play/bar-layout.ts`): back, the name and facts, Like, Comments,
  Share (its icon), Invite a friend (multiplayer games), Remix, Full screen (its icon, once the game
  plays), Exit. Only full screen gives the game the whole window: the game's own, or the bar's Full
  screen, which asks the game's page for that same full screen; Esc ends it and the bar comes back.
  A held Esc gives the bar the keyboard. The browser's focus ring is hidden on the game's canvas (a
  user-origin rule); the keyboard stays with the game, and the page's other focus rings stay. Only Studio's own page and the bar's may post or delete a comment. A single-use ticket in the address's fragment signs the player in; a guest is offered
  sign-in. The rest of the app is inert until the game closes. Closing the window closes it; another
  window over the studio's, another desktop or minimizing leaves it playing (`view-drop.ts`).
- Comments (the count, or the icon alone) opens a modal over the dimmed game: its count as the
  title, genex.games' comments newest first in pages of 20, a footer pinned under the list (Sign in
  signed out, else the field with Post inside it once something is typed; at most 500 characters).
  The account's own comments can be deleted. Main reads and writes them for the game on screen
  (`main/play/comments.ts`); Esc, ✕ or a click outside closes it and the game gets the keyboard back.
- Paying in coin: a game's purchase (the embed SDK's `buy()` or `requestPayment()`) opens Studio's
  own sheet over the dimmed game in the bar's layer (`main/play/viewer-purchase.ts`,
  `renderer/play/PlayPurchase.tsx`), never genex.games' confirm page. The SDK's popup is made hidden,
  at most one per game and only while the viewer may show a sheet; only the game's own top frame's
  counts, its first move ends it, and it never loads the confirm page. While one lives, Play's session
  cancels any request for a confirm page; with none alive it cancels nothing
  (`main/play/purchase-window.ts`, `purchase-address.ts`). Main reads the purchase as the app's Genex
  account, then the coin balance
  only for a purchase the game may ask for, and shows a sheet only for the game on screen while the
  purchase is open to pay (`main/play/coin.ts`); an ask it drops waits 5 seconds like a Cancel.
  Pay counts once the page has shown Ask for a second with no press in it; a press, a held key or the
  window's focus changing starts that second again. Main confirms the purchase it holds, never one the
  page names, and the game learns how it went from its own SDK. Cancel, Esc, ✕ or a click outside
  cancels it on genex.games, and the next sheet waits 5 seconds; a page that reloads or leaves, or a
  viewer that closes, cancels one still unpaid. Its states: Ask (`× N` above one; a game-priced
  payment's terms whole, in a scroll area), Paying, Paid (the receipt and what is left), Not enough
  coin (Get Nex opens genex.games; once the coin arrives, Review; after genex.games refused Pay for
  want of coin, try again in the game), Sign in (Review once signed in), Pending (genex.games has not
  answered; asked every 2 seconds) and Failed (timed out, canceled, refused or refunded). A purchase
  genex.games still holds open never times out sooner than its two minutes after the game asked, by
  the app's own clock, however far that clock runs ahead. Signing in from the sheet signs the bar in
  too. UNCONFIRMED with genex.games: confirming from Studio on the `native_modal` surface, and
  `/inventory` as Get Nex's page; each is one constant (`STUDIO_CONFIRM_SURFACE`, `playCoinPageUrl`).
  A development profile pointing Studio at another API catches nothing.
- The page stays on Genex games' addresses; a link it opens goes to the browser, at most one every
  few seconds. A coin purchase's popup is the exception above: its confirm address no longer goes to
  the browser.
- Voice chat: a game that asks for a microphone gets the bar's mic switch, remembered per game.
  Main lets the page open the microphone only right after it asked it to, and only on the game's
  own origin.
- Remix clones the game's public source from Genex's git (https only, no hooks or filters; its Git
  LFS files come from the same repository's batch API over https, with no git-lfs needed, and each
  replaces its pointer only once its SHA-256 and size match; a download fails only once it stalls
  for a minute; a failed remix logs why in `studio.log`) into a
  hidden folder; a source with no game in it (no `studio.json`, root page, npm scripts or engine
  project: a creator who never shared its project, `game-source.ts`) makes nothing and says so
  (`PlayRemixRefusal`). Cards and the viewer offer Remix only once main has looked at the source
  (`studio:play.remix-ready`, `remix-ready.ts`: the head commit by `git ls-remote`, its file names by a
  blobless shallow clone, kept by commit in `play-remix-ready.json`). A Mac without Apple's developer
  tools has only a stand-in for Git, which asks to install them; there the app runs its own git
  ([Bundled git](mac-bundled-git.md)), and Remix stays hidden only where no git runs, as in a
  development build without it (`hostGitRuns`, asked once a minute).
  A game reaches Genex with its project only from a Publish that allowed remixing (the dialog's
  Allow remixing, ticked by default; Rights says what remixers may do): Studio stages the files the
  game's git keeps, without history, packages, agent settings, secrets or an engine's caches and
  builds, an Unreal plugin's too, its packaged apps (`Builds/`) included; an engine game whose project
sits in a folder of its own also leaves out `assets/` (its models, already imported) and `docs/proof/`
screenshots (`remix-source.ts`; at most
5 GB and 5,000 files, as genex.games keeps; every model, picture, sound, video and Unreal package, and
any file of 50 MB or more, goes to Git LFS, whose blobs Genex keeps in R2 rather than on the git
server's disk), and the CLI pushes that folder as the source
  (`--source`; a game with only apps sends it with `make-remixable` once they are live). The copy
  goes once its push is over, and a draft carries none. Otherwise, or when the project can't
  go (too big, no repository), the publish turns remixing off on Genex.
  It then installs its packages with npm without running any of their scripts (a stale or
  another manager's lockfile: from package.json), moves it to `<slug>-remix`, adopts it without trusting its settings and builds it
  once, so it opens playing. One remix at a time. Remix (a card's, or the viewer's, which closes
  the viewer) switches to Create at once: a sidebar row with the cover in a ring (the adopted game
  stays off the list until it opens) and, over the workspace, the chat it will have (title, status
  line, a composer that takes nothing yet) beside the stage's loader with the step and a step bar
  (`UiEvent.PlayRemix`, the models with their bytes), fading out when the new game opens. Going
  elsewhere sets it aside and its row brings it back; one finished meanwhile is a toast, and its
  game takes the row. A failure is a toast, and Play comes back for a person still with it. A remix
  keeps its scripts off until a build fails and the person trusts it: the stage's Run setup scripts.

## Native builds

A game made in Unity, Godot or Unreal can carry a Mac app, a Windows program or a Linux one besides
(or instead of) its web build. The app's copy of the contract is `src/shared/play-native.ts`; genex.games does
not serve it yet, and every field is optional, so a server that sends none of it leaves Play as it
is.

- A gallery item (feed, search catalog, a profile's games, `/api/gallery/world/<slug>`) may add
  `builds` (a list of rows), `web` (false when there is no web build; absent means there is one)
  and `engine` (an engine id: `unity`, `godot`, `unreal`). The world item may add `shots` (https
  images on Genex's image hosts, four at most) and `updatedAt`. Multiplayer stays `multiplayer`.
- A build row: `platform` (`mac`, `windows`, `linux`), `arch` (`arm64`, `x64`, `universal` for a
  Mac app), `version` (the author's build id), `sizeBytes` (the archive), `installedBytes`
  (unpacked), `sha256` (hex of the archive), `url`, `entry` (what runs, from the archive's root: a
  `.app` bundle at the root for a Mac, an `.exe` for Windows, a plain path such as `Dust.x86_64` or
  `Dust/Binaries/Linux/Dust-Linux-Shipping` for Linux), optional `minOs` (`13.0`,
  `10.0.19041`; Linux has none to meet: a kernel's release says nothing of a build's C library) and
  `publishedAt`. The archive is a zip; its `url` is https on a build host the app
  trusts (`NATIVE_BUILD_HOSTS`: `cdn.genex.technology` by exact name, so a game's own
  `<slug>.genex.technology` site never hands out an app), with no port or credentials, never
  redirecting elsewhere, and answers `Range`. A row with anything off is dropped, the rest kept.
- The build a computer installs is its platform's for its own processor, else a universal Mac app,
  else, on Apple silicon with Rosetta installed, an Intel-only one, where its `minOs` is met
  (`buildFor`). Games launch on the Mac, on Linux and on Windows. Play names the computer "this Mac" on a Mac and "this
  computer" elsewhere (`nativeHereWords`). When nothing installs, the game page says why in place of
  Install (`whyNotHere`): this system runs no downloaded games (naming where Genex can run it), no
  build for this system, one for a different processor (Apple silicon, Rosetta), or a newer macOS
  needed. A card not installed shows its systems' marks on one plate. A game with no web
  build and no build for this computer is left out of the tabs and search; its maker's profile
  still lists it.
- Installing (`main/play/native-installs.ts`, `studio:play.install`, progress as
  `UiEvent.PlayInstalls`): one install at a time, the rest queued; a free-space check (download,
  unpacked game and 1 GiB); the archive streamed to `installed-games/.downloads/` (resumed by
  range, given up after a minute without a byte), its sha256 checked, its zip directory read before
  anything is unpacked (`native-zip.ts`: no entry or link outside it, nothing written through a
  link, no more than the stated size), unpacked with `ditto --noqtn`, every link resolved inside it,
  its program made runnable (an app packed on Windows carries no execute bit), the app's signature
  (ad hoc is enough) and processor checked (its Mach-O header read in the app, since `lipo` needs
  Apple's developer tools; an Intel-only app on Apple silicon without Rosetta fails as
  `needs-rosetta`), then its bundle id set to
  `games.genex.play.<slug>` and signed again ad hoc, so it can only write its own preferences. A
  Linux build is unpacked by the app itself (`unpackZip`: the same checks, each file no larger than
  its record, execute bits kept, links last) and its `entry` must be a regular file, an ELF program
  for this computer's processor, made runnable; the whole version folder is its app (`entry` `.`). A
  Windows build is unpacked the same way, and its `entry` must be a PE `.exe` for this computer's
  processor (`unpackWindowsBuild`). Each
  game keeps `installed-games/<slug>/<version>/` and `saves/`; `index.json` lists them. Removing a
  game (refused while it runs) keeps its saves; an update keeps the running version until it quits.
- Playing (`main/play/native-launch.ts`): one copy per game, in the game sandbox (`spawnNativeGame`:
  the app read-only, `saves/` its HOME and `CFFIXED_USER_HOME`, its own preference domain, its
  `NSIRD_` atomic-save folder, window, GPU and sound; its only network is its Genex gateway, below).
  Genex finds its window by pid and
  brings it forward (macOS does not). On Linux (`spawnLinuxGame`, `substrate/plugins/linux-game.ts`)
  the game runs in bubblewrap: `/usr`, `/etc` and the library folders read-only, its version folder
  read-only, `saves/` its HOME, a fresh `/tmp`, `/run` and process table, and none of the person's
  files; it gets the X11 socket and cookie or the Wayland socket, `/dev/dri`, NVIDIA's nodes, the
  GPU's `/sys`, the PulseAudio or PipeWire socket and `/dev/input`, and a network namespace of its
  own. Linux has no window list every session shares, so a game counts as on screen once it has
  kept running for three seconds (`native-windows-linux.ts`), and the window manager brings it
  forward. On Windows (`windowsGames`, `substrate/plugins/windows-game.ts`) srt-win can't serve:
  it puts every program on a desktop of its own, with no window on screen. A game runs instead
  through Genex's game host (`windows-game-host.ts`, compiled once with .NET Framework's `csc.exe`
  into `<userData>/game-host/`) in an AppContainer of its own (`Genex.Play.<slug>`, no
  capabilities). It reads its version folder, writes only `saves/` and its scratch folder (each an
  ACL entry for the container's SID, plus a Low integrity label on the write folders), and its
  AppData goes to the container's own folder. It reads none of the person's files and reaches no
  network: an AppContainer reaches no loopback port without an administrator's exemption, so a
  Windows game has no way to Genex yet. It gets the person's desktop, GPU, sound and input. It runs
  in a job killed with the host (also with no other desktops, logging off, clipboard reads or system
  settings); the host ends it when Genex's process or the host's stdin ends, says when its window
  is up (Genex counts it as on screen then), brings that window forward once, and passes Quit on as
  `WM_CLOSE`. A game opens full screen with its engine's own argument
  (`launchArgs`: Unity `-screen-fullscreen 1`, Godot `--fullscreen`, Unreal `-fullscreen`; the
  engine is the catalog's, kept in the install record), unless its app sets `GenexWindowed` in its
  Info.plist (read at unpack, `WINDOWED_KEY`); the page's Quit asks it to quit, then ends its process tree;
  quitting Genex ends every game, and the next start ends a leftover only while it is the same
  process. A web game's Mac app is offered in the viewer's bar (install, progress, play: the viewer
  gives way), and opening a game whose app runs brings the app forward.
- Genex from a native game (`main/play/genex-gateway.ts`).
  - **The gateway.** Each launch opens a gateway on 127.0.0.1: one port for Genex's API, and six for
    relays as answers name them (`relayHostsOf`: `relay[-<region>].<api's domain>`).
  - **The sandbox.** The game's profile allows outbound TCP to those ports only. Seatbelt names no
    host but `localhost`, so the gateway is how "Genex only" is enforced. On Linux the game's own
    network namespace holds only loopback: socat inside listens on the gateway's ports on 127.0.0.1
    and passes each connection through a unix socket to the gateway outside (no socat, no network).
  - **What goes through.** Requests and WebSockets go on to their own Genex host over TLS. Relay
    addresses in JSON answers (relay lists, a seat's `publicAddress`) are rewritten to their local
    port, so the next connection comes back through the gateway. Anything else is refused: a port
    with no host yet, a relay once the ports are full, a request over 1 MB.
  - **What the game is told.** Its environment carries `GENEX_API_URL` (the gateway), `GENEX_GAME`
    (its slug, so a build made before its first publish knows which rooms to join) and, while the
    Genex account is unlocked, `GENEX_EMBED_TICKET`. That is a single-use ticket minted with
    `delivery: "desktop"` (`gallery.ticket`); otherwise the game plays as a guest. Genex signs the
    player in without asking first: its per-game question (App Review 4.7.3) gates only the phone
    app's `native` delivery, and the desktop app ships outside the App Store. Genex's Godot addon
    and Unity package read both (CLI_INTEGRATION §6b).
  - **Failure and shutdown.** A gateway that can't open leaves the game offline, not unplayable. The
    gateway closes when the game ends. A fixture launch opens none.
  - **Its play count** (`main/play/native-plays.ts`). Most native builds never redeem the ticket, so
    once a game counts as running (its window on screen, or a minute up without one) Play reports
    the play itself (`POST /api/embed/native-play`): genex.games counts the signed-in account, or,
    signed out, this computer's own random id (`installed-games/player.json`, sent only with no
    account), once per game, like a web play. A refused token (401) ends the sign-in and the report
    goes again as this computer's, as do later ones while the account still holds that token. A
    game quit before it was running, or a failed report, counts nothing; a failed report is logged.
    A fixture launch reports nothing.
- Links (`main/play/game-links.ts`): the website's Open in Genex sends `genex://game/<slug>`.
  The packaged app declares the scheme (`protocols` in `forge.config.cjs`, the Linux packages'
  `x-scheme-handler/genex`) and registers it at start; macOS hands a link over `open-url`, Windows
  and Linux start Genex with it (`second-instance`, or the first start's arguments). Only that exact
  shape with a Play slug is taken. Main shows the window and keeps the newest link until the page
  takes it once (`studio:play.take-game-link`, announced by `play.game-link`); the page then opens
  the game's own page in Play (`use-game-links.ts`), which shows its own error when the game
  cannot be read. Developer and test launches register nothing.
- Notices: an install finished or failed, and a newer build of an installed game (checked at start
  and every six hours, once per version), are written to the log (`play_install_finished`,
  `play_install_failed`, `play_update_available`); the feed shows them as Play rows that open the
  game's page. Settings › Storage lists installed games with Remove; they are not a "Free up" kind.
- Fixtures: every fixture launch has native games (Dust Runners, Iron Tide, Frigate, Puck Rush,
  Harbor Lights, and SKATE's Mac app) on `builds.genex.invalid`, which never resolves. The
  `native-games` fixture builds their Mac apps on this Mac (Xcode, `dev/fixture-native-app.ts`),
  serves the archives from the profile at a few MB a second, and starts with Frigate installed,
  Puck Rush one version behind, and a Mac build in the library game's `Builds/Mac`, so its Publish
  dialog lists platforms ([Genex publish](plugins.md#first-party-privileges)).
- `studio:play.game` reads a game's own page (`StudioApi.playGame`): its card, likes, comments,
  description, screenshots and when it changed.

## The item store

Games sell items for Nex, Genex's currency, which players buy with real money (the code, the API
and genex.games' routes still call it coin; marketplace plan; `/api/store`, off while `STORE_MODE` is).
An item is a SKU: a name, a description, a picture (maybe a 3D model), a price or Free, and
consumable or durable. A **shared item** is a durable its author lets other games use; a game that
adds one holds an **allowance** for it, and sells it once a live build made after the add is promoted.
Main reads every store answer as hostile input as the app's Genex account (`main/play/store.ts`,
channels `studio:store.*` and `studio:items.*` in `main/ipc/store.ts`, answered for Studio's main
frame only, `STUDIO_UI_ONLY`); prices, shares and counts are genex.games' own, never computed here.

- A game's page has a **Store** section with **Store / My items N** (`play/GameStore.tsx`): cards
  with the render, the name and the price, Free or Owned, a shared item's "N games" badge; My items
  marks each owned item Works here, N left, or dimmed Not in this game. It hides while the store is
  off, unreadable or empty. A card opens the item's sheet (`play/ItemSheet.tsx`): Works in N games,
  the price, Balance X → Y (short: You have X · Y more needed, and, when genex.games holds earned
  coin, "N of your coin is on hold until <date>.") and one button: Pay N runs Play's purchase sheet in the studio window
  (`main/play/store-sheet.ts`, confirmed on `STUDIO_CONFIRM_SURFACE`; `followStudioWindow` makes Pay
  wait again when the window loses or regains focus, and a reload, a dead page or a closed window
  cancels a purchase still unpaid), Get claims a Free item, Get Nex opens genex.games and Review
  follows the coin; ⋯ reports the item (Copy, Doesn't work, Inappropriate, Scam). Drag to turn loads
  the item's GLB only from Genex's asset hosts, the only ones main passes on and the window's
  `connect-src` allows. A profile shows up to five owned items over its stats (`play/ItemShelf.tsx`),
  each with **Get in \<game>** and that game's cover, which opens the game's page; an item that game
  no longer sells (`onSale: false`; absent reads as true) stays, without the button (P21).
  The Store tab is read again when Store or My items is chosen again and when the window comes
  back to the front, a burst of those once (`play/game-store-reads.ts`, `REREAD_GAP_MS`).
- A web game's card opens the viewer, not its page (a web game's page is the game, as on
  genex.games), so the viewer's bar has the **Store** door, after Share, for a game whose Store tab
  has items (`PlayViewerDeps.store`; none while the store is off, empty or unreadable). It opens
  the same `GameStore` in the game's place on the app's own page (`PlayViewerLayer.tsx`), never over
  the game in the bar's layer: main hides the game's view and never closes it, so the game keeps its
  session (a player mid-run loses nothing; an item bought here reaches the game when it reads its
  entitlements again), and the item sheet, its purchase machine and `STUDIO_UI_ONLY` stay the studio
  window's. The keyboard goes to the page; the door again, **Back to game** or Esc closes it and
  gives the game its place and keyboard back (an item sheet's own Esc closes only the sheet,
  `viewerEscape`). While it is open, a game that finishes loading stays hidden, and Full screen and
  Resume do nothing. A native game's card still opens its page, with its Store under it.
- **Create › Items** (sidebar row `[data-sidebar-room="items"]`, `panels/items/`,
  `state/items.ts`) is a room over the workspace, like Plugins. **Browse** lists other creators'
  shared items with a search, read once the typing pauses; the intro and You get per sale name the
  selling game's share genex.games sends (`sellerShareBps`, `panels/items/browse-model.ts`), else the
  design's words; the panel shows Players pay, You get per sale and **Add to \<game> ▾**,
  which offers the account's local games whose Genex publish record names a project: it adds the
  allowance, then opens that game's chat and sends the prompt that has the agent run
  `genex items add <id>` (`panels/items/items-prompts.ts`, `composeInChatWhenOpen`): the agent calls
  `genex__cli-paid` `items add`, and Studio moves the CLI's `genex-items/<id>/` into the game
  ([host tools](plugins.md#first-party-privileges)). An item already in the chosen game (Browse's
  detail names the account's games it was added to) says **Added to \<game>**, with "It shows in the
  game after its next release." until a build made after it goes live (Q5), and **Remove from
  \<game>**, asked first, calls `itemsRemoveFromGame`. **Selling**
  shows Ready to use and On hold for N days, then the account's items (Draft, put on sale; Report
  under review; Off sale, dimmed) with Put on sale, Take off sale, Other games can use it and Ask the
  agent to change it, which leaves words in the item's game's composer; a Free item's price says Free.
  **New item** opens the chosen game's chat, its composer asking "Ask for an item or a change…".
  A tab chosen, the sidebar's Items row pressed again and the window coming back read the tab on
  show again (a burst once, `REREAD_GAP_MS`); Put on sale, Take off sale and sharing read Selling
  again at once, Add to and Remove from the item's detail.
- The **Listing draft card**: when `genex__cli` runs `shop add` (no card asks first) or `genex__cli-paid` runs `shop set` and the pinned
  CLI answers its `--json` draft (`kind: "genex.item_draft"`, version 1) for the game's own hosted
  project, main records `item_drafted` in the chat (`main/core/item-draft.ts`) and announces
  `item.drafted`. The harness may write neither, and a draft an agent writes in words is text. The
  card goes up after the turn's reply, one per item (a newer draft replaces it), with the price,
  **Other games can use it** and **Put on sale** ("or ask for changes below"); its presses call
  `itemSetShared` and `itemPutOnSale` from main, so only the person puts an item on sale. Studio's
  CLI runs never publish (`shop publish` is not in its command table). Put on sale shows only for a
  draft or an item its author took off sale: an item a store that is off put on sale at once (D7)
  says On sale, and `picture_missing` / `picture_invalid` ask the agent to upload the picture. The
  agent's `shop add|set` takes the description, tags, sharing, Free and the game's picture, model
  and package files ([host tools](plugins.md#first-party-privileges)). The card needs CLI 1.36.14
  (`kind`/`version` in `--json`); the pin is 1.36.15.
- **Local drafts** (an item made before its game is on Genex, contract "Local item drafts"): the CLI
  keeps it in the game's `.genex/items/` (`<localId>.json` and a `<localId>/` folder). Studio copies
  those drafts into each `shop` run's folder and carries a `shop add|set|remove`'s change back
  (`main/core/local-item-files.ts`: drafts only, never through a link, capped). Its card (`state:
  "local"`, keyed by local id) says "Draft · goes on sale when you publish" and offers **Sell when
  published**, the person's approval of its `contentHash`, kept in this profile's app data
  (`<userData>/item-approvals.json`, `main/core/item-approvals.ts`), never in the game; pressed it
  says "Will go on sale when you publish", with Undo. An approval names only a hash the CLI printed
  for that draft; a newer draft says "It changed since you approved it." **Other games can use it** on a
  local draft is main's own `shop set <localId> --shared|--no-shared`; the approval follows it only
  when that run changed the very bytes the card showed (Studio's fingerprint of what the run took from
  the game). Once the game's publish record says its publish made it public (`status: "published"`,
  written last: a publish that failed part-way or is still running has none), `main/core/local-items.ts`
  settles the game while one of its chats shows a local card or Studio's record holds a draft not yet uploaded:
  on open, on focus (at most every 15 s, one at a time) and at once when a Genex publish finishes
  (`chat/use-local-items.ts`). It runs Studio's own `shop sync --json` (never
  an agent's; uploaded drafts leave the game), then puts on sale only drafts whose approval equals
  the hash the sync reports (`itemPutOnSale`). The card then becomes the item's: On sale, a draft
  with Put on sale ("…so it stayed a draft." when it changed), or genex.games' refusal; a refused
  upload stays local with its reason. The outcome keeps the hash the sync sent: when it is not the
  draft the card shows (the files were edited outside Studio), the card offers neither Put on sale nor
  sharing and sends the person to Items › Selling, which shows the item as Genex holds it. Nothing in the game folder is read as an approval or a sync
  result, so a `last-sync.json` from a terminal `genex publish` puts nothing on sale (D40).

Fixtures: with `STUDIO_FIXTURE_GENEX_ACCOUNT=1`, `dev/fixture-store.ts` answers the store (Stick &
Steel's store; the account's Snowball items); `--fixture items-store` makes the fixture game the
account's Snowball on Genex and puts Frost Axe's Listing draft card in its chat, and adds `fixture-duty`
(Claude of Duty, not on Genex yet) with Ice Shield's local draft; once its publish record names the
account's `claude-of-duty` as published, the fixture's own sync uploads it to the fixture store (`dev/fixture-items.ts`).
Selectors: the viewer's door `[data-play-bar="store"]` (`aria-pressed` while open), its Store
`[data-play-viewer-store="<slug>"]` with `[data-play-viewer-store-back]`, a page's Store
`[data-game-store="<slug>"]` (`[data-game-store-view="store|my-items"]`, `[data-store-item="<id>"]`),
the sheet's `[data-item-sheet-held]`, the shelf's `[data-shelf-item="<id>"]` / `[data-shelf-get="<slug>"]`;
`[data-sidebar-room="items"]`; `[data-items-page="browse|selling"]` with
`[data-items-tab="<tab>"]`, `[data-items-search]`, `[data-items-browse]`, `[data-items-grid]`,
`[data-items-card="<id>"]`, `[data-items-detail="<id>"]`, `[data-items-add-to="<game>"]`,
`[data-items-added="<game>"]`, `[data-items-remove-from="<game>"]` → `[data-items-remove-confirm="<game>"]`,
`[data-items-choose-game]` (`[data-items-game="<game>"]`), `[data-items-selling]`, `[data-items-held]`,
`[data-items-new]`, `[data-items-row="<id>"]`, `[data-items-status="draft|under-review|off-sale"]`,
`[data-items-put-on-sale="<id>"]`, `[data-items-actions="<id>"]` → `[data-items-action="<action>"]`;
in the chat `[data-listing-draft="<id>"][data-listing-sale="offer|pressing|on-sale|taken-down"]`,
`[data-listing-share="<id>"]`, `[data-listing-put-on-sale="<id>"]`, `[data-listing-on-sale]`; a local draft's
`[data-listing-draft="<localId>"][data-listing-local="offer|approved|changed|removed"]`,
`[data-listing-local-status]`, `[data-listing-sell-when-published="<localId>"]` (`aria-pressed`),
`[data-listing-undo-sell="<localId>"]`, `[data-listing-local-changed]`, `[data-listing-stayed-draft]`.

## Where to work

`src/renderer/play/`, `src/renderer/state/play.ts` and `people.ts`, `src/renderer/avatars/`,
`src/main/play/`, `src/main/core/genex-account.ts`; selectors in the
[feature map](agent/feature-map.md). Fixtures: `STUDIO_FIXTURE_GENEX_ACCOUNT=1|admin|new|quiet|fresh|nickname|terms`
signs a fixture launch in (the full account owns Snowball, and `admin` is it as a genex.games
admin; `new` and `nickname` have not chosen a nickname; a few names, such as `rab`, read as taken),
`ended` gives it a refused one. A fixture launch's stand-in game asks for a coin purchase from a
button per case (`[data-fixture-buy="<case>"]`) or keys 1 to 9 and 0 (`dev/fixture-coin.ts`): every
state of the sheet, on a confirm website that resolves nowhere; the account holds 1,240 coin, and Get
coin adds 1,000. Tests: `tests/conformance/play-*`, `genex-account`, `app-account-plugin`; the
purchase popup in Electron: `npm run test:ui -- play-purchase`.

A live `studio:dev` profile can point Play at a local or test genex.games (a stand) with
`GENEX_DEV_PLAY_API_ORIGIN`, `GENEX_DEV_PLAY_WEB_ORIGIN` and `GENEX_DEV_PLAY_GAMES_ORIGIN` (bare
origins: https, or http on this Mac), plus `GENEX_DEV_PLAY_GAMES_CA` (an absolute PEM path;
`src/main/play/origins.ts` `devStand`). A packaged app, a fixture launch and the normal profile
ignore them. With another API the account signs in on that server's own device sign-in, for the
launch only (`src/main/dev/dev-stand-account.ts`), and `genex__cli` and the Genex plugin's backend
(its publish, and so its asset tools and account page) run against that API with that account
(`launchStand`, `genexPluginAccount`: the registry's `hostAccount` names the API to the backend as
`STUDIO_PLUGIN_API` and hands the stand's token as its lease; its saved genex.games account is
neither read nor written). The games origin counts only with a stand API: the viewer plays
`<scheme>://<slug>.<games host>/`, its pages may hop only to the stand's website, purchases are caught
on that website (`purchaseConfirmOrigin`), and the CA is trusted for those game hosts alone
(`play/dev-games-trust.ts`) and by the Genex plugin's publish, whose backend and CLI runs trust it
beside the system's to push to the stand's source host and check its game host
(`STUDIO_PLUGIN_CA`, `NODE_EXTRA_CA_CERTS`, `GIT_SSL_CAINFO`); that publish tests its draft on the
stand's game host (`STUDIO_PLUGIN_GAMES`, `publish.ts` `stagingLink`). A development launch still takes no `genex://` link, and item pictures and models from hosts other
than Genex's (a local MinIO) still draw the stand-in. Get Nex opens the website's coin page as sign-in
opens its pages (`websitePageOpener`), so a development website's http page opens too. See the
[field guide](STUDIO-DEVELOPER-FIELD-GUIDE.md#run-an-owned-development-profile).

## Asset library and sharing

Every Genex generation is in the account's genex.games library already (`GET /api/generations?scope=library`).
In a game's Assets tab, signed in, cards wear **Saved** or **Shared**; the opened file adds Save
(bookmark) and Share (Play's tint) beside Reveal, and Cmd/Shift-click picks several for a bar (Save,
Share, Clear). Save marks a generation Saved, or sends a file Genex did not make (GLB, PNG/JPEG/WebP,
MP3/WAV/OGG, MP4) to the library through genex.games' import; such a file can be saved but not
shared. Share opens one window (a name per asset, one line of what sharing means), then each card shows
a step line (Send · Check · Live), a bare ✓ On Play, or an orange refusal with Try again or Send a
report; a shared one offers Open on Play and Stop sharing. genex.games keeps one page per asset: a
second share answers the page it has and puts back one taken off Play.

The Assets tab's search answers from the game, My library and Community; Add copies a library asset
into `assets/library/<id>/` and a shared one into `assets/community/<id>/` (a code-only asset into
`src/assets/`). Which generation a saved or added file became is kept in the game's
`.studio/library-links.json` (ignored by git, builds and Publish). The @ panel tags library assets the
same way (copied into `assets/library/`). Signed out, Save and Share are hidden and nothing errs.

Code: `main/play/asset-library.ts` (the calls), `main/core/library-sharing.ts` (a game's files, Save,
Share, Add), `ipc/asset-library.ts` (`studio:assets.*`), `renderer/state/sharing.ts`,
`renderer/panels/assets/`, Play's tiles in `renderer/play/` (`asset-tiles.ts`, `tile-pictures.ts`,
`use-tile-picture.ts`); fixtures answer from `dev/fixture-asset-library.ts` (fixture `asset-library`,
whose window also gets the library's files from the fixture).

