# Genex tab inside Unreal Editor: prototype results

Question: can Genex put a toolbar button and a dockable web tab inside Unreal Editor with
scripts and content assets only, without a compiled C++ module?

Short answer: **yes on Unreal 5.8 and 5.9 on a Mac.** Python adds the button. A script makes
an Editor Utility Widget asset holding a full-size WebBrowser. The asset opens as an editor tab
that loads a page from `http://127.0.0.1`, and the same asset (saved by 5.8) works on 5.9. Two
things need more work: a custom Genex icon needs C++ (or an existing editor icon), and the tab
does not come back by itself after a restart, so the plugin should reopen it.

Tested on 2026-11-24 on this Mac (Apple Silicon) with Unreal 5.8.4 (CL 58902052) and 5.9.0
(CL 60738873), in a new empty project made for this test (`TabProto/`). Nothing here ships.

## Answers

**Q1. Button from Python only? Yes, on 5.8 and 5.9.**
`unreal.ToolMenus.get().extend_menu("LevelEditor.LevelEditorToolBar.PlayToolBar")`, then
`add_section`, a `ToolMenuEntry` of type `TOOL_BAR_BUTTON` with a Python string command, and
`refresh_all_widgets()`. It puts the button right after Play/Pause/Stop/Launch (see
`out/editor-5.8-window.png`, the speech-bubble icon). On both versions these menus exist:
`LevelEditor.LevelEditorToolBar.PlayToolBar`, `.User`, `.AssetsToolBar`, `.ModesToolBar` and
`LevelEditor.MainMenu.Tools`. `LevelEditor.LevelEditorToolBar` itself is not found. Epic's
Slate inspector sees it in the editor's widget tree as `button "Genex"` at 36×28 px in the
level editor toolbar. The button must be added again on every editor start: menu extensions
made from Python live in memory only. Adding it from `init_unreal.py` on the first Slate tick
took under 1 ms, every time.

**Q2. Custom Genex icon without C++? Partly.** An existing editor icon works:
`entry.set_icon("EditorStyle", "Icons.Comment")` shows Unreal's comment bubble
(`out/editor-5.8-button.png`). A PNG or SVG of our own cannot be used from Python. A toolbar
icon is a Slate style name (`ScriptSlateIcon` = style set + style name), and Python cannot
register a new Slate style set. I listed every `unreal.*` name with style, brush, icon or slate
in it on 5.8; none registers one (`SlateBrushAsset` and `SlateBrush` are for UMG widgets, not
toolbar icons). A text-only button is not a way out either: the toolbar showed the icon alone,
and the label "Genex" appears only as the button's accessible name. For our own icon, the smallest C++
is one editor module of about 30 lines that registers an `FSlateStyleSet` with one
`FSlateVectorImageBrush` pointing at the plugin's `Resources/Genex.svg`. Python then uses that
style name. The indirect routes without C++ were tried on 2026-11-25: one shows our image but
makes Unreal crash on every quit, so the answer stands (see "Own image on the button" below).

**Q3. Dockable tab with a web page without C++? Yes.** The asset is an Editor Utility Widget
Blueprint whose only widget is a WebBrowser. A script makes it in two steps:
1. `AssetTools.create_asset(..., EditorUtilityWidgetBlueprint, EditorUtilityWidgetBlueprintFactory)`
   with `parent_class = EditorUtilityWidget`.
