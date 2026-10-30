# Game workspace

This folder is a game made in Genex. `index.html` at its root is the game: Genex serves it in the
Live view beside the chat, so no server is needed. The page loads `src/main.js`.

Genex serves three.js r185 from its own copy at `/vendor/`; the page's import map names it
(`three`, `three/addons/`, `three/webgpu`, `three/tsl`) for a game that wants it. Every file here
is the game's to change.
