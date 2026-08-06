import test from 'node:test';
import assert from 'node:assert/strict';
import { RenderPipeline } from '../src/render.js';

test('Xbox compatibility renders directly without touching the composer or GPU query path', () => {
  const calls = [];
  const scene = {};
  const camera = {};
  const pipeline = Object.assign(Object.create(RenderPipeline.prototype), {
    compatibilityMode: true,
    scene,
    camera,
    _pendingResize: false,
    renderer: {
      render(renderedScene, renderedCamera) { calls.push([renderedScene, renderedCamera]); },
      getContext() { throw new Error('compatibility render must not inspect the WebGL context'); },
    },
    composer: { render() { throw new Error('compatibility render must not use EffectComposer'); } },
    _adapt() {},
  });

  pipeline.render(1);
  assert.deepEqual(calls, [[scene, camera]]);
});
