/**
 * The draw counters (M4.9a) — the arithmetic that says what a frame cost, against stub WebGL
 * and WebGPU prototypes. The numbers here are the ones the optimization e2e already asserts on
 * a real GPU (64 boxes of 12 triangles each = 768), which is the point: the counters at the
 * graphics API must agree with `renderer.info` on the shape where `info` is still the truth,
 * and keep counting on the two shapes where it is not — a composer, and a replayed bundle.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installStudioDrawCounters, trianglesFor, GL_TRIANGLES, GL_TRIANGLE_STRIP } from "../../src/page/counters.ts";

const TRIANGLES = GL_TRIANGLES;
const STRIP = GL_TRIANGLE_STRIP;

/** A page with the prototypes the counters patch, and nothing else. */
function page() {
  const calls: string[] = [];
  class WebGL2RenderingContext {
    drawArrays() {
      calls.push("drawArrays");
      return "gl";
    }
    drawElements() {
      calls.push("drawElements");
      return "gl";
    }
    drawArraysInstanced() {
      calls.push("drawArraysInstanced");
      return "gl";
    }
    drawElementsInstanced() {
      calls.push("drawElementsInstanced");
      return "gl";
    }
    drawRangeElements() {
      calls.push("drawRangeElements");
      return "gl";
    }
  }
  class ANGLE_instanced_arrays {
    drawArraysInstancedANGLE() {
      calls.push("angle");
      return "gl";
    }
    drawElementsInstancedANGLE() {
      calls.push("angle");
      return "gl";
    }
  }
  class WEBGL_multi_draw {
    multiDrawArraysWEBGL() {
      calls.push("multi");
      return "gl";
    }
    multiDrawElementsWEBGL() {
      calls.push("multi");
      return "gl";
    }
  }
  class GPURenderBundle {}
  class GPURenderBundleEncoder {
    draw() {
      return "gpu";
    }
    drawIndexed() {
      return "gpu";
    }
    drawIndirect() {
      return "gpu";
    }
    drawIndexedIndirect() {
      return "gpu";
    }
    finish() {
      return new GPURenderBundle();
    }
  }
  class GPURenderPassEncoder {
    draw() {
      return "gpu";
    }
    drawIndexed() {
      return "gpu";
    }
    drawIndirect() {
      return "gpu";
    }
    drawIndexedIndirect() {
      return "gpu";
    }
    executeBundles() {
      return "gpu";
    }
  }
  class GPUAdapter {
    requestDevice(this: unknown, device?: unknown) {
      return Promise.resolve(device ?? {});
    }
  }
  const scope: Record<string, unknown> = {
    WebGL2RenderingContext,
    ANGLE_instanced_arrays,
    WEBGL_multi_draw,
    GPURenderPassEncoder,
    GPURenderBundleEncoder,
    GPUAdapter,
  };
  const originals = new Map<string, unknown>();
  for (const [name, ctor] of Object.entries(scope)) {
    for (const key of Object.getOwnPropertyNames((ctor as { prototype: object }).prototype)) {
      if (key === "constructor") continue;
      originals.set(`${name}.${key}`, (ctor as { prototype: Record<string, unknown> }).prototype[key]);
    }
  }
  return {
    scope,
    calls,
    originals,
    WebGL2RenderingContext,
    ANGLE_instanced_arrays,
    WEBGL_multi_draw,
    GPURenderPassEncoder,
    GPURenderBundleEncoder,
    GPUAdapter,
  };
}

