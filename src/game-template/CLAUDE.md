# Game workspace

This folder is a game made in Genex. `index.html` at its root is the game: Genex serves it in its
Live view beside the chat, so never start a server for the person to open. `three` and
`three/addons/` load offline through the page's import map; use them, a 2D canvas, the DOM or
anything else the game calls for, and build its menus and HUD however it looks best.

In a Loop build, read `.studio/BRIEF.md` first when it exists: it is that build's contract, and
`docs/CONTRACT.md` holds the reference tables it points at.
