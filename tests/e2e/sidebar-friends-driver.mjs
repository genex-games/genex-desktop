/**
 * The sidebar's friends, in a tall and a short window and both themes: they stand on the account
 * plate with no room between, fold to their one heading line and unfold, keep that through a reload,
 * stay on the plate in Play, and their faces and names start where the games' and the plate's do.
 */
import { app, BrowserWindow, nativeTheme } from "electron";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const WIDTH = 1440;
/** The usual window (index.ts `MAIN_WINDOW`) and a short one, above the studio's 680 minimum. */
const HEIGHTS = [900, 700];
/** A rect this far off is rounding, not a gap. */
const ROUNDING_PX = 1;
/** The folded friends: their heading line and nothing under it. */
const ONE_LINE_PX = 44;
/** Past the fold's 250ms. */
const SETTLE_MS = 500;
const PHOTO_TRIES = 10;
const PHOTO_RETRY_MS = 200;

const arg = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const out = arg("friends-out");
const main = arg("friends-main");
const profile = path.dirname(arg("studio-dev-launch"));
const build = JSON.parse(fs.readFileSync(path.resolve(main, "../../build.json"), "utf8"));
const checks = [];
const steps = [];
let wc;
const js = (code) => wc.executeJavaScript(code, true);
async function until(code, tries = 300) {
  for (let n = 0; n < tries; n++) {
    if (await js(code).catch(() => false)) return true;
    await wait(50);
  }
  return false;
}
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail });
}

/** The fixture account's seven friends are listed and the plate is up. */
const READY = `document.querySelectorAll('[data-sidebar-friend]').length >= 7 && !!document.querySelector('[data-profile-plate]')`;
const FOLD = `document.querySelector('[data-sidebar-friends-fold]')`;
/** The friends' box, the plate's, the games' list, and where faces and names start in each kind of row. */
const MEASURE = `(() => {
  const rect = (el) => el && el.getBoundingClientRect();
  const sidebar = rect(document.querySelector('[data-pane="rail"]'));
  const friends = rect(document.querySelector('[data-sidebar-friends]'));
  const plate = rect(document.querySelector('[data-profile-plate]'));
  const games = rect(document.querySelector('[data-sidebar-scroll]')?.parentElement);
  const list = rect(document.querySelector('[data-sidebar-friends]')?.parentElement);
  const starts = (row) => {
    const button = row?.querySelector('button');
    if (!button) return null;
    const [face, name] = button.children;
    return { face: rect(face).left - sidebar.left, name: rect(name).left - sidebar.left };
  };
  const heading = document.querySelector('[data-play-friends]');
  const count = heading && [...heading.querySelectorAll('span')].find((el) => /^\\d+$/.test(el.textContent.trim()));
  const fold = ${FOLD};
  const plateName = document.querySelector('[data-profile-plate] button')?.children[1]?.firstElementChild;
  const visibleRows = [...document.querySelectorAll('[data-sidebar-friend]')].filter((row) => {
    const r = rect(row);
    return r.height > 0 && r.bottom <= (friends ? friends.bottom : 0) + 0.5 && r.top >= (friends ? friends.top : 0) - 0.5 && !row.closest('[inert]');
  }).length;
  return {
    friends: friends && { top: friends.top, bottom: friends.bottom, height: friends.height },
    plateTop: plate?.top,
    games: games && { top: games.top, bottom: games.bottom, height: games.height },
    list: list && { top: list.top, height: list.height },
    friend: starts(document.querySelector('[data-sidebar-friend]')),
    game: starts(document.querySelector('[data-game]')),
    plate: starts(document.querySelector('[data-profile-plate]')),
    countBeforeArrow: count ? rect(count).right <= rect(heading.querySelector('[data-icon="arrow-up-right"]')).left : null,
    expanded: fold ? fold.getAttribute('aria-expanded') : null,
    plateNameFits: plateName ? plateName.scrollWidth <= plateName.clientWidth : null,
    visibleRows,
  };
})()`;

const onPlate = (m) => m.friends && Math.abs(m.friends.bottom - m.plateTop) <= ROUNDING_PX;
const oneLine = (m) => m.friends && m.friends.height <= ONE_LINE_PX && m.visibleRows === 0;
const lined = (m) =>
  !!(m.friend && m.game && m.plate) &&
  Math.abs(m.friend.face - m.game.face) <= ROUNDING_PX &&
  Math.abs(m.plate.face - m.game.face) <= ROUNDING_PX &&
  Math.abs(m.friend.name - m.game.name) <= ROUNDING_PX &&
  Math.abs(m.plate.name - m.game.name) <= ROUNDING_PX;

