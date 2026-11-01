# The Genex cover

The Genex cover is the 16:9 picture genex.games shows for this game: its gallery card, its page and every shared link. It is not Studio's own sidebar look (set_game_cover). Every game on Genex has one, and it is a picture of the game itself, with no text added over it. Studio asks for it as a step of its own once a build lands in the game folder; the person may also ask for another.

PICTURE: make it of the real game by any means (a screenshot of it running, a render from its own scene), save it inside the game's folder, and pass its path: genex__cover {"image":"<path in the game folder>"}. It is a PNG or JPEG of at least 1280×720 and at most 8 MB. Genex stores covers at 1280×720, shows a 16:9 picture whole and crops any other shape to its middle 16:9. Genex refuses a picture too dark to read on a card (mean brightness under 0.11, or over 85% near-black) or one flat colour (contrast under 0.04); the answer's advice says when that is likely.

CLIP (optional): a WebM or MP4 of at least 5.3 seconds of the game playing, at most 8 MB, passed beside the picture: genex__cover {"image":"…","clip":"<path>"}. genex.games keeps five seconds and plays them over the cover on its cards; it refuses frozen or flashing footage.

WHAT STUDIO DOES: it checks both files and copies them into its own storage in place of the last cover; when either is refused nothing is kept and the answer says why. The next publish sends the picture, then the clip (a draft does only until the game is first public); genex__cover-set sends the picture now, once the person approves. A publish takes no picture of its own. Until a picture is kept, Studio keeps a plain frame of the game as it loads, so Publish shows a cover; the picture you keep replaces it. The answer of genex__cover, and the cover in genex__publish-status, say what is kept and how its last send went.

A cover the owner chose on genex.games always stands: send nothing over it, and never ask them to clear it. For a game whose owner keeps its code untouched (a folder brought only to publish), write nothing into it for a cover.
