# Luau in this game

How the game's code is written. The scripts live as `.luau` files in the game folder; Genex's
helper keeps them in step with the open place in Roblox Studio, so edit the files, never a script's
`Source` through `execute_luau`.

## Files and where code runs

Each file maps to one script in the place, by its path and its name (the same names Rojo and
Roblox's Script Sync use):

| File | In the place |
| --- | --- |
| `src/ServerScriptService/Round.server.luau` | Script `Round` in ServerScriptService (runs on the server) |
| `src/StarterPlayer/StarterPlayerScripts/Input.client.luau` | LocalScript `Input` (runs on each player's device) |
| `src/ReplicatedStorage/Shared/Inventory.luau` | ModuleScript `Inventory` (runs wherever it is required) |
| `src/ServerScriptService/Combat/init.server.luau` | Script `Combat` whose children are the other files in `Combat/` |

- Folders are Folders; a script with children is a folder holding an `init.*.luau` file.
- One script per file and one file per script. Don't create two files that differ only in letter
  case: Windows and macOS treat them as one.
- A character a file name can't hold is written `%XX` (a name ending in a dot is `Name%2E.luau`);
  keep the names Genex wrote as they are.
- When a script changed in Studio and in its file at once, Studio's version is kept in both and the
  file's goes to `.genex/conflicts/`: look there before redoing that work.
- Scripts Studio's Script Sync keeps, and every script of a game with the person's own Rojo
  project (`default.project.json`), are kept in step by that tool, not Genex: edit the files where
  that project puts them.
- Server-only code and modules go in ServerScriptService or ServerStorage. Code in
  ReplicatedStorage, StarterPlayer, StarterGui and Workspace is copied to every player's device,
  where a cheater can read it: never put secrets, admin lists or reward logic there.
- Client code goes in StarterPlayerScripts (runs once per player) or StarterCharacterScripts
  (runs again with each new character). UI scripts sit beside their ScreenGui in StarterGui.

## Every file

- Start every new file with `--!strict`. Keep an existing file's mode unless asked; when you raise
  one to strict, fix every error it reports.
- Get services once at the top: `local Players = game:GetService("Players")`. Use `workspace`,
  never `game.Workspace` or a service found by name.
- A ModuleScript returns one table or one function, and nothing else. Export its types with
  `export type`.
- No globals: no `_G`, no `shared`, no implicit globals. Everything is `local`.
- Names: PascalCase for modules, types, classes and instances; camelCase for locals, functions and
  methods; SCREAMING_SNAKE_CASE for constants at the top of the module.
- Keep files short and single-purpose; split a file past about 400 lines by what it owns.

## Types

- Type every function's parameters and return. Give tables a named type
  (`type Item = { id: string, count: number }`) instead of passing loose tables around.
- Avoid `any`. Cast with `::` only at a boundary where the type is known by other means (a value
  just checked with `typeof`, a `FindFirstChild` result checked with `IsA`).
- Values from a remote, a DataStore or an attribute are untrusted: type them `unknown` and narrow
  them with checks (see the `remotes` skill), never with a cast.
- Prefer `if x == nil then return end` guard clauses over deep nesting.

## The engine's rules

- Scheduling: `task.wait`, `task.spawn`, `task.defer`, `task.delay`. Never `wait`, `spawn` or
  `delay`: they are deprecated and throttled.
- Create, set properties, then parent last: `local part = Instance.new("Part")` … `part.Parent = folder`.
  Never pass the parent to `Instance.new`.
- Events over polling: `RunService.Heartbeat:Connect(function(dt) … end)` with its `dt`,
  `GetPropertyChangedSignal`, `ChildAdded`, `CollectionService:GetInstanceAddedSignal`. Never a
  `while true do task.wait() end` loop to watch a value.
- Keep every connection you make outside an instance's own lifetime and `Disconnect` it when its
  owner goes (`Players.PlayerRemoving`, a round's end). `Destroy` what you create when it is done.
- Clients wait for replicated things with `WaitForChild` (with a timeout for anything optional).
  The server never waits for what it creates itself.
- Find things by tag (`CollectionService`) or attribute (`GetAttribute`), not long name paths.
- Wrap every call that can fail or yield across the network in `pcall`: DataStores,
  `MarketplaceService`, `TeleportService`, `HttpService`, `Players:GetUserIdFromNameAsync`.
- Animations load through the `Animator` (`humanoid:FindFirstChildOfClass("Animator")`), never
  `Humanoid:LoadAnimation`. Movement uses constraints (`LinearVelocity`, `AlignPosition`,
  `AlignOrientation`), never the legacy body movers.
- No `loadstring`, `getfenv`, `setfenv` or `require(<asset id>)`: they turn off Luau's
  optimizations, and `require` by id runs code someone else can change.
- Per-frame work stays small: no `Instance.new` or table churn in `Heartbeat`, cache what you look
  up, and stop work for things nobody can see.

## Checks

Write code that passes `luau-lsp analyze` in strict mode with Roblox's API types, selene's
`roblox` standard library, and StyLua's style (the game's `stylua.toml`: tabs, 120 columns, double
quotes). Fix a warning rather than silencing it; a `-- selene: allow(...)` comment names its reason.

Run `check-scripts` after changing scripts: it checks the files changed since they last passed
(`all: true` checks every file) and answers each problem at its file and line. Fix every error and
warning, then run it again. Genex runs the same checks at each worker's end, and errors hold a
build's finish back. When it answers that the Luau checks aren't added, the person adds them with
Add Luau checks in the Roblox Studio panel; until then, read your changes over against this page.
