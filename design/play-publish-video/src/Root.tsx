import { Composition } from "remotion";
import { PlayPublish } from "./PlayPublish";
import { FPS, FRAMES, H, W } from "./theme";

export function RemotionRoot() {
  return (
    <Composition id="PlayPublish" component={PlayPublish} durationInFrames={FRAMES} fps={FPS} width={W} height={H} />
  );
}
