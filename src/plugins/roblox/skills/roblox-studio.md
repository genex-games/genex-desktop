# Building this game in Roblox Studio

This game is built in the person's own Roblox Studio, which stays open and visible; Genex attaches to this game's place through the Roblox Studio connection (its tools fill in which Studio and place, so never pick one yourself).

Scripts are files: write and change the game's code as .luau files under src/<Service>/ in the game folder, named as the luau skill says. Genex's helper keeps them in step with Studio both ways. Never edit a script's Source through execute_luau. Everything else in the place (parts, models, UI, lighting, settings) you read with the connection's read tools and change with execute_luau in Edit.

Build what the person should see into the place, in Edit: the map, its buildings and props, lighting and sky go in as parts and models, not only from scripts at run time, so Studio shows the game before anyone presses Play and its cover can be framed. Scripts make what changes while it plays. For a modern look, give surfaces textures: Genex's texture tool (genex__asset, when the Genex plugin is on) makes tiling ones, and upload-image puts them on the person's Roblox account (a card asks them).

Play-testing: the computer tool plays the game in Studio's own play session as a player would; a Loop's lead may ask a judge for a second opinion on its pictures with judge. Build and play-test through these tools, never by clicking Studio with the desktop tool; use the desktop tool in Studio only for what no tool reaches. Publishing goes through Publish to Roblox and Publish an update.

Ask first: Roblox's AI tools (mesh, texture, material and model generation, its playtest and explore agents), uploads and Creator Store inserts each show the person a card, because they run on the person's Roblox account and moderation penalties land on it. Never ask for Roblox API keys or passwords, never read cookies or sign-in files, never put bots in live servers, and never publish unasked: when the person asks in the chat, first-publish (a place never published, under the game's name) or publish-update (a place already on Roblox) shows them a card; their Publish button hands it over with no card. The turn that answers the "Roblox Studio asks: Publish …" message clicks File › Publish to Roblox itself, as the publish skill says, then calls publish-result; Genex links the game to the published place by itself.

Setup is yours: when Studio is missing, closed or not set up, its MCP server is off or this game has no place, call finish-setup (or that step's own tool: get-studio, setup, restart-studio, open-studio, do-it-for-me), which make this game a new place unless the person named one of theirs (then places and use-project), and never ask the person to click or approve; only signing in to Roblox, macOS's own prompts and Studio's or Roblox's own questions (saving, age, ID, two-step, terms, payment) are theirs.

The person comes first: while they work in Studio, Genex's calls wait. Never close or force-quit Studio. Save points cover the scripts and the place; Rewind brings both back.

Read the matching Roblox skill before that work: luau (code), remotes (anything a client sends), player-data (saving), purchases (Robux), ui-scale (any UI), assets (models, textures, sounds), get-started (Studio not connected or not set up), publish (a turn that publishes).
