/**
 * What Grok Build reads besides the studio's own prompt. Grok Build takes no picture from its
 * prompt file (its ACP answers `image: false`, and a picture block there never reaches the model),
 * but its own `read_file` shows a picture file as a picture: so each picture is a file beside the
 * prompt, named here.
 */

/** The lines that hand Grok Build a turn's pictures, in order. */
export function picturesNote(files: readonly string[]): string {
  return [
    "Pictures come with this message. Open each with read_file to see it, in this order:",
    ...files.map((file) => `- ${file}`),
  ].join("\n");
}
