# Game workspace

This folder is a game made in Genex. `index.html` at its root is the game: Genex serves it in its
Live view beside the chat, so never start a server for the person to open. The page's import map
serves three.js r185 (`three`, `three/addons/`) from Genex's own copy at `/vendor/`, not from this
folder: import it, a 2D canvas, the DOM or anything else the game calls for, and build its menus
and HUD however it looks best.

In a Loop build, read `.studio/BRIEF.md` first when it exists: it is that build's contract, and
`docs/CONTRACT.md` holds the reference tables it points at.
