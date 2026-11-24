# Genex tab inside Unreal Editor: Windows results

Question: does the Mac answer in `RESULTS.md` hold on Windows, where Unreal's web view is
Chromium (CEF) instead of Apple's WebKit?

Short answer: **yes on Unreal 5.9 on Windows.** The Python button appears under the same menu
name. **The widget asset saved by Unreal 5.8 on the Mac opened on Windows 5.9 and loaded the
page** with nothing changed. The browser is Chromium 147, and every tested web feature came back
true. Localhost http and the server push both work, and the page appears well under a second
after the tab opens. As on the Mac, the tab does not come back by itself after a restart. One
difference: a click on the button through Epic's Slate inspector did run the button's Python
command here, which it did not do on the Mac.

Tested on 2026-11-24 on Rab's Windows PC (Windows 11 23H2, AMD Ryzen 7 1700, NVIDIA GTX 1060
6 GB, Direct3D 12) with Unreal 5.9.0 Preview (CL 60738873), the only engine installed there. **Unreal
5.8 is not installed on this PC, so 5.8 on Windows was not tested.** The test project was
`TabProto/TabProto59.uproject` in a fresh clone of this branch. Nothing here ships.

## Answers

**W1. Button from Python only on Windows? Yes, under the same menu name.**
`LevelEditor.LevelEditorToolBar.PlayToolBar` exists and took the button. The other menus match
the Mac exactly: `.User`, `.AssetsToolBar`, `.ModesToolBar` and `LevelEditor.MainMenu.Tools`
exist, and `LevelEditor.LevelEditorToolBar` itself is not found. Adding the button on the first
Slate tick took 6 ms. Epic's Slate inspector sees it as `button "Genex"` at 36×28 px
(`out/windows-editor-5.9-button.png`, the speech-bubble icon right after Play in
`out/windows-editor-5.9-window.png`).

**W2. Dockable tab with the web page, no C++? Yes. Does the asset saved by 5.8 on the Mac open
on Windows 5.9? Yes.** `EUW_GenexTab.uasset`, as committed from the Mac, loaded on Windows 5.9,
still had its WebBrowser, opened as a tab and loaded the page (run `windows-cross-5.9`,
`out/windows-editor-5.9-cross.png`). Unreal did not re-save it: Git shows the file unchanged after
all four runs. When the toolbar button opened the tab without the script setting a URL, the page
loaded from the URL saved in the asset on the Mac (`?run=initial-url-5.8`). As on the Mac, the tab
opens as a floating window the first time. I did not re-create the asset by script on Windows,
because the one shipped asset working everywhere is the goal and it did.

**W3. Browser engine on Windows 5.9.** Chromium through CEF. Full user agent:
`Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) TabProto59/++UE5+Release-5.9-CL-60738873 UnrealEngine/5.9.0-60738873+++UE5+Release-5.9 Chrome/147.0.7727.138 Safari/537.36`.
Chrome version: **147.0.7727.138**. The editor log names the CEF build:
`LogWebBrowser: Loaded CEF3 version 147.0.14.3516 from D:/Epic Games/UE_5.9/Engine/Binaries/ThirdParty/CEF3/Win64/147.0.14+g76d2442+chromium-147.0.7727.138`.
Features that came back false: **none**, on all three runs that probed (`failing: []`). The same
list as on the Mac was true: `:has()`, CSS nesting, container queries, `color-mix()`, `oklch()`,
`backdrop-filter`, `:focus-visible`, View Transitions, WebSocket, EventSource, ReadableStream,
fetch streaming, ResizeObserver, IntersectionObserver, `structuredClone`, `Array.prototype.at`,
top-level await in a module, import maps, subgrid, `dvh`, `navigator.clipboard` present and
working `localStorage`. `devicePixelRatio` was 1, and the page measured 1000×532.