2. Adding the WebBrowser, which works differently per version:
   - Plain Python on the widget tree (route a) fails on both: `widget_tree` and `root_widget`
     are not reachable ("Failed to find property 'widget_tree'", "...'root_widget'"). A widget
     made with `new_object` stays an orphan and later trips an ensure
     ("Widget [ProbeRouteA] was added but did not get a GUID").
   - **5.9:** `unreal.WidgetBlueprintEditorSubsystem.create_and_add_widget(bp, unreal.WebBrowser, "GenexBrowser")`
     works from plain Python (route b1). No toolset plugin is needed.
   - **5.8:** that subsystem does not exist. Epic's `UMGToolSet` plugin (it ships with 5.8 but
     is off by default) has `AddWidget`, called from Python through
     `unreal.ToolsetRegistry.execute_tool("UMGToolSet.UMGToolSet", "AddWidget", json)` with
     `widgetBlueprint`, `widgetClass` and `widgetDisplayName` (route b2). The project must
     enable `UMGToolSet` (an `"Optional": true` entry in the .uproject did not load it).

   Then `set_editor_property("initial_url", ...)`, `BlueprintEditorLibrary.compile_blueprint`
   and `EditorAssetLibrary.save_asset`. `EditorUtilitySubsystem.spawn_and_register_tab(bp)`
   opens it, and the WebBrowser inside the open instance is reachable as
   `widget.get_editor_property("GenexBrowser")`. Calling `load_url()` on it works, so the asset
   can ship with any URL and Genex sets its real port when it opens the tab. The tab opens as a
   floating window the first time (`out/editor-5.8-tab.png`, `out/editor-5.9-own.png`). It is a
   normal nomad tab that a person can dock, but there is no Python call to place it docked.

**Q4. Browser engine inside Unreal, and features that came back false.** On a Mac it is not
Chromium. Unreal's WebBrowser uses Apple's WebKit there (log category `LogAppleWebBrowser`,
drawn as a native layer). User agent on 5.8:
`Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) TabProto/++UE5+Release-5.8-CL-58902052 UnrealEngine/5.8.4-58902052+++UE5+Release-5.8`.
5.9 gives the same with `UnrealEngine/5.9.0-60738873`. There is no Chrome version in it.
Windows and Linux use Unreal's bundled Chromium (CEF), which this Mac test does not cover.
Features that came back false: **none, on either version.** All of these were true: `:has()`,
CSS nesting, container queries, `color-mix()`, `oklch()`, `backdrop-filter`, `:focus-visible`,
View Transitions, WebSocket, EventSource, ReadableStream, fetch streaming, ResizeObserver,
IntersectionObserver, `structuredClone`, `Array.prototype.at`, top-level await in a module,
import maps, subgrid, `dvh`, `navigator.clipboard` present, and working `localStorage`.
`devicePixelRatio` was 2. The page measured 1000×574 (5.8) and 1000×538 (5.9).

**Q5. Does the page reach 127.0.0.1 over http, and does a server push arrive? Yes and yes.**
GET of the page, POSTs back to `http://127.0.0.1:18431/result`, and an EventSource push from the
server all arrived on every run (`out/page-results.jsonl`, runs `create-5.8`, `cross-5.9` and
`create-own-5.9`). No mixed-content or local-network prompt appeared.

**Q6. Does the tab come back by itself after a restart? No, on both versions.** After a run that
quit with the tab open, the next start opened no tab, and the page got no request in 60 seconds
(`run.tab_open_by_itself: false` on 5.8 and 5.9; `out/editor-5.8-restart.png`). Unreal did
remember the widget: `EditorPerProjectUserSettings.ini` has
`LoadedUIs=/Game/GenexTabProto/EUW_GenexTab.EUW_GenexTab`, so its tab can be registered at start.
But the docked layout was never written. Two reasons, from the engine source:
- The tab layout is saved when the main window is closed by hand (`CloseRootWindowOverride`).
  A scripted quit (`quit_editor`, which runs `QUIT_EDITOR`) skips that save.
- On a Mac the layout file is engine-wide (`~/Library/Application Support/Epic/UnrealEngine/5.8/Saved/Config/MacEditor/EditorLayout.ini`),
  shared by every project of that engine version. My runs did not change it; it was last written
  on Nov 10.

So a person closing Unreal normally may get the tab back. The test could not check that without
touching the shared layout of Rab's other projects. The robust design: the plugin's
`init_unreal.py` remembers whether the Genex tab was open and calls `spawn_and_register_tab` at
start.

**Q7. One asset for 5.8 and 5.9? Yes.** The asset saved by 5.8 (`EUW_GenexTab.uasset`) loaded on
5.9, kept its WebBrowser, opened as a tab and loaded the page (run `cross-5.9`). 5.9 did not
re-save it. The reverse will not work: an asset saved by 5.9 cannot open in 5.8. So the shipped
asset should be made with the oldest supported engine.

