# Publish to Roblox

Use this in the turn that answers "Roblox Studio asks: Publish …". That turn holds Genex's
computer control over Roblox Studio for this task only: it clicks Studio's own publish dialog,
because no Studio or plugin API publishes a place and Genex never asks for Roblox API keys. The
person asked for this publish (they pressed Publish, or approved a card); don't ask them again.
This turn does the clicking itself with the desktop tool: never call `first-publish`,
`publish-update` or `do-it-for-me` here. The person watches a publishing card while you work: end
the turn with `publish-result` (below), so the card shows how it ended.

## Rules

- **Only what the task says.** Publish this game's place, under the name the task gives for a
  first publish, and give it its cover (below). Never change privacy (a new game stays as private as Studio makes it), never make
  the game public, never touch Robux, prices, game passes, ads or age settings, never buy anything
  and never open the Roblox player.
- **Keep Studio's own choices.** Leave the creator, genre, devices and every other setting as
  Studio fills them in; leave the description empty.
- **Stop for the person only for what is theirs**, and click nothing more then: an age check, an ID
  check, a two-step or verification code, terms to accept, a payment, a sign-in, or a question about
  saving their work. Say exactly what it asks and where (and in `publish-result`); they answer it,
  then ask again.
- **Everything else is yours to get past.** A dialog you don't recognise: read it (screenshot, zoom)
  and take the choice that keeps the place and its settings as they are (Cancel, Close, OK on a
  notice); a click that answered an error: take a fresh screenshot and try once more; a window that
  is behind another: `bring_to_front` it. Try at least two different ways before you report that a
  step failed, and say what you tried.
- **Studio's own state is yours to handle, never the person's chore.** If the Roblox Studio
  connection says Studio isn't open for this game, call `open-studio` and wait (up to two minutes,
  reading `get_studio_state` every few seconds) until the place is open. If Studio shows "not
  responding" or says it is busy, wait: it is saving or loading; never click a choice that closes or
  restarts it while you publish (closing it once all is done is the last step, below). Genex ends a
  play test and brings Studio back to its editor before handing you the publish. Read Studio's mode
  only from the
  Roblox Studio connection's `get_studio_state` ("Current Studio Mode: Edit" is editing): a
  NetworkClient in Explorer (a place edited from Roblox has one while editing) and the Test tab's red
  Stop button don't mean a test runs. If a test really runs, end it yourself with Studio's Stop
  (Shift+F5 with Studio in front, or the Test tab's Stop button) and go on. Wait while Studio opens or reloads the place (its window title
  names the place once it is ready), and close what Studio itself puts in the way: a tip, a "what's
  new" note, the Start Page, a panel over the menu bar, and the "Auto Recovery File Found" question
  after a crash (click **Ignore**: Studio keeps the recovery file in its AutoSaves folder).
- **Real pointer clicks with Studio in front.** Studio's menus report their items as disabled to
  accessibility and its dialogs have no accessibility actions: bring the window of this game's
  place to the front (its title names the place), then click with the pointer and type into the
  focused field. Look at the screen after each step.
- **Several Studio windows open: pick this game's by its title.** A Mac runs one Studio per open
  place, so a plain `bring_to_front` raises whichever is in front already. Give the place's name or
  its file name as `window`: `bring_to_front` with `text` `com.Roblox.RobloxStudio` and `window`
  `spinning-colored-block`, say (a Mac only: on Windows leave `window` out, and name Studio's program
  `RobloxStudioBeta.exe`, never a guess such as `robloxstudio.exe`). A `window` no title holds is
  answered with the titles Studio's windows show: pick this game's from them and raise it again.
  Check the title in the screenshot before you click anything. Bringing a window forward is never
  the person's step: never ask them to switch windows, and never stop for it.

## A first publish (a new game)

1. In Studio's menu bar, click **File**, then **Publish to Roblox**.
2. If the dialog asks where to publish, choose to **create a new experience** (never an existing
   one: that would overwrite another game).
3. In **Name**, replace whatever is there with the exact name the task gives.
4. Leave **Description** empty and every other field as it is.
5. Click **Create** (or **Publish**). Wait until the dialog closes and Studio reloads the place from
   Roblox (its window title names the place again; that can be Roblox's place name, not the game's).
   If the dialog shows **Save failed** with a **Retry** button, Roblox's server dropped the request:
   wait ten seconds and click **Retry** (Studio sends the same publish again; it creates no second
   game). Do that up to three times; only a fourth **Save failed** is a stop (below).
6. Call `publish-result` with `published: true`, and say nothing yet: a reply without a tool call
   ends the turn, and the cover and the tidy-up still come. Genex links this game to the published
   place by itself; don't press anything in Genex's panel for it.
7. Give the game its cover (below), then close what you opened (at the end).

## An update

Studio publishes an update of a published place without a dialog (at most a brief notice that is
easy to miss), so Roblox's own record of the place is the proof, read through the Roblox Studio
connection's `execute_luau`:
`return game:GetService("MarketplaceService"):GetProductInfo(game.PlaceId).Updated`.