**W4. Does the page reach 127.0.0.1 over http, and does the server push arrive? Yes and yes.**
Every run got the page GET, the POSTs back to `http://127.0.0.1:18431/result`, and the
EventSource push. The push reached the page about 30 ms after the server sent it (sent
11:51:58.165 UTC, the page's report of it arrived at 11:51:58.196). The log has no line about a
blocked request. Windows runs are in `out/page-results-windows.jsonl`. The Mac file
`out/page-results.jsonl` is unchanged.

**W5. How fast, and what the log says.**
- First start of the project (nothing cached): the open call was at 11:51:55.159 UTC and the page
  GET came at 11:51:55.801, so 0.64 s. The page's own load event fired at 594 ms.
- Later starts: 0.17 s from the open call to the page GET, load event at 107 ms (run 2). From the
  button click it was 0.16 s, load event at 164 ms (run 4). The Mac took about 1 second.
- Browser lines in the log, the same on every start: CEF loads when the editor starts, before
  any tab opens:
  `LogWebBrowser: Loaded CEF3 version 147.0.14.3516 from ...` (quoted in W3),
  then `LogCEFBrowser: CEF GPU acceleration enabled`. On quit:
  `LogWebBrowser: Deleting browser for Url=http://127.0.0.1:18431/?run=windows-cross-5.9.`
  There were no CEF, web browser or GPU warnings or errors.
- Something Genex must plan for: on its first start, Unreal 5.9 on Windows started Epic's own MCP
  server by itself:
  `LogModelContextProtocol: Starting MCP server on port 8000 at URL path '/mcp' (override with -ModelContextProtocolPort=N).`
  I turned it off for the next runs in the test project's own settings
  (`bAutoStartServer=False` under `[/Script/ModelContextProtocolEngine.ModelContextProtocolSettings]`
  in `Saved/Config/WindowsEditor/EditorPerProjectUserSettings.ini`). After that it did not start.
- A floating Message Log window opened by itself on every start (visible in the pictures). I did
  not trace why; the prototype does not open it.
- The first start took about 1 minute 40 seconds until the scripts ran (shader compile and asset
  registry scan). Later starts took about 35 seconds. Every run ended with `LogExit: Exiting.` and
  left no crash report.

**W6. Does the tab come back by itself after an editor restart? No, same as the Mac.** After a
run that quit with the tab open, the next start opened no tab, and the page got no request in
60 seconds (`run.tab_open_by_itself: false`, `out/windows-editor-5.9-restart.png`). Unreal again
remembered the widget in the project's settings
(`LoadedUIs=/Game/GenexTabProto/EUW_GenexTab.EUW_GenexTab`). On Windows the tab layout is also
engine-wide, shared by every 5.9 project:
`%LOCALAPPDATA%\UnrealEngine\5.9\Saved\Config\WindowsEditor\EditorLayout.ini`. My scripted quits
did not write it; it was last written on 10 November. So the Mac conclusion holds: the plugin's
`init_unreal.py` should reopen the tab itself.

**W7. Can a real click be proven? Partly, and further than on the Mac.** I ran the Slate
inspector script once.
- **The button:** the inspector's `Click` on `button "Genex"` ran the button's own Python
  command. The log shows `tab.open_requested: button` between the start of the click and its
  return, the tab opened, and the page loaded. On the Mac the same click returned true but the
  command did not run. It is still a click sent through Slate, not a click from the hardware mouse.
- **The mouse pointer:** around each click the log shows Slate switching to its own cursor and
  back (`UsePlatformCursorForCursorUser(false)`, then `(true)`), which suggests the inspector used
  a virtual cursor here. I did not watch the screen, so I cannot say for sure that the real pointer
  stayed still.
- **Typing:** after clicking the page, the inspector typed "hello genex" and pressed Enter. The page
  recorded a single `keydown` with key `Unidentified`, no `input` event, and the text field
  stayed empty. The row list did scroll from row 1 to row 8 (`out/windows-editor-5.9-page.png`),
  so some key or scroll input reached Chromium, but text did not. Typing needs a person.

**W8. Pictures.** All drawn by Unreal itself (Epic's `EditorToolset` `CaptureEditorImage` and the
Slate inspector's `Screenshot`), so nothing else on the desktop is in them:
`out/windows-editor-5.9-cross.png` (the Mac 5.8 asset open as a tab, page loaded),
`out/windows-editor-5.9-tab.png` (opened by the button's command),
`out/windows-editor-5.9-restart.png` (after restart, no tab),
`out/windows-editor-5.9-window.png` (main window with the button),
`out/windows-editor-5.9-button.png` (the button alone),
`out/windows-editor-5.9-page.png` and `out/windows-editor-5.9-tab-full.png` (the page at full
size, 1000×532, after the click and typing).

**W9. What still needs a person.**
- Typing, paste, IME and Enter in the page with the real keyboard (synthetic typing did not
  arrive as text, see W7).
- Focus: whether Unreal's own shortcuts fire while the page has focus, and whether focus comes back
  to the page after clicking elsewhere in the editor.
- Sharpness: the page picture at 1:1 looks clean at `devicePixelRatio` 1, but Windows display
  scaling of 125% or 150% was not tried.
- Docking the floating tab by hand, and whether the docked tab returns after a normal close of the
  editor (the layout file is shared with Rab's other 5.9 projects, so I did not touch it).
- Unreal menus, tooltips and drop-downs over the page. On Windows CEF draws into an Unreal texture
  rather than a native layer as on the Mac, so menus should draw on top, but no one has looked.
- Unreal 5.8 on Windows (not installed on this PC).

## How it was run

- Same files as the Mac test (see `RESULTS.md`). `server/server.mjs` now writes Windows runs to
  `out/page-results-windows.jsonl`. Windows run tags and picture names start with `windows-`; on a
  Mac the names are unchanged.
- Editor runs: `UnrealEditor.exe TabProto59.uproject -ExecutePythonScript=<script> -unattended -nosplash`
  with a log file, in this order: `cross.py` (the Mac 5.8 asset), `create_and_open.py` (finds the
  asset already there, opens the tab from the script and through the button's command),
  `idle.py` (restart) and `inspect_ui.py` (Slate inspector, once). `-unattended` was added so no
  dialog could block a scripted quit.
- Unreal was open about 7 minutes in total, over 4 starts, all on 5.9.