**Q8. What looked wrong or slow.**
- The page appears about 1 second after the tab opens: the tab spawned at 11:33:25 UTC, the
  page GET came at 11:33:26.4 UTC, and the page's own load event fired at 90 ms. 5.9 matched.
- Each time the tab opens, the log says
  `LogAppleWebBrowser: Error: takeSnapshotWithConfiguration errored with NSError 1!`
  followed by
  `LogAppleWebBrowser: Display: The native layer was not created for SAppleWebBrowserWidget ... creating...`.
  The page still renders. Because the Mac web view is a native layer over the editor, check
  whether Unreal menus and tooltips draw over it or under it.
- Every 5.8 run that ran the full test ended with exit code 1, with or without the tab. The 5.9
  runs ended with 0. I did not trace why.
- `-ExecutePythonScript` closes the editor the tick after the script returns, unless the script
  calls `unreal.EditorPythonScripting.set_keep_python_script_alive(True)`.
- Saving or compiling an asset inside a Slate tick callback runs that callback again from the
  inside ("generator already executing"). The plugin needs a re-entry guard.
- The first start of the new project on 5.8 took 5 minutes 12 seconds (shader compile and asset
  registry scan). Later starts took 15–20 seconds. 5.9's first start took about 1 minute.
- No CEF, GPU or Metal warnings came from the browser.

**Q9. What still needs a person or screen control.**
- A real click on the toolbar button. Epic's Slate inspector found it (`button "Genex"`) and its
  `Click` returned true, but the Python command did not run. The likely reason: the click came
  from inside a running Python callback, so the nested Python command did not run. Running the
  button's command string directly does open the tab. The inspector's clicks also move the real
  mouse pointer, so I stopped using it while the Mac was in use.
- Typing, paste, focus, blur and wheel inside the page: done on the Mac on 2026-11-25 with the
  real keyboard through screen control, see "Typing test" below.
- Sharpness of the 13 px text: `devicePixelRatio` is 2. The editor's own pictures here are
  scaled down, so they cannot judge sharpness.
- Docking the floating tab by hand, and whether the docked tab returns after a normal close.
- Windows and Linux (CEF instead of WebKit): this whole check needs repeating there. Windows
  5.9 is done: see `RESULTS-windows.md`. Linux is still open.

## How it was run

- `server/server.mjs` serves `server/page.html` on 127.0.0.1:18431 and appends every page POST
  to `out/page-results.jsonl`.
- `TabProto/TabProto.uproject` (5.8) and `TabProto/TabProto59.uproject` (5.9, no `UMGToolSet`)
  share one Content folder and the test plugin `TabProto/Plugins/GenexTabProto` (Python only).
- Editor runs: `UnrealEditor <uproject> -ExecutePythonScript=<script>`, with scripts in
  `scripts/`: `create_and_open.py`, `idle.py` (restart), `inspect_ui.py` (Slate inspector),
  `cross.py` (5.9 on the 5.8 asset) and `create_own.py` (5.9 makes its own asset).
- Pictures come from Epic's `EditorToolset` `CaptureEditorImage` and the Slate inspector's
  `Screenshot`. Both draw only the editor's own windows. A plain `screencapture` showed other
  apps on top of the editor, so it was not used.
- Unreal was open about 15 minutes in total, over 10 starts (7 on 5.8, 3 on 5.9).

## Typing test

Tested on 2026-11-25 on this Mac with Unreal 5.9.0 (CL 60738873), run `typing-5.9`. Someone typed
into the page with the real keyboard through screen control while my editor held the tab open.
`scripts/hold_for_typing.py` opens the tab, sizes its floating window to 900×700 points and
brings it to the front through Epic's Slate inspector (`Windows` list/resize/select; the
inspector counts screen pixels, so 1800×1400 on this Retina screen). The page now posts every
`keydown` (key and code), every `input` (field and value) and every `paste` (text) at once
(`server/page.html`); `scripts/summarize_typing.mjs` turns the log into a timeline.

