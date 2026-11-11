# A web version of this Unreal game

Players open a web version in a browser with nothing to install. `unreal__package-game` with
`system: "web"` makes it, and the unreal-editor skill's Publishing part says how to call it. This
skill is what the game itself needs changed first, so the build compiles and the browser shows the
game instead of a pink frame.

Everything below comes from one real port of a 5.8 game, with Unreal 5.9.0 Preview on a Windows PC;
where that port did not check a point, the line says so. A later Unreal may differ: trust a build's
own error over this page, and say what you saw.

## 1. Before the first build

- **Unreal builds for the web from 5.9**, and today the 5.9 that Epic's launcher installs on a Mac
  comes without the web platform (`unreal__package-game` says so), so for now a web version is made
  on a Windows PC. The call builds with the Unreal the game's project names: a game still on 5.8 is
  refused until the user moves it (Move to 5.9, on the Unreal panel's Engine row). Unreal 5.8 can't
  open an asset 5.9 saved, so when the user wants the game itself to stay on 5.8, say so before
  they move it and offer a copy of the game that they move instead. Never open or save a 5.8
  project with 5.9 yourself.
- **Emscripten** must be exactly the version that Unreal names (6.0.10 for 5.9.0 Preview), in an
  emsdk folder the user installs: the refusal of `unreal__package-game` gives the steps to pass on.
  On a PC with no Python of its own, `emsdk.bat` runs the Microsoft Store's stand-in for Python and
  fails. Then give the user these two lines to run in the emsdk folder instead, with the version the
  refusal names:

  ```
  "<Unreal>\Engine\Binaries\ThirdParty\Python3\Win64\python.exe" emsdk.py install 6.0.10
  "<Unreal>\Engine\Binaries\ThirdParty\Python3\Win64\python.exe" emsdk.py activate 6.0.10
  ```
- **Time.** A web package's link step alone took about 25 minutes on an 8-core PC with 16 GB. Tell
  the user before you start one.

## 2. Web-only settings

Put every setting the web alone needs in the project's `Config/Wasm/` folder: `WasmEngine.ini`,
`WasmGame.ini`, `WasmDeviceProfiles.ini`, `WasmPakFileRules.ini`. Only a web build reads them, so
the Mac and Windows apps keep their settings and their look. Never change a shared setting,
material or level for the browser's sake without the user's yes. A package reads its settings once
as it starts: change them first, then package.

Genex writes a few settings itself before a web package, each only where the project doesn't set
it: the isolation headers, the click to start and Retina sharpness under
`[/Script/WasmTargetPlatform.WasmTargetSettings]` in `Config/DefaultEngine.ini`, and the split of
the content into files in `Config/Wasm/WasmGame.ini`. Leave them, and change one only the way
`unreal__package-game`'s description says.

## 3. What a browser can't run

- **Sockets.** A browser game opens none, so Unreal's online plugins don't build for the web. In
  the .uproject, give `OnlineSubsystemUtils` and `OnlineSubsystemNull` (and any other the game turns
  on) `"PlatformDenyList": ["Wasm"]`, and leave their modules out of Build.cs on the web:

  ```csharp
  bool bWeb = Target.Platform.ToString() == "Wasm";
  if (!bWeb) PublicDependencyModuleNames.AddRange(new string[] { "OnlineSubsystem", "OnlineSubsystemUtils" });
  PublicDefinitions.Add(bWeb ? "MYGAME_WEB=1" : "MYGAME_WEB=0");
  ```

  The platform is compared by name and the game makes its own define because 5.8 has no
  `UnrealTargetPlatform.Wasm` and never defines `PLATFORM_WASM`. Put code the web can't have inside
  `#if !MYGAME_WEB`.
- **Video.** A browser build has no media player, so an mp4 (a menu's background video) never
  plays. Unreal stages `Content/Movies` by itself; only this keeps a file out, in
  `Config/Wasm/WasmGame.ini` (the file's name without its extension):

  ```ini
  [/Script/UnrealEd.ProjectPackagingSettings]
  +MovieDenyList=Intro
  ```

  Give the menu something else to show there, such as a live camera on the level.
- **Post-process materials with custom HLSL** can fail to translate for the two mobile renderers.
  Unreal then draws pink over the whole frame, and the browser's console says `Using a stub pixel
  shader (entry MainPS): its WGSL translation failed at cook time`, then the cause (seen: `no
  matching function for call to 'SceneTextureLookup'`). On the web, when
  `GetWorld()->GetFeatureLevel()` is `ERHIFeatureLevel::ES3_1`, clear the property that holds the
  material before it reaches the camera's `PostProcessSettings.WeightedBlendables`. Not loading it
  in C++ is not enough: a Blueprint's saved default still names it.
- **Online play is not there yet.** The Colyseus library the Mac and Windows apps link through
  Genex's `GenexMultiplayer` plugin has no browser build, and the plugin's modules are for Mac,
  Windows and Linux only, so a web version can't join a room with it. A web game would talk through
  the page instead (`@genex-ai/multiplayer`'s bridge, `window.GenexMultiplayerBridge`), which nobody
  has built or proven for Unreal. Tell the user before you start, and never promise online play in
  the web version. A game that already has the plugin needs it kept out of the web build the way
  the online plugins are (its module out of Build.cs, its calls inside `#if !MYGAME_WEB`); nobody
  has built such a game for the web yet, so expect more to turn up.

## 4. What Unreal 5.9 itself changes

Not the web's doing, but a 5.8 game meets both on its first 5.9 build:

- Cascade, the old particle system, moved to its own module. `Cannot open include file:
  'Particles/ParticleSystemComponent.h'` means Build.cs needs `CascadeRuntime`, added only from 5.9
  so the same file still builds on 5.8:

  ```csharp
  bool bCascadeModule = Target.Version.MajorVersion > 5
      || (Target.Version.MajorVersion == 5 && Target.Version.MinorVersion >= 9);
  if (bCascadeModule) PublicDependencyModuleNames.Add("CascadeRuntime");
  ```
- The three `BP_MovementMode_*` Blueprints of Epic's Game Animation Sample no longer compile
  ("Sim Context pin" in the log). A game that doesn't use them can leave them: they only leave
  errors in the editor's log, and the web build doesn't need them.

## 5. How it looks in a browser

- **Three renderers, picked by Unreal's page.** `forward` (mobile forward, always built),
  `deferred` (mobile deferred, built by default) and `desktop` (with Lumen, experimental, off by
  default: `bTargetDesktopTier`); `wasm-tiers.json` in `web/` lists the ones built. Phones, tablets
  and Firefox get forward; other browsers run a short speed test and get deferred or forward by it,
  or desktop when the build has it and the graphics card allows. The pick is kept in the browser and
  reused. Add `?tier=forward`, `?tier=deferred` or `?tier=desktop` to the link to force one for a
  visit: do that whenever you compare looks, or two visits show two renderers.
- **No Lumen in a Mac's browser.** The desktop renderer runs in no browser there: Chrome on Apple
  chips gives a shader stage 10 storage buffers and it needs 16. With desktop built, a Mac the page
  offers it ends on forward, the plainest of the three, so leave `bTargetDesktopTier` off unless the
  user asks for Lumen on PCs. Judge the web version on deferred and on forward, and tell the user up
  front that a Mac's browser won't show the app's Lumen lighting.
- **Sharpness and the first click are Genex's settings.** Unreal's page draws 1 pixel per screen
  point by default, which is blurry on a Retina Mac, so a web package sets
  `MaxDevicePixelRatio=2.0`; a browser gives a page sound and the mouse only after a click, so it
  sets `StartMode=Click`. Drawing at 2.0 is four times the pixels, and the port never measured what
  that costs: check the frame rate on a Retina screen before you tell the user it is sharp and
  smooth, and lower the value when the game is too heavy for it.
- **Where it runs.** The page starts only over https or on localhost, so another computer can't
  test it from this PC's address over http: ask the user to publish it for that.

## 6. Size

A smaller site loads sooner, and `unreal__package-status` says when a finished web build is past
what Genex's hosting usually takes: make it smaller and package again before Publish. Leave out what
the web version doesn't show.

- The project's `DirectoriesToAlwaysCook` applies to the web too and brings whole folders in. To
  leave content out for the web alone: a section of the pak file rules with `Platforms="Wasm"`,
  `bExcludeFromPaks=true` and `bOverrideChunkManifest=true` (Genex's web builds come in chunks,
  where the rule works only with it).
- A start map for the web alone is `GameDefaultMap=` under `[/Script/EngineSettings.GameMapsSettings]`
  in `Config/Wasm/WasmEngine.ini`. Code that offers maps by name checks first that the map is in
  the build (`FPackageName::DoesPackageExist`).
- Textures: a `[Wasm DeviceProfile]` section in `Config/Wasm/WasmDeviceProfiles.ini` with a
  `+TextureLODGroups=(Group=TEXTUREGROUP_World,...,MaxLODSize=2048,...)` line per group took one
  site from 2.7 GB to 1.5 GB.
