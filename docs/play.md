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
  browser (× cancels), signed in (avatar, name, Pro, credits opening Credits), offline (the last
  account with the offline mark), ended (dimmed, Sign in again). Its menu: Profile, Friends, Credits (the
  Genex plugin page's Credits tab), Account settings, Sign out.
- The sidebar's friends, signed in, in Play and Create: right under the games, the word Friends
  (the Friends page, with the requests waiting) and each friend in the API's order, their game on
  one green line while they play (no online or offline). A row opens the profile; hovering a friend
  in a game offers Join. About 4½ rows show, then they scroll; the page is read every 20 seconds,
  as genex.games polls. Offline nobody is playing.
- Settings › Genex account: avatar (generated or photo, Regenerate), name, nickname (`@handle` and
  Edit, once genex.games knows nicknames), credits with Buy credits, Sign out by the title. Signed
  out it is the sign-in stage, with the account-card drawing.
- Publish needs only the account: signed out it asks to sign in. Multiplayer needs the Genex plugin
  on, since the agent builds it with Genex's tools.

## The dashboard

- Games, Tools and Assets, each with tabs and search; Recent once something was played; Top
  creators (the last 30 days) above Games' tabs. The promo card shows until the first sign-in or
  its ×.
- A card's five-second clip plays while hovered (after a short dwell). The first row of Games' feed
  plays up to four clips by itself, as genex.games' Featured grid does: after its covers and an
  idle moment, staggered, only while half in view and the window shows (none under the viewer);
  out of view for 10 s a clip lets its decoder go. One pause after the tabs stops every clip and is
  remembered; Reduce Motion, a failed clip or a refused play stops them for the session.
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
  at most 28 avatars a frame, still under Reduce Motion, while idle and under a modal.

## Playing a game

- A game plays full window in a sandboxed view (`persist:genex-play`) under the app's header: Like,
  Share, Invite, Remix, Exit; a held Esc gives the header the keyboard. A single-use ticket in the
  address's fragment signs the player in; a guest is offered sign-in. The rest of the app is inert
  until the game closes.
- The page stays on Genex games' addresses; a link it opens goes to the browser, at most one every
  few seconds.
- Voice chat: a game that asks for a microphone gets the header's mic switch, remembered per game.
  Main lets the page open the microphone only right after it asked it to, and only on the game's
  own origin.
- Remix clones the game's public source from Genex's git (https only, no hooks or filters, its Git
  LFS files from the same repository; a download fails only once it stalls for a minute) into a
  hidden folder, installs its packages with npm without running any of their scripts (a stale or
  another manager's lockfile: from package.json), moves it to `<slug>-remix`, adopts it without trusting its settings and builds it
  once, so it opens playing. One remix at a time. Remix (a card's, or the viewer's, which closes
  the viewer) switches to Create at once: a sidebar row with the cover in a ring (the adopted game
  stays off the list until it opens) and, over the workspace, the chat it will have (title, status
  line, a composer that takes nothing yet) beside the stage's loader with the step and a step bar
  (`UiEvent.PlayRemix`, the models with their bytes), fading out when the new game opens. Going
  elsewhere sets it aside and its row brings it back; one finished meanwhile is a toast, and its
  game takes the row. A failure is a toast, and Play comes back for a person still with it. A remix
  keeps its scripts off until a build fails and the person trusts it: the stage's Run setup scripts.

## Where to work

`src/renderer/play/`, `src/renderer/state/play.ts` and `people.ts`, `src/renderer/avatars/`,
`src/main/play/`, `src/main/core/genex-account.ts`; selectors in the
[feature map](agent/feature-map.md). Fixtures: `STUDIO_FIXTURE_GENEX_ACCOUNT=1|new|quiet|fresh|nickname|terms`
signs a fixture launch in (`new` and `nickname` have not chosen a nickname; a few names, such as
`rab`, read as taken), `ended` gives it a refused one. Tests: `tests/conformance/play-*`,
`genex-account`, `app-account-plugin`.

A live `studio:dev` profile can point Play at a local or test genex.games with
`GENEX_DEV_PLAY_API_ORIGIN` and `GENEX_DEV_PLAY_WEB_ORIGIN` (bare origins: https, or http on this
Mac; `src/main/play/origins.ts`). A packaged app or a fixture launch ignores them. With another
API the account signs in on that server's own device sign-in, for the launch only
(`src/main/dev/dev-stand-account.ts`); Publish, the Genex plugin, games' pages and their
pictures stay on genex.games.
