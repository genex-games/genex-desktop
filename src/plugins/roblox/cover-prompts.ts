/** What `cover-pictures` tells the agent that called it: where the cover's pictures are, or why there are none. */

/** Where the pictures go, as the publish skill walks it: Studio's Game Settings no longer take them. */
const UPLOAD =
  "Upload them on the game's Creator Hub page in the person's browser, as the publish skill says: https://create.roblox.com/dashboard/creations/experiences/<game.GameId>/places/<game.PlaceId>/icon for the icon, then Thumbnails in its sidebar for the thumbnail (ticked Active), saving each. In each file dialog, go to the folder first (⌘⇧G on a Mac, the file name field on Windows: paste the folder and press Return), then pick the picture by its name and open it.";

export const COVER_PROMPTS = {
  Made: (folder: string, icon: string, thumbnail: string) =>
    `Made the cover from Roblox Studio's viewport in the folder ${folder}: the game icon ${icon} (512 × 512) and a thumbnail ${thumbnail} (1920 × 1080). Look at both first; if they don't show the game well, frame Studio's camera on a better view and call this again. ${UPLOAD}`,
  Unbound:
    "Roblox Studio isn't connected for this game, so no picture was taken. Open the game's place in Studio, then call this again.",
  NoShot:
    "Genex couldn't take Roblox Studio's picture just now. Try once more; if it fails again, leave the cover and say so in one line.",
  NoFolder: "There's no game folder to keep the cover in, so nothing was made.",
  NotMade: (why: string) => `Genex couldn't make the cover's pictures (${why}), so nothing was made.`,
} as const;
