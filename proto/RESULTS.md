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
style name.

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
- Typing, paste, focus, blur and wheel inside the page: the page logs them, but nothing typed
  into it in these runs (0 event batches posted).
- Sharpness of the 13 px text: `devicePixelRatio` is 2. The editor's own pictures here are
  scaled down, so they cannot judge sharpness.
- Docking the floating tab by hand, and whether the docked tab returns after a normal close.
- Windows and Linux (CEF instead of WebKit): this whole check needs repeating there.

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
