# Get Roblox Studio connected

Use this when the Roblox Studio tools are missing from this chat, when a call answers that Roblox
Studio isn't open for this game, or when the person asks to set Roblox up. It gets the game to a
working connection and stops there. Once the tools answer, go back to what the person asked for.

Adapted for Genex from the `roblox-get-started` skill in Roblox's roblox-studio-agent-plugin (MIT
licence, notice at the end). In Genex the setup is yours: every press of the **Roblox Studio**
panel is also a tool of this plugin (`roblox__<name>`), and you call them yourself.

## Rules

- **You set it up, with this plugin's tools.** Never tell the person to press a button, approve a
  step or click through Studio for something a tool below does. `finish-setup` does whichever
  step Genex can do now; call it again once a step it started has finished. Getting Studio,
  setting it up and restarting it ask the person nothing. Don't download or install Studio, copy
  plugins or edit Studio's settings files yourself with commands: the tools do that safely.
- **What stays the person's:** signing in to Roblox (never ask for, read or type their password,
  and never read cookies, tokens or Studio's sign-in files), macOS's own prompts (such as letting
  Genex use the Documents folder), and Studio's or Roblox's own questions: saving their place, an
  age check, ID, a two-step code, terms or a payment. Say exactly which one and where.
- **Never close or force-quit Studio unasked.** `restart-studio` and `quit-studio` use Studio's
  normal quit, which asks the person to save first; `restart-studio` only to set Studio up, and
  `quit-studio` asks the person on a card.
- **Switches only Studio's window offers** are clicked by `do-it-for-me`, which posts the click as
  "Roblox Studio asks: …" to this chat, for the turn that answers that message, with Genex's
  computer control (Genex asks once on a card when computer control is off). That turn clicks it
  itself with the desktop tool and never calls `do-it-for-me` again; any other turn ends once it
  has started. Never drive Studio with the desktop tool for anything else.
- If a step fails, say which step and what you saw, then check the table below.

## 1. Read where Studio stands

`show-steps` shows the person the setup card, ticked live; the Roblox Studio button shows the same
state. You are told when every step on it is done, so the chat goes on by itself. `finish-setup`
picks each state's tool for you; each state has its own too:

| State | What it means | What you call |
| --- | --- | --- |
| Not installed | Studio isn't on this computer | `get-studio`: Genex downloads it from Roblox, checks Roblox signed it, installs and sets it up, and makes a game with no place its new one. The person signs in when Studio opens |
| Set up | Studio is there; the helper or the MCP server isn't | `setup` with Studio closed, or `restart-studio` while it is open |
| Not open | Everything is set up; Studio isn't running | `open-studio`, which opens this game's place |
| Starting | Studio is open; Genex is waiting for it to answer | Wait a moment and retry; if it stays so, `do-it-for-me` (the MCP switch is off) |
| Ready | Studio is open and answering | Nothing; the tools work |

The Roblox Studio plugin must be turned on in Plugins first; it is off until the person turns it on.

## 2. Sign in

The first time, Studio asks the person to sign in. That is their step alone. While `get-studio` is
under way, Genex waits for that sign-in, then closes Studio itself, sets it up and opens the game's
place: call no other setup tool meanwhile. If Studio closes after a sign-in some other time, call
`open-studio` again.

## 3. The MCP server switch

Genex turns Studio's MCP server on during `setup` while Studio is closed. If Studio was open, or
the switch is still off, call `do-it-for-me`: it clicks **Assistant** (the toolbar icon at the top
right of Studio, shown only with a place open) › **⋯** › **Settings** › **MCP Servers** › **Enable
Studio as MCP server**. Where Genex can't click (no computer control here, or the person said no),
`restart-studio` turns it on while Studio is closed instead. Only when it answers that Studio has
no settings file yet is that one click the person's: tell them the path above.

The switch is kept per Roblox account: after signing in with another account it may need turning on
again.

## 4. The place

Each game in Genex uses one place. A game with no place gets a new one: `new-game` (or
`finish-setup`, `get-studio`) writes a Baseplate in the game's folder and opens it in Studio. Only
when the person names a place of theirs, or Genex lost the game's place, link one: `places` lists
the places open in Studio and the files Studio opened lately, and `use-project` links this game to
one by its label or its file's full path. Switch a linked game to another place only when the
person asks. When several could be the person's, ask them which by its name before linking. A
place builds in one game only: one another game uses is refused. A place file in Documents that
Studio didn't open lately is linked by its label once it is open in Studio, since macOS asks the
person before Genex reads that folder.

## 5. Check

Call a read tool of the Roblox Studio connection (`get_studio_state` or `search_game_tree`). An
answer means you are connected: say so in one line and get on with the request. Studio also has
its own guides behind its `skill` tool (debugging, the device emulator, its documentation); read
them for Roblox-specific questions.

## Troubleshooting

Match the symptom, do the single fix yourself (the person's only for what is theirs: the rules
above), then check again from step 1.

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| No Roblox Studio tools in this chat | The plugin is off, or the game holds no Roblox place yet | The person turns the plugin on in Plugins; then `places` and `use-project`, or `new-game` |
| A call answers that Roblox Studio isn't open for this game | Studio is closed, another place is open, or the MCP server is off | `open-studio`; then step 3 if it still doesn't answer |
| Studio is open, but the button stays on Starting | No place is open, or the MCP switch is off | `open-studio` for this game's place; `do-it-for-me` for the switch (step 3) |
| The switch was on, now it's off | The person signed in with another Roblox account | `do-it-for-me` again for this account |
| Studio is installed, but the panel can't find its MCP server | Studio is out of date | Ask the person to update Studio, then `open-studio` |
| The connection fails right after the switch is turned on | Another app uses Studio's MCP port (13469) | Ask the person to close the other app, then `restart-studio` |
| Calls go to the wrong place | Several Studios are open | `places`, then `use-project` with this game's place |
| A Studio tool named in Roblox's docs is missing | Studio's tools differ by version | Use the tools that are there; suggest updating Studio |
| A dialog in Studio blocks every call | Studio is waiting for the person | Ask the person to answer it; never answer a Studio dialog for them, not even in Do it for me, which clicks only its own task's path |

If nothing matches, say which step failed and what you saw. Leave the person's places and files as
they are, and don't install other tools or MCP servers to work around it.

## Licence of the original

The original skill is from https://github.com/Roblox/roblox-studio-agent-plugin
(`skills/roblox-get-started`, plugin version 0.2.1), used under this licence:

MIT License

Copyright (c) 2026 Roblox Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
