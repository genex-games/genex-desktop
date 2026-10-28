/**
 * A store item's picture as tests need it: a PNG's signature and IHDR, which is all Studio reads to
 * judge its size (`main/core/item-pictures.ts` `pictureSize`). Square at 1024 by default, the size
 * a store item's card takes edge to edge.
 */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A PNG header of `width` × `height`, followed by `tail` so two pictures can differ. */
export function pngPicture(width = 1024, height = width, tail = ""): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "latin1");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr.writeUInt8(8, 16);
  ihdr.writeUInt8(6, 17);
  return Buffer.concat([Buffer.from(PNG_SIGNATURE), ihdr, Buffer.from(tail, "latin1")]);
}

/** A WebP's RIFF and VP8X headers of `width` × `height`: the extended format a renderer writes. */
export function webpPicture(width = 1024, height = width): Buffer {
  const head = Buffer.alloc(30);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(22, 4);
  head.write("WEBPVP8X", 8, "latin1");
  head.writeUInt32LE(10, 16);
  head.writeUIntLE(width - 1, 24, 3);
  head.writeUIntLE(height - 1, 27, 3);
  return head;
}