1. Read that time once before you publish.
2. In Studio's menu bar, click **File**, then **Publish to Roblox**.
3. If Studio asks to confirm, confirm the publish; anything else is a stop (rules above).
4. Read the time again every few seconds for up to half a minute. Once it is later than the first
   one, the update is on Roblox: call `publish-result` with `published: true` (say nothing yet). If
   it hasn't changed, call `publish-result` with `published: false` and what you saw: that
   time moves only when Studio saves, so Genex also reads Studio's own log of the publish, and its
   answer says whether the update went through. Go by that answer, and never click Publish twice.
5. If the game still has Roblox's default icon (its Creator Hub **Icon** page shows none of its
   own; look at that page unless this chat set the cover already), give the game its cover (below);
   leave a cover it already has.
6. Close what you opened (at the end), whether or not the game needed a cover.

## The game's cover

Roblox shows a grey placeholder until a game has its own icon and thumbnail, and Studio's publish
sets neither. Only the game's Creator Hub page takes them now (Studio's Game Settings no longer
have them, and no API does without the person's keys), in the browser where the person is signed in
to Roblox.

1. Frame Studio's viewport on the game's most telling view: move Studio's camera there (a short
   script setting `workspace.CurrentCamera.CFrame` through the Roblox Studio connection), with
   nothing selected and no panel over the view. The picture must show the game's world (its map,
   its rooms, its players' space), never only sky or an empty baseplate.
2. Call `cover-pictures`. Look at the icon and the thumbnail it answers; if they don't show the game
   well, frame a better view and call it again.
3. Read the game's ids through the Roblox Studio connection (`return game.GameId, game.PlaceId`) and
   open `https://create.roblox.com/dashboard/creations/experiences/<GameId>/places/<PlaceId>/icon`
   in the person's own browser window, with pointer clicks and typing (never `web_open`: its
   separate, clean browser is signed in to nothing, so Creator Hub only asks for a sign-in there).
   Genex asks the person for that app on a card when you first use it, in this
   turn, whatever an earlier turn was told, so use it rather than handing them the steps. Studio is
   in front now, often over the whole screen: bring the browser forward with the desktop tool's
   `bring_to_front` (`msedge.exe` on Windows unless the person's browser is another, its bundle id on
   a Mac), or click a visible part of its window, and take a screenshot. The taskbar and Dock are
   never driven, and Alt+Tab only lands back in Studio. Type the address only once the browser is in
   front, never into Studio (its viewport takes letters as camera keys). If no browser is running
   (`bring_to_front` says it is not running), open the page with the desktop tool's `open_page` (it
   opens the address in the person's default browser and brings it forward), then take a
   screenshot. A sign-in page there is the person's (rules above); the game stays published either way.
4. On **Icon**, upload the icon and save. On **Thumbnails** (in the page's sidebar), add the
   thumbnail, tick it **Active** and save. In each file dialog, go to the folder the answer gave
   first (⌘⇧G on a Mac, the file name field on Windows: paste the folder, never a file's path, and
   press Return), then click the picture by its name (`icon.png`, `thumbnail.png`) and open it.
5. Keep for your last line that the cover is set (Roblox reviews new pictures before it shows them,
   so the game page keeps its placeholder a while). If Creator Hub refuses a picture or asks anything else,
   stop (rules above) and say what it showed; the game stays published either way.
6. Close what you opened (below).

## When it is done: close what you opened

Once the publish went through and the cover is set or left (or the update needed none), leave the
screen as tidy as you found it, then end the turn. Skip this when you stop for the person: what
they must answer stays open in front of them.

1. **The browser.** Close every tab you opened for Creator Hub: with the browser in front and that
   tab showing (its address is on create.roblox.com), press ⌘W on a Mac or Ctrl+W on Windows, then
   take a screenshot. Never close a tab the person had before. If you started the browser yourself
   with `open_page` and now none of the person's tabs are left, quit it (⌘Q, or Alt+F4 on Windows);
   a browser that was already running stays running.
2. **Roblox Studio.** Close this game's Studio window, whoever opened it (you, Genex or the build):
   the person asked for that. Bring it to the front by its title (`window`, rules above), then on a
   Mac press ⌘Q (a Mac runs one Studio per place, so that quits this place only); on Windows press
   Alt+F4 with its window in front. Leave every other place's Studio window open.
   The place is on Roblox now, so if Studio asks to save it or to commit drafts, take the choice
   that keeps the work (**Save**, **Commit**), never **Don't Save**. Wait until the window is gone
   and take a screenshot. Never force-quit Studio; if it is still saving, wait.
3. Look that it is gone (`bring_to_front` with its `window` now finds no such window).
4. Only now end the turn, with one message to the person: published (under which name), the cover
   set or left, and what you closed. After a first publish, add that only they can open the game for
   now: Roblox keeps a new game private and without an age rating, so its link shows "not
   accessible" to anyone else until they answer Roblox's questions about its content and make it
   public in Creator Hub, which their publishing card opens. Those are theirs; never do them. That
   message is the turn's last word. Genex then closes this
   game's Studio if it is still open and comes back to the front by itself; never click in Genex.

## If it fails or stops

First try to get past it yourself (rules above). Only when it is the person's, or two different
tries failed, call `publish-result` with `published: false` and a `detail` naming what Studio or
Roblox showed (in its own words), what you tried, and what the person answers there; say the same in
the chat, and stop. Never publish from another Studio window or into another place than this game's.
