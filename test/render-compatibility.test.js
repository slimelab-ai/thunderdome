import test from 'node:test';
import assert from 'node:assert/strict';
import { RenderPipeline } from '../src/render.js';

test('rendering without GPU timing still preserves the complete composer path', () => {
  const calls = [];
  const pipeline = Object.assign(Object.create(RenderPipeline.prototype), {
    _pendingResize: false,
    _timerExt: null,
    _gpuQueries: [],
    _gpuMs: 0,
    gradePass: { uniforms: { uTime: { value: 0 } } },
    renderer: {
      getContext() { return { isContextLost: () => false }; },
    },
    composer: { render() { calls.push('composer'); } },
    _adapt() {},
  });

  pipeline.render(1);
  assert.deepEqual(calls, ['composer']);
  assert.equal(pipeline.gradePass.uniforms.uTime.value, 1);
});
