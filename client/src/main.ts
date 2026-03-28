import { Application, Graphics } from "pixi.js";

async function init() {
  const app = new Application();

  await app.init({
    resizeTo: window,
    background: "#0a1628",
    antialias: true,
  });

  document.body.appendChild(app.canvas);

  // Draw a simple test shape to confirm rendering works
  const marker = new Graphics();
  marker.circle(0, 0, 20);
  marker.fill({ color: 0x3498db });
  marker.x = app.screen.width / 2;
  marker.y = app.screen.height / 2;
  app.stage.addChild(marker);

  console.log(
    `Hormuz client running — PixiJS ${app.renderer.type === 0b10 ? "WebGPU" : "WebGL"} renderer`,
  );
}

init();
