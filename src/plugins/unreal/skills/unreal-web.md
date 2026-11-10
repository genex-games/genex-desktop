# A web version of this Unreal game

Players open a web version in a browser with nothing to install. `unreal__package-game` with
`system: "web"` makes it, and the unreal-editor skill's Publishing part says how to call it. This
skill is what the game itself needs changed first, so the build compiles and the browser shows the
game instead of a pink or blurry frame.

Everything below was seen on one real port of a 5.8 shooter, with Unreal 5.9.0 Preview on a Windows
PC. A later Unreal may differ: trust a build's own error over this page, and say what you saw.

## 1. Before the first build

- **Only Unreal 5.9 builds for the web**, and the 5.9 that Epic's launcher installs on a Mac comes
  without the web platform (`unreal__package-game` says so), so the web version is made on a
  Windows PC. Unreal 5.8 can't open an asset 5.9 saved: a game whose Mac or Windows app must keep
  building on 5.8 is never opened or saved with 5.9. With the user's yes, make the web version from
  a copy of the project.
- **Emscripten** must be exactly the version that Unreal names (6.0.10 for 5.9.0 Preview); the
  refusal of `unreal__package-game` gives the user the steps. On a PC with no Python of its own,
  `emsdk.bat` runs the Microsoft Store's stand-in for Python and fails: the same `install` and
  `activate` steps work when Unreal's own Python runs `emsdk.py` in the emsdk folder:

  ```
  "<Unreal>\Engine\Binaries\ThirdParty\Python3\Win64\python.exe" emsdk.py install 6.0.10
  ```
- **Time.** A web package links the game for a long time before it cooks anything: about 25
  minutes on an 8-core PC with 16 GB. Tell the user before you start one.

## 2. Web-only settings

Put every setting the web alone needs in the project's `Config/Wasm/` folder: `WasmEngine.ini`,
`WasmGame.ini`, `WasmDeviceProfiles.ini`, `WasmPakFileRules.ini`. Only a web build reads them, so
the Mac and Windows apps keep their settings and their look. Never change a shared setting,
material or level for the browser's sake without the user's yes. A package reads its settings once
as it starts: change them first, then package.

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
  Genex's `GenexMultiplayer` plugin has no browser build, so a web version can't join a room with
  it. A web game would talk through the page instead (`@genex-ai/multiplayer`'s bridge,
  `window.GenexMultiplayerBridge`), which nobody has built or proven for Unreal. Tell the user
  before you start, and never promise online play in the web version.

## 4. What Unreal 5.9 itself changes

Not the web's doing, but a 5.8 game meets both on its first 5.9 build:

- Cascade, the old particle system, moved to its own module. `Cannot open include file:
  'Particles/ParticleSystemComponent.h'` means Build.cs needs `CascadeRuntime`, added only from 5.9
  so the same file still builds on 5.8:

  ```csharp
  bool bCascadeModule = Target.Version.MajorVersion > 5 || Target.Version.MinorVersion >= 9;
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
- **No Lumen on a Mac.** The desktop renderer runs in no browser there: Chrome on Apple chips gives
  a shader stage 10 storage buffers and it needs 16. A Mac offered desktop drops to forward, the
  plainest of the three. Many web players are on a Mac: light and judge the web version on deferred,
  and tell the user up front that the browser won't show the app's Lumen lighting there.
- **Sharpness and the first click**, in `Config/Wasm/WasmEngine.ini`. Unreal's page draws 1 pixel
  per screen point by default, which is blurry on a Retina Mac; more pixels cost speed, so check
  the frame rate after raising it. Sound and mouse capture need a click in a browser, which
  `StartMode=Click` asks for:

  ```ini
  [/Script/WasmTargetPlatform.WasmTargetSettings]
  MaxDevicePixelRatio=2.0
  StartMode=Click
  ```

- **Where it runs.** The page starts only over https or on localhost, so another computer can't
  test it from this PC's address over http: publish it for that.

## 6. Size

Players download the whole site, so leave out what the web version doesn't show.

- The project's `DirectoriesToAlwaysCook` applies to the web too and brings whole folders in. To
  leave content out for the web alone: a section of the pak file rules with `Platforms="Wasm"` and
  `bExcludeFromPaks=true` (in a chunked build also `bOverrideChunkManifest=true`).
- A start map for the web alone is `GameDefaultMap=` under `[/Script/EngineSettings.GameMapsSettings]`
  in `Config/Wasm/WasmEngine.ini`. Code that offers maps by name checks first that the map is in
  the build (`FPackageName::DoesPackageExist`).
- Textures: a `[Wasm DeviceProfile]` section in `Config/Wasm/WasmDeviceProfiles.ini` with a
  `+TextureLODGroups=(Group=TEXTUREGROUP_World,…,MaxLODSize=2048,…)` line per group took one site
  from 2.7 GB to 1.5 GB.