**Typed text arrives as real text, with nothing doubled or lost.** 63 keydowns and 61 inputs,
each letter once and in order. Final values:
- text input: `Hello from Unreal 5.9, typing works!genex done`
- textarea: `SecoPasted line: привет, Genex 123nd field. `

**Paste works,** Cyrillic included: one `paste` event with `Pasted line: привет, Genex 123`,
inserted as `insertFromPaste`. It landed 670 ms after the ⌘ key went down, in the middle of the
next typed word ("Seco…nd field"), so a paste can arrive after keys typed later. The `v` of ⌘V
never reached the page as a keydown; only `Meta` did.

**Focus and blur arrive** (9 focus, 8 blur), including when focus moved from the input to the
textarea and when the window lost focus. The very first click gave focus, blur 65 ms later, and
focus again a second later. **Wheel events arrive** (20).

**Odd things.**
- `event.code` is wrong: every printable key reported `KeyA` (only ⌘ reported `MetaLeft`).
  `event.key` is right. Page code must use `key`, never `code`.
- ⌘A did not select all: the page saw `Meta` and then `a` as a plain keydown with no text, and the
  next typed words were appended to the existing text instead of replacing it.
- No key reached an Unreal shortcut: the editor log shows no command during the typing.
- The floating tab window shows the editor's own title ("TabProto59 - Unreal Editor") for its
  first seconds, then "EUW Genex Tab". A Message Log window also opens by itself on every start,
  as on Windows.
- Epic's MCP server started on port 8000 on the Mac too (`LogHttpListener ... Port 8000`).

## Own image on the button

Question: can the toolbar button show our own image (a PNG or SVG in the plugin) without any
compiled C++ module? Stand-in image: `Resources/Icons/genex-logo-test.png`, a 64×64 orange
square with a teal square inside (`scripts/make_test_icon.mjs`).

**Answer: no route is shippable without C++.** One route does show our image on 5.8 and 5.9, but
Epic's code behind it crashes Unreal every time the editor quits. The other routes cannot reach a
toolbar button at all.

**The route that shows the image: Epic's User Toolbox plugin (`UserToolBoxCore`).** It ships with
5.8 and 5.9 (Experimental, prebuilt for Mac). At start it registers a Slate style set named
`UserToolBoxStyle`, and for every `IconsTracker` data asset it finds, it adds one image brush per
`.png` in the folders the asset lists, named `<prefix><file name>`. A content-only plugin can ship
that asset. What I did (`scripts/own_icon.py`):
1. The test plugin depends on `UserToolBoxCore`.
2. Python makes `/GenexTabProto/GenexIcons`, an `IconsTracker` with prefix `Genex.` and one folder
   entry `(FolderPath=(Path="Resources/Icons"),PrefixId="",IconSize=(X=20,Y=20))`. Python has no
   `unreal.IconsTracker`, so the class is loaded by path (`/Script/UserToolBoxCore.IconsTracker`)
   and made with Epic's `IconTrackerFactory`. The folder struct's fields are not exposed to
   Python, so its text form is imported (`IconFolderInfo().import_text(...)`). The console `set`
   command was refused ("Set commands not allowed in the editor"). The asset was saved by 5.8.
3. A second toolbar button uses `set_icon("UserToolBoxStyle", "Genex.genex-logo-test")`.

Evidence, all drawn by Unreal's Slate inspector: the button with our image on 5.8
(`out/editor-5.8-own-icon-only-load-button1.png`) and on 5.9 loading the same 5.8 asset
(`out/editor-5.9-own-icon-only-load-button1.png`); the same button before the asset had a folder,
empty (`out/editor-5.9-own-icon-no-brush-button.png`). The inspector lists it as
`button "Genex own icon"` right after `button "Genex"` in the play toolbar.

