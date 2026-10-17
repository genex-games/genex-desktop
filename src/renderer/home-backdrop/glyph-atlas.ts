/**
 * The glyph sheet every live background can read (`bd_glyph` in the prelude): half-width katakana,
 * the digits and a few signs, the characters of a terminal's rain, each white in its own cell.
 */

/** The sheet's glyphs in order; the prelude's `BD_GLYPH_COUNT` and its note on where the digits start follow it. */
export const ATLAS_GLYPHS = "ｦｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789Z:=*+<>|";

/** One glyph's cell on the sheet, in pixels: sampled down, never up. */
export const ATLAS_CELL = { width: 40, height: 56 } as const;

/** The faces the sheet is set in, the first with katakana on each system first. */
const ATLAS_FONT =
  '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "MS Gothic", "Noto Sans CJK JP", "Noto Sans JP", sans-serif';
/** A glyph's size for its cell's height, leaving room so a neighbour never bleeds in. */
const ATLAS_FONT_SHARE = 0.78;

/** Set the sheet on a fresh canvas; null where a 2D context is unavailable. */
export function drawGlyphAtlas(): OffscreenCanvas | null {
  const glyphs = Array.from(ATLAS_GLYPHS);
  const canvas = new OffscreenCanvas(ATLAS_CELL.width * glyphs.length, ATLAS_CELL.height);
  const context = canvas.getContext("2d");
  if (!context) return null;
  const size = Math.round(ATLAS_CELL.height * ATLAS_FONT_SHARE);
  context.font = `${size}px ${ATLAS_FONT}`;
  context.fillStyle = "#ffffff";
  context.textAlign = "center";
  context.textBaseline = "middle";
  for (const [index, glyph] of glyphs.entries()) {
    const width = context.measureText(glyph).width;
    // A wide glyph is narrowed to its cell; a narrow one keeps its shape.
    const squeeze = Math.min(1, (ATLAS_CELL.width * 0.9) / Math.max(width, 1));
    context.setTransform(squeeze, 0, 0, 1, (index + 0.5) * ATLAS_CELL.width, ATLAS_CELL.height / 2);
    context.fillText(glyph, 0, 0);
  }
  return canvas;
}