/** A photo of the window; right after a reload the compositor can refuse one for a moment. */
async function photograph(name) {
  for (let attempt = 0; attempt < PHOTO_TRIES; attempt++) {
    const image = await wc.capturePage().catch(() => null);
    if (image) return fs.writeFileSync(path.join(out, `${name}.png`), image.toPNG());
    await wait(PHOTO_RETRY_MS);
  }
  throw new Error(`no photo of ${name}`);
}
async function measure(name) {
  await wait(SETTLE_MS);
  const measured = await js(MEASURE);
  await photograph(name);
  steps.push({ name, ...measured });
  return measured;
}
async function setFolded(folded) {
  const want = folded ? "false" : "true";
  if ((await js(`${FOLD}?.getAttribute('aria-expanded')`)) !== want) await js(`${FOLD}?.click()`);
}

await import(pathToFileURL(main).href);
async function acceptance() {
  try {
    for (let n = 0; n < 300 && !fs.existsSync(path.join(profile, "controller.json")); n++) await wait(100);
    for (let n = 0; n < 300 && !BrowserWindow.getAllWindows().length; n++) await wait(100);
    const win = BrowserWindow.getAllWindows()[0];
    wc = win.webContents;
    win.setPosition(0, 0);
    win.setContentSize(WIDTH, HEIGHTS[0]);
    win.show();
    const up = await until(READY, 1200);
    check("the account's friends are listed", up);
    if (!up) return;
    check("the friends have a fold button", await js(`!!${FOLD}`));
    for (const theme of ["light", "dark"]) {
      nativeTheme.themeSource = theme;
      for (const height of HEIGHTS) {
        win.setContentSize(WIDTH, height);
        await setFolded(false);
        const open = await measure(`${theme}-${height}-open`);
        check(`${theme} ${height}: open friends stand on the plate`, onPlate(open), open);
        check(
          `${theme} ${height}: open friends take at most half the list`,
          open.friends && open.list && open.friends.height <= open.list.height / 2 + ONE_LINE_PX,
          open,
        );
        check(`${theme} ${height}: faces and names on the games' line`, lined(open), open);
        check(`${theme} ${height}: the requests' count before the arrow`, open.countBeforeArrow === true, open);
        check(`${theme} ${height}: the account's name is whole on the plate`, open.plateNameFits === true, open);
        await setFolded(true);
        const folded = await measure(`${theme}-${height}-folded`);
        check(
          `${theme} ${height}: folded friends are one line`,
          oneLine(folded) && folded.expanded === "false",
          folded,
        );
        check(`${theme} ${height}: folded friends stand on the plate`, onPlate(folded), folded);
        check(
          `${theme} ${height}: folding gives the games the room`,
          folded.games && open.games && folded.games.height > open.games.height,
          { open: open.games, folded: folded.games },
        );
      }
    }
    // Folded stays folded through a reload, and open stays open.
    nativeTheme.themeSource = "light";
    win.setContentSize(WIDTH, HEIGHTS[0]);
    for (const folded of [true, false]) {
      await setFolded(folded);
      await wait(SETTLE_MS);
      // The old page answers READY until the new one has loaded, so wait for the load first.
      const loaded = new Promise((resolve) => wc.once("did-finish-load", resolve));
      wc.reload();
      await loaded;
      await until(READY, 1200);
      const again = await measure(`reload-${folded ? "folded" : "open"}`);
      check(
        `${folded ? "folded" : "open"} friends stay so after a reload`,
        again.expanded === (folded ? "false" : "true") && (folded ? oneLine(again) : again.visibleRows > 0),
        again,
      );
    }
    // Play lists them under Recent the same way.
    await js(`document.querySelector('[data-play-mode="play"]')?.click()`);
    const play = await measure("play-open");
    check("in Play the friends stand on the plate", onPlate(play), play);
  } catch (error) {
    check("sidebar friends completed", false, String(error.stack));
  } finally {
    fs.writeFileSync(
      path.join(out, "report.json"),
      JSON.stringify(
        {
          buildId: build.buildId,
          sourceDigest: build.sourceDigest,
          profile: path.basename(profile),
          providers: "fixture",
          platform: process.platform,
          electron: process.versions.electron,
          checks,
          steps,
        },
        null,
        2,
      ),
    );
    app.quit();
  }
}
void acceptance();
