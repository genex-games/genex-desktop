const canvas = document.getElementById("game");
const context = canvas.getContext("2d");
let x = 0;

function frame() {
  x = (x + 2) % canvas.width;
  context.fillStyle = "#123";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#fc3";
  context.fillRect(x, 160, 24, 24);
  requestAnimationFrame(frame);
}
frame();