**Why it cannot ship: Unreal crashes on every quit once one such brush exists,** on 5.8 and 5.9.
The crash reports show `FSlateStyleSet::~FSlateStyleSet()` called from UserToolBoxCore's static
style pointer at process exit. Cause, from the engine source: `FUserToolBoxStyle::AddExternalImageBrushes`
keeps each brush in a `TUniquePtr` map and also hands the same pointer to the style set, and a
style set deletes every brush that is not backed by a UObject, so the brush is freed twice. A run
with User Toolbox enabled but no brush quit cleanly (exit 0). Making or saving the asset while the
editor runs also crashed at once (SIGBUS in Slate's render batching) on 5.8 and 5.9, after its
reload of all textures. A person would see Unreal's crash reporter each time they close the
editor, so this route is out unless Epic fixes it.

**Routes that do not work, with the reason from the engine source:**
- Plugin `Resources/Icon128.png`: only the Plugins browser reads it, as a one-off dynamic brush
  (`SPluginTile.cpp`); it never becomes a named style.
- Class icons or thumbnails for a shipped asset or Blueprint class: `FSlateIconFinder` only looks
  up `ClassIcon.<Class>` in style sets that already exist; nothing registers one from data.
  Thumbnails are rendered textures, not style names.
- `EditorUtilityToolMenuEntry` assets and `ToolMenuEntryScript` subclasses: their icon is a
  `FScriptSlateIcon` (style set + name) and `GetIcon` returns the same type, so they need a
  registered style just like Python does. Neither can host a widget.
- A widget entry holding a UMG or Editor Utility widget with an image: toolbar widget entries
  exist only in C++ (`FToolMenuEntry::InitWidget`); Python's `ToolMenuEntry` has no widget slot.
- Slate theme or style files in Config or Content/Slate: Unreal's themes are colour-only JSON;
  nothing loads image brushes from config. `SlateBrushAsset` and `SlateWidgetStyleAsset` are for
  UMG; registering them as a style set needs `FSlateGameResources::New` from C++.
- Scriptable Tools (`ScriptableToolsEditorMode`): a tool's `ToolIconTexture` becomes a clean,
  texture-backed brush in `ScriptableToolsEditorModeStyle`, but only when a person enters the
  Scriptable Tools mode. 5.9 can enter a mode from script (EditorToolset `SetEditorMode`); 5.8 has
  no script call for it that I found. Not tried in the editor.
- `SlateScripting` (`UICommandsScriptingSubsystem`) registers new commands but cannot run
  existing ones or add brushes.

**The smallest compiled module.** One editor module, for example `GenexEditorStyle`, in the Genex
plugin:
- `GenexEditorStyle.Build.cs` depending on `Core`, `SlateCore`, `Projects`.
- `StartupModule()`: make `FSlateStyleSet("GenexStyle")`, set its content root to the plugin's
  `Resources`, add `Genex.Logo` as an `FSlateVectorImageBrush` of `Genex.svg` at 20×20, and call
  `FSlateStyleRegistry::RegisterSlateStyle`. `ShutdownModule()`: unregister and release it. About
  30 lines. Python then calls `set_icon("GenexStyle", "Genex.Logo")`.
- The `.uplugin` lists it as `{"Name": "GenexEditorStyle", "Type": "Editor", "LoadingPhase": "PostEngineInit"}`.
- Shipped prebuilt per engine minor version, because a binary only loads in the engine build
  whose BuildId is in its `UnrealEditor.modules`: for each of 5.8 and 5.9, run
  `RunUAT BuildPlugin -Plugin=… -Package=…` on a Mac (Xcode; a universal arm64 + x86_64 dylib
  in `Binaries/Mac`), on Windows (Visual Studio; `Binaries/Win64/UnrealEditor-GenexEditorStyle.dll`)
  and for Linux (Epic's cross toolchain; `Binaries/Linux/libUnrealEditor-GenexEditorStyle.so`).
  That is six binaries.
- An engine built from source has another BuildId, and Unreal would then offer to rebuild the
  module. So the compiled part should live in its own small plugin that Genex installs only for a
  Launcher engine whose BuildId it has, while the Python button falls back to an editor icon
  everywhere else.

Unreal was open about 4½ minutes for this part, over 7 starts (5 on 5.9, 2 on 5.8). The typing
test kept it open about 7 minutes over 2 starts on 5.9. The test plugin now depends on
`UserToolBoxCore` and holds the `GenexIcons` asset, so every editor start of this test project
ends with the quit crash above; remove both to go back to clean quits.
