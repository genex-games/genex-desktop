# Play publish film

The looping film on the Play sidebar card (`src/renderer/play/PlayPromo.tsx`). It is a
[Remotion](https://www.remotion.dev/) project of its own: nothing here is bundled into the app,
only the two rendered files are.

The app sits as a window on a desk of an autumn mountain road at sunset, and a camera moves over it the way a screen recording is edited, so the film still reads
at the card's size: from the whole window it zooms in on Publish as the cursor clicks it, eases back
to the dialog publishing Midnight Asphalt Pursuit (each step ticks as its third of the bar fills)
and punches in as it goes live: the edge glows green, six players fly in and land in a stack, each
its own kind of picture (a face in neon bokeh, a chrome head, a cyberpunk anime girl, a felt
creature, a smiling orb, a gamer lit by the screen), and the count rolls up to "128 playing". It pulls out and in again on the Play switch, then follows the cursor to the
dashboard, where the game's placeholder turns into its card, glowing blue, "131 online" while the
cursor hovers it. It zooms out to the whole window, which turns back to Create, so the film loops.
760×400 at 30 fps, 12.8 s, shown at about 224×118 CSS pixels: every close-up keeps text at least
30 app pixels times the zoom, about 9 CSS pixels on the card.

- `src/PlayPublish.tsx`: the window (Create and Play), the dialog, the cursor and the story's
  frames (`T`) and camera shots (`SHOTS`).
- `src/motion.ts`: keyframe tracks over frames, and the camera (zoom eased in log space; `dip`
  pulls back during a long move between close-ups).
- `src/theme.ts`: the palette, the type, the frame and the app's size.
- `public/covers`: the game covers the film shows, from the public genex.games feed; the hero is
  full size, the others are 640×360.
- `public/desk.webp` (cropped from `desk-source.webp`) and `public/players` (cut from two 3×2
  sheets) were made with Genex image generation.
- `public/fonts`: the app's Zalando Sans SemiExpanded and Geist Mono (SIL OFL 1.1, texts beside them).

## Preview and render

Node 24 and ffmpeg on the path.

```sh
npm install
npm run studio   # preview and scrub in Remotion Studio
npm run render   # writes src/renderer/media/play-publish.mp4 and play-publish-poster.jpg
```

`scripts/render.sh` renders H.264 from Remotion at twice the size, scales it down to 760×400 and
re-encodes it small (CRF 24, no audio, fast start, a keyframe a second); the poster is frame 236,
the dialog live with its players in. Commit both files in `src/renderer/media`.

## License

Remotion is free for individuals and companies of up to three people; larger companies need a
Remotion company license (https://www.remotion.dev/license) before rendering for commercial use.
Check this before the next render ships.
