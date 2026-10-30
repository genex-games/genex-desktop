# Game workspace

This folder is a game made in Genex. `index.html` at its root is the game: Genex serves it in the
Live view beside the chat, so no server is needed. The page loads `src/main.js`.

Genex checks a build by loading the page once with `?genex-shot=1` on its address and keeping a
screenshot of it as the build's picture. A page may read that parameter; one that ignores it loses
nothing.

Genex serves three.js r185 from its own copy at `/vendor/`; the page's import map names it
(`three`, `three/addons/`, `three/webgpu`, `three/tsl`) for a game that wants it. Every file here
is the game's to change.