describe("the draw counters count what the frame actually submitted", () => {
  it("64 list draws and one instanced draw of the same geometry agree: 768 triangles", () => {
    const world = page();
    const draw = installStudioDrawCounters({ scope: world.scope, note: () => {} });
    const gl = new world.WebGL2RenderingContext() as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (let i = 0; i < 64; i++) assert.equal(gl.drawElements(TRIANGLES, 36, 0, 0), "gl");
    assert.deepEqual(
      { drawCalls: draw.totals().drawCalls, triangles: draw.totals().triangles },
      { drawCalls: 64, triangles: 768 },
    );
    assert.equal(draw.totals().trianglesExact, true);

    const other = page();
    const one = installStudioDrawCounters({ scope: other.scope, note: () => {} });
    const gl2 = new other.WebGL2RenderingContext() as unknown as Record<string, (...a: unknown[]) => unknown>;
    gl2.drawElementsInstanced(TRIANGLES, 36, 0, 0, 64);
    assert.deepEqual(
      { drawCalls: one.totals().drawCalls, triangles: one.totals().triangles },
      { drawCalls: 1, triangles: 768 },
    );
    draw.end();
    one.end();
  });

  it("a strip of six vertices is four triangles, and points and lines are none", () => {
    assert.equal(trianglesFor(STRIP, 6), 4);
    assert.equal(trianglesFor(TRIANGLES, 36, 64), 768);
    assert.equal(trianglesFor(0, 128), 0);
    assert.equal(trianglesFor(1, 128), 0);
    const world = page();
    const draw = installStudioDrawCounters({ scope: world.scope, note: () => {} });
    const gl = new world.WebGL2RenderingContext() as unknown as Record<string, (...a: unknown[]) => unknown>;
    gl.drawArrays(STRIP, 0, 6);
    assert.deepEqual(
      { drawCalls: draw.totals().drawCalls, triangles: draw.totals().triangles },
      { drawCalls: 1, triangles: 4 },
    );
    draw.end();
  });

  it("a bundle recorded once and executed three times is three draw calls", () => {
    const world = page();
    const draw = installStudioDrawCounters({ scope: world.scope, note: () => {} });
    const encoder = new world.GPURenderBundleEncoder() as unknown as Record<string, (...a: unknown[]) => unknown>;
    encoder.draw(36, 1);
    const bundle = encoder.finish();
    // Recording is not rendering: nothing is counted until the bundle is replayed.
    assert.equal(draw.totals().drawCalls, 0);
    const pass = new world.GPURenderPassEncoder() as unknown as Record<string, (...a: unknown[]) => unknown>;
    pass.executeBundles([bundle]);
    pass.executeBundles([bundle]);
    pass.executeBundles([bundle]);
    assert.equal(draw.totals().drawCalls, 3);
    // The topology lives in the pipeline, not the call, so the triangle number is unknowable.
    assert.equal(draw.totals().triangles, null);
    assert.equal(draw.totals().trianglesExact, false);
    draw.end();
  });

  it("an indirect draw counts a call, no triangles, and stops claiming exactness", () => {
    const world = page();
    const draw = installStudioDrawCounters({ scope: world.scope, note: () => {} });
    const pass = new world.GPURenderPassEncoder() as unknown as Record<string, (...a: unknown[]) => unknown>;
    pass.drawIndirect({}, 0);
    assert.equal(draw.totals().drawCalls, 1);
    assert.equal(draw.totals().indirect, 1);
    assert.equal(draw.totals().triangles, null);
    assert.equal(draw.totals().trianglesExact, false);
    draw.end();
  });

  it("multi-draw counts its whole list of draws and marks the triangle number inexact", () => {
    const world = page();
    const draw = installStudioDrawCounters({ scope: world.scope, note: () => {} });
    const gl = new world.WebGL2RenderingContext() as unknown as Record<string, (...a: unknown[]) => unknown>;
    const multi = new world.WEBGL_multi_draw() as unknown as Record<string, (...a: unknown[]) => unknown>;
    gl.drawElements(TRIANGLES, 36, 0, 0);
    multi.multiDrawArraysWEBGL([TRIANGLES], 0, [36], 0, 7);
    assert.equal(draw.totals().drawCalls, 8);
    assert.equal(draw.totals().trianglesExact, false);
    draw.end();
  });

  it("ANGLE instancing is counted like the WebGL2 entry point it stands in for", () => {
    const world = page();
    const draw = installStudioDrawCounters({ scope: world.scope, note: () => {} });
    const angle = new world.ANGLE_instanced_arrays() as unknown as Record<string, (...a: unknown[]) => unknown>;
    angle.drawElementsInstancedANGLE(TRIANGLES, 36, 0, 0, 64);
    assert.deepEqual(
      { drawCalls: draw.totals().drawCalls, triangles: draw.totals().triangles },
      { drawCalls: 1, triangles: 768 },
    );
    draw.end();
  });

  it("mark() divides the tally per frame and snapshot() is a point in time to subtract", () => {
    const world = page();
    const draw = installStudioDrawCounters({ scope: world.scope, note: () => {} });
    const gl = new world.WebGL2RenderingContext() as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (let i = 0; i < 5; i++) gl.drawElements(TRIANGLES, 36, 0, 0);
    const warm = draw.snapshot();
    draw.mark();
    assert.deepEqual(draw.frame().drawCalls, 5);
    for (let i = 0; i < 3; i++) gl.drawElements(TRIANGLES, 36, 0, 0);
    draw.mark();
    assert.equal(draw.frame().drawCalls, 3);
    assert.equal(draw.totals().frames, 2);
    assert.equal(draw.totals().drawCalls - warm.drawCalls, 3);
    draw.end();
  });

  it("end() restores every method", () => {
    const world = page();
    const draw = installStudioDrawCounters({ scope: world.scope, note: () => {} });
    const gl = new world.WebGL2RenderingContext() as unknown as Record<string, (...a: unknown[]) => unknown>;
    gl.drawElements(TRIANGLES, 36, 0, 0);
    assert.equal(draw.totals().drawCalls, 1);
    // The game's own call still reached the driver.
    assert.equal(world.calls.filter((name) => name === "drawElements").length, 1);

    draw.end();
    for (const [path, original] of world.originals) {
      const [ctor, key] = path.split(".");
      const proto = (world.scope[ctor] as { prototype: Record<string, unknown> }).prototype;
      assert.equal(proto[key], original, `${path} was not restored to its original identity`);
    }
    assert.equal(world.scope.__studioDraw, undefined);
  });

  it("a second install is the first one, not a second layer of wrappers", () => {
    const world = page();
    const first = installStudioDrawCounters({ scope: world.scope, note: () => {} });
    const second = installStudioDrawCounters({ scope: world.scope, note: () => {} });
    assert.equal(second, first);
    const gl = new world.WebGL2RenderingContext() as unknown as Record<string, (...a: unknown[]) => unknown>;
    gl.drawElements(TRIANGLES, 36, 0, 0);
    assert.equal(first.totals().drawCalls, 1);
    first.end();
  });

  it("a WebGPU device's uncaptured errors and loss reach the studio's error list", async () => {
    const world = page();
    const errors: string[] = [];
    const draw = installStudioDrawCounters({ scope: world.scope, note: (m: string) => errors.push(m) });
    let lost: (info: { reason: string }) => void = () => {};
    const listeners: Array<(event: unknown) => void> = [];
    const device = {
      addEventListener: (type: string, fn: (event: unknown) => void) => {
        if (type === "uncapturederror") listeners.push(fn);
      },
      lost: new Promise<{ reason: string }>((resolve) => {
        lost = resolve;
      }),
    };
    const adapter = new world.GPUAdapter() as unknown as { requestDevice: (d: unknown) => Promise<unknown> };
    await adapter.requestDevice(device);
    await Promise.resolve();
    listeners[0]?.({ error: { message: "buffer too small" } });
    lost({ reason: "destroyed" });
    await device.lost;
    await Promise.resolve();
    assert.ok(
      errors.some((e) => e.startsWith("GPU_UNCAPTURED_ERROR")),
      errors.join(" | "),
    );
    assert.ok(
      errors.some((e) => e.startsWith("GPU_DEVICE_LOST")),
      errors.join(" | "),
    );
    draw.end();
  });
});
