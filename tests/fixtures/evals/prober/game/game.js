// A synthetic probe fixture: a textured 2D scene behind a PLAY button that hides on click, and a
// player square that moves while a key is held. Nothing is loaded from the network.
// The square and its step are large enough that one sample of held input moves the probe's 64x36
// mirror past its 0.004 no-input floor (a 60 px square at 4 px a frame moved it 0.0019).
const SIZE = 100;
const STEP = 10;
const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const held = new Set();
let playing = false;
let x = 320;
let y = 180;

document.getElementById("start").addEventListener("click", () => {
  playing = true;
  document.getElementById("menu").style.display = "none";
});
addEventListener("keydown", (e) => held.add(e.code));
addEventListener("keyup", (e) => held.delete(e.code));

function step() {
  if (playing) {
    if (held.has("KeyW") || held.has("ArrowUp")) y -= STEP;
    if (held.has("KeyS")) y += STEP;
    if (held.has("KeyA")) x -= STEP;
    if (held.has("KeyD")) x += STEP;
  }
  for (let ty = 0; ty < 360; ty += 20) {
    for (let tx = 0; tx < 640; tx += 20) {
      const shade = 60 + (((tx + ty) / 20) % 5) * 25;
      ctx.fillStyle = `rgb(${shade}, ${shade + 20}, ${shade + 40})`;
      ctx.fillRect(tx, ty, 20, 20);
    }
  }
  ctx.fillStyle = "#f0c040";
  ctx.fillRect(x - SIZE / 2, y - SIZE / 2, SIZE, SIZE);
  requestAnimationFrame(step);
}
requestAnimationFrame(step);
