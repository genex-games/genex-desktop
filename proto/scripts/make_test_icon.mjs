// Writes the stand-in button image: a 64x64 PNG, an orange square with a teal square inside, so it
// cannot be mistaken for any Unreal icon. Usage: node make_test_icon.mjs <output.png>
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const SIZE = 64;
const OUTER = [255, 120, 0, 255];
const INNER = [0, 200, 180, 255];
const INNER_FROM = 18;
const INNER_TO = 46;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});

function crc32(buffer) {
	let c = 0xffffffff;
	for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, crc]);
}

const rows = [];
for (let y = 0; y < SIZE; y++) {
	const row = [0];
	for (let x = 0; x < SIZE; x++) {
		const inside = x >= INNER_FROM && x < INNER_TO && y >= INNER_FROM && y < INNER_TO;
		row.push(...(inside ? INNER : OUTER));
	}
	rows.push(Buffer.from(row));
}

const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 8; // bit depth
header[9] = 6; // RGBA
const png = Buffer.concat([
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	chunk("IHDR", header),
	chunk("IDAT", deflateSync(Buffer.concat(rows))),
	chunk("IEND", Buffer.alloc(0)),
]);
writeFileSync(process.argv[2], png);
