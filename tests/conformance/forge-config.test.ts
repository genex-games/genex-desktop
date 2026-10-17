/**
 * The Linux package makers find the app by its binary name. They default to the npm package name,
 * so after the product became Genex (`executableName: "genex"`) the rpm maker looked for
 * `ai-game-studio` and failed in CI. Each Linux maker must name the packaged executable.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);

test("the deb and rpm makers point at the packaged executable, not the npm package name", () => {
  const config = require("../../forge.config.cjs");
  const executable = config.packagerConfig.executableName;
  const linuxMakers = config.makers.filter((maker: { name: string }) =>
    ["@electron-forge/maker-deb", "@electron-forge/maker-rpm"].includes(maker.name),
  );
  assert.equal(linuxMakers.length, 2);
  for (const maker of linuxMakers) assert.equal(maker.config.options.bin, executable, maker.name);
});

test("Windows packages as a per-user Squirrel installer named Genex-Setup.exe, with Genex's own metadata and icon", () => {
  const config = require("../../forge.config.cjs");
  const squirrel = config.makers.find((maker: { name: string }) => maker.name === "@electron-forge/maker-squirrel");
  assert.ok(squirrel, "a Squirrel maker is configured");
  assert.deepEqual(squirrel.platforms, ["win32"]);
  assert.equal(squirrel.config.setupExe, "Genex-Setup.exe");
  assert.equal(squirrel.config.name, config.packagerConfig.executableName, "the install folder and nupkg id");
  assert.match(squirrel.config.setupIcon, /icon\.ico$/);
  assert.equal(squirrel.config.noMsi, true);
  const { CompanyName, ProductName } = config.packagerConfig.win32metadata;
  assert.deepEqual([CompanyName, ProductName], ["Genex", "Genex"]);
});

test("Squirrel's install window plays Genex's own animation, a looping 400 × 260 GIF", () => {
  const config = require("../../forge.config.cjs");
  const squirrel = config.makers.find((maker: { name: string }) => maker.name === "@electron-forge/maker-squirrel");
  const gif = readFileSync(squirrel.config.loadingGif);
  assert.equal(gif.subarray(0, 6).toString("latin1"), "GIF89a");
  assert.deepEqual([gif.readUInt16LE(6), gif.readUInt16LE(8)], [400, 260], "the size of Squirrel's install window");
  assert.ok(gif.includes(Buffer.from("NETSCAPE2.0", "latin1")), "the animation loops");
});
