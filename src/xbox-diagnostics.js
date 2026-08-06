import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { GradeShader } from './render.js';

const $ = id => document.getElementById(id);
const codeEl = $('session-code');
const uploadState = $('upload-state');
const graphicsState = $('graphics-state');
const controllerState = $('controller-state');
const controllerReadout = $('controller-readout');
const voiceState = $('voice-state');
const overallState = $('overall-state');
const stage = $('probe-stage');
const results = $('probe-results');
const rerun = $('rerun-graphics');

let session = null;
let sequence = 0;
let uploadTail = Promise.resolve();
let graphicsComplete = false;
let graphicsRunning = false;
let graphicsFailures = 0;
let controllerTriggeredRerun = false;
let gamepadSeen = false;
let voiceRunning = false;
const checksSeen = new Set();
const deferredErrors = [];

function setState(el, text, kind = 'pending') {
  el.textContent = text;
  el.className = `state ${kind}`;
}

function compactError(error) {
  return {
    name: String(error?.name || 'Error').slice(0, 80),
    message: String(error?.message || error || 'unknown error').slice(0, 500),
    stack: String(error?.stack || '').slice(0, 2000),
  };
}

async function sendEvent(record) {
  const response = await fetch(`/api/diagnostics/${session.code}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${session.write_token}`,
    },
    cache: 'no-store',
    body: JSON.stringify({ events: [record] }),
  });
  if (!response.ok) throw new Error(`diagnostic upload returned ${response.status}`);
  setState(uploadState, 'REPORTING LIVE', 'good');
}

function emit(type, payload = {}) {
  if (!session) {
    deferredErrors.push({ type, payload });
    return Promise.resolve();
  }
  const record = {
    seq: ++sequence,
    type,
    at: new Date().toISOString(),
    payload,
  };
  const task = uploadTail.then(() => sendEvent(record));
  uploadTail = task.catch(error => {
    setState(uploadState, 'UPLOAD RETRY NEEDED', 'bad');
    console.error('[xbox diagnostics] upload failed', error);
  });
  return task;
}

window.addEventListener('error', event => emit('page_error', {
  message: String(event.message || ''),
  source: String(event.filename || ''),
  line: event.lineno || 0,
  column: event.colno || 0,
  error: compactError(event.error),
}));
window.addEventListener('unhandledrejection', event => emit('unhandled_rejection', compactError(event.reason)));

async function openSession() {
  const response = await fetch('/api/diagnostics/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    cache: 'no-store',
    body: '{}',
  });
  if (!response.ok) throw new Error(`session service returned ${response.status}`);
  session = await response.json();
  codeEl.textContent = session.code;
  setState(uploadState, 'REPORTING LIVE', 'good');
  await emit('session_started', {
    page: location.href,
    build: import.meta.env?.VITE_BUILD_SHA || 'dev',
    user_agent: navigator.userAgent,
    platform: navigator.platform || '',
    language: navigator.language || '',
    hardware_concurrency: navigator.hardwareConcurrency || null,
    device_memory: navigator.deviceMemory || null,
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    screen: { width: screen.width, height: screen.height, color_depth: screen.colorDepth },
    secure_context: window.isSecureContext,
  });
  for (const queued of deferredErrors.splice(0)) await emit(queued.type, queued.payload);
}

function makeScene() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x07101c);
  const camera = new THREE.PerspectiveCamera(65, 16 / 9, 0.05, 100);
  camera.position.set(3.8, 2.6, 5.4);
  camera.lookAt(0, 0.6, 0);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(12, 12),
    new THREE.MeshStandardMaterial({ color: 0x27303a, roughness: 0.82, metalness: 0.08 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const cube = new THREE.Mesh(
    new THREE.BoxGeometry(1.6, 1.6, 1.6),
    new THREE.MeshStandardMaterial({ color: 0xb5232b, roughness: 0.3, metalness: 0.45 }),
  );
  cube.position.y = 0.82;
  cube.rotation.set(0.18, 0.62, 0.08);
  cube.castShadow = true;
  scene.add(cube);

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(1.35, 0.09, 12, 48),
    new THREE.MeshStandardMaterial({ color: 0xffb92e, emissive: 0xff5a08, emissiveIntensity: 2.8 }),
  );
  ring.position.set(0, 1.1, -1.2);
  scene.add(ring);

  const key = new THREE.DirectionalLight(0xffe1a8, 4.2);
  key.position.set(3, 6, 4);
  key.castShadow = true;
  scene.add(key, new THREE.HemisphereLight(0x799bc9, 0x21130d, 1.35));
  return { scene, camera };
}

function makeRenderer(width, height) {
  const renderer = new THREE.WebGLRenderer({
    antialias: false,
    powerPreference: 'high-performance',
    stencil: false,
  });
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  return renderer;
}

function graphicsInfo(renderer) {
  const gl = renderer.getContext();
  const parameter = value => {
    try { return gl.getParameter(value); } catch (error) { return `ERROR: ${error.message}`; }
  };
  return {
    webgl_version: parameter(gl.VERSION),
    glsl_version: parameter(gl.SHADING_LANGUAGE_VERSION),
    vendor: parameter(gl.VENDOR),
    renderer: parameter(gl.RENDERER),
    max_texture_size: parameter(gl.MAX_TEXTURE_SIZE),
    max_renderbuffer_size: parameter(gl.MAX_RENDERBUFFER_SIZE),
    max_samples: parameter(gl.MAX_SAMPLES),
    extensions: gl.getSupportedExtensions?.() || [],
  };
}

function sampleFrame(renderer, width, height) {
  const gl = renderer.getContext();
  const pixels = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  let red = 0, green = 0, blue = 0, count = 0, white = 0, black = 0;
  const stride = Math.max(4, Math.floor(pixels.length / (12000 * 4)) * 4);
  for (let i = 0; i < pixels.length; i += stride) {
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
    red += r; green += g; blue += b; count++;
    if (r > 245 && g > 245 && b > 245) white++;
    if (r < 8 && g < 8 && b < 8) black++;
  }

  const thumb = document.createElement('canvas');
  thumb.width = 320; thumb.height = 180;
  const ctx = thumb.getContext('2d');
  ctx.drawImage(renderer.domElement, 0, 0, thumb.width, thumb.height);
  let screenshot = null;
  try { screenshot = thumb.toDataURL('image/jpeg', 0.58); } catch (error) { screenshot = `ERROR: ${error.message}`; }
  return {
    average_rgb: [red, green, blue].map(total => Math.round(total / Math.max(1, count))),
    white_fraction: +(white / Math.max(1, count)).toFixed(4),
    black_fraction: +(black / Math.max(1, count)).toFixed(4),
    context_lost: gl.isContextLost(),
    gl_error: gl.getError(),
    screenshot,
  };
}

function addProbeResult(test, outcome, error = null) {
  const card = document.createElement('div');
  card.className = 'probe-result';
  const summary = error
    ? `ERROR · ${error.message}`
    : `RGB ${outcome.average_rgb.join('/')} · WHITE ${(outcome.white_fraction * 100).toFixed(1)}%`;
  card.innerHTML = `<b>${test.label}</b><span>${summary}</span>`;
  if (!error && outcome.screenshot?.startsWith('data:')) {
    const image = document.createElement('img');
    image.alt = `${test.label} capture`;
    image.src = outcome.screenshot;
    card.appendChild(image);
    stage.replaceChildren(image.cloneNode());
  }
  results.appendChild(card);
}

function blitTarget(renderer, texture) {
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ map: texture }));
  scene.add(quad);
  renderer.setRenderTarget(null);
  renderer.render(scene, camera);
  quad.geometry.dispose();
  quad.material.dispose();
}

function createComposer(renderer, scene, camera, width, height, type, features) {
  const target = new THREE.WebGLRenderTarget(width, height, { type, depthBuffer: true, stencilBuffer: false });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  if (features.includes('gtao')) {
    const gtao = new GTAOPass(scene, camera, width, height);
    gtao.output = GTAOPass.OUTPUT.Default;
    gtao.updateGtaoMaterial({ radius: 0.6, samples: 12, distanceExponent: 1.4, thickness: 1.0, scale: 1.0, screenSpaceRadius: false });
    composer.addPass(gtao);
  }
  if (features.includes('bloom')) {
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(width, height), 0.62, 0.55, 0.82));
  }
  if (features.includes('output')) composer.addPass(new OutputPass());
  if (features.includes('smaa')) composer.addPass(new SMAAPass(width, height));
  if (features.includes('grade')) composer.addPass(new ShaderPass(GradeShader));
  return composer;
}

const PROBES = [
  { id: 'direct', label: 'DIRECT CANVAS', run: ({ renderer, scene, camera }) => renderer.render(scene, camera) },
  { id: 'byte-target', label: '8-BIT TARGET + BLIT', run: ({ renderer, scene, camera, width, height, cleanup }) => {
    const target = new THREE.WebGLRenderTarget(width, height, { type: THREE.UnsignedByteType });
    cleanup.push(() => target.dispose());
    renderer.setRenderTarget(target); renderer.render(scene, camera); blitTarget(renderer, target.texture);
  } },
  { id: 'byte-composer', label: '8-BIT COMPOSER', composer: { type: THREE.UnsignedByteType, features: [] } },
  { id: 'byte-output-grade', label: '8-BIT + OUTPUT + GRADE', composer: { type: THREE.UnsignedByteType, features: ['output', 'grade'] } },
  { id: 'half-output-grade', label: 'HALF-FLOAT + OUTPUT + GRADE', composer: { type: THREE.HalfFloatType, features: ['output', 'grade'] } },
  { id: 'half-bloom', label: 'HALF-FLOAT + BLOOM', composer: { type: THREE.HalfFloatType, features: ['bloom', 'output', 'grade'] } },
  { id: 'full-stack', label: 'FULL GAME POST STACK', composer: { type: THREE.HalfFloatType, features: ['gtao', 'bloom', 'output', 'smaa', 'grade'] } },
];

async function runProbe(test, index) {
  const width = Math.max(320, Math.min(1920, innerWidth));
  const height = Math.max(180, Math.min(1080, innerHeight));
  setState(graphicsState, `${index + 1}/${PROBES.length} · ${test.label}`, 'pending');
  await emit('render_probe_start', { id: test.id, label: test.label, width, height });
  await new Promise(resolve => requestAnimationFrame(resolve));

  let renderer, composer;
  let succeeded = false;
  const cleanup = [];
  try {
    const built = makeScene();
    renderer = makeRenderer(width, height);
    stage.replaceChildren(renderer.domElement);
    if (index === 0) await emit('webgl_capabilities', graphicsInfo(renderer));
    if (test.composer) {
      composer = createComposer(renderer, built.scene, built.camera, width, height,
        test.composer.type, test.composer.features);
      composer.render();
    } else {
      test.run({ renderer, ...built, width, height, cleanup });
    }
    const outcome = sampleFrame(renderer, width, height);
    addProbeResult(test, outcome);
    await emit('render_probe_result', { id: test.id, ...outcome });
    succeeded = true;
  } catch (error) {
    const detail = compactError(error);
    addProbeResult(test, null, detail);
    await emit('render_probe_error', { id: test.id, ...detail });
  } finally {
    for (const dispose of cleanup) { try { dispose(); } catch {} }
    try { composer?.dispose?.(); } catch {}
    try { renderer?.dispose(); renderer?.forceContextLoss(); } catch {}
  }
  return succeeded;
}

function maybeRerunForController() {
  if (!gamepadSeen || graphicsRunning || !graphicsComplete || graphicsFailures === 0 || controllerTriggeredRerun) return;
  controllerTriggeredRerun = true;
  setState(graphicsState, 'CONTROLLER FOUND · RETRYING', 'pending');
  overallState.textContent = 'CONTROLLER MODE DETECTED — GRAPHICS RETRY STARTING';
  emit('graphics_rerun_scheduled', { reason: 'gamepad_visible', previous_failures: graphicsFailures });
  setTimeout(() => runGraphicsProbes('gamepad_visible'), 500);
}

async function runGraphicsProbes(reason = 'manual') {
  if (graphicsRunning) return;
  graphicsRunning = true;
  rerun.disabled = true;
  graphicsComplete = false;
  graphicsFailures = 0;
  results.replaceChildren();
  setState(graphicsState, 'STARTING', 'pending');
  await emit('graphics_run_started', { reason });
  for (let i = 0; i < PROBES.length; i++) {
    if (!(await runProbe(PROBES[i], i))) graphicsFailures++;
    await new Promise(resolve => setTimeout(resolve, 350));
  }
  graphicsComplete = true;
  graphicsRunning = false;
  rerun.disabled = false;
  setState(graphicsState,
    graphicsFailures ? `${graphicsFailures} PROBE${graphicsFailures === 1 ? '' : 'S'} FAILED` : 'ALL PROBES PASSED',
    graphicsFailures ? 'bad' : 'good');
  overallState.textContent = 'GRAPHICS COMPLETE — FINISH THE CONTROLLER CHECKS';
  await emit('graphics_complete', { reason, failures: graphicsFailures, probes: PROBES.map(test => test.id) });
  maybeRerunForController();
}

function markCheck(name) {
  if (checksSeen.has(name)) return;
  checksSeen.add(name);
  document.querySelector(`[data-check="${name}"]`)?.classList.add('seen');
  emit('controller_check_seen', { check: name });
  if (graphicsComplete && checksSeen.size >= 7) overallState.textContent = 'DIAGNOSTICS COMPLETE — TELL CODEX THE CODE';
}

function snapshotGamepads() {
  try {
    return Array.from(navigator.getGamepads?.() || []).filter(Boolean).map(gamepad => ({
      index: gamepad.index,
      id: gamepad.id,
      mapping: gamepad.mapping,
      connected: gamepad.connected,
      timestamp: gamepad.timestamp,
      axes: Array.from(gamepad.axes || []).map(value => +value.toFixed(4)),
      buttons: Array.from(gamepad.buttons || []).map(button => ({
        pressed: button.pressed,
        touched: button.touched,
        value: +Number(button.value || 0).toFixed(4),
      })),
    }));
  } catch (error) {
    return { error: compactError(error) };
  }
}

let lastPadSignature = '';
let lastPadUploadAt = -Infinity;
let previousButtons = [];
function pollController() {
  const snapshot = snapshotGamepads();
  const signature = JSON.stringify(snapshot);
  if (signature !== lastPadSignature) {
    lastPadSignature = signature;
    controllerReadout.textContent = JSON.stringify(snapshot, null, 2);
    const now = performance.now();
    if (now - lastPadUploadAt >= 500) {
      lastPadUploadAt = now;
      emit('gamepad_snapshot', { gamepads: snapshot });
    }
  }
  const pad = Array.isArray(snapshot) ? snapshot[0] : null;
  if (pad) {
    if (!gamepadSeen) {
      gamepadSeen = true;
      maybeRerunForController();
    }
    setState(controllerState, 'GAMEPAD VISIBLE', 'good');
    const axes = pad.axes || [];
    if (Math.hypot(axes[0] || 0, axes[1] || 0) > 0.35) markCheck('left-stick');
    if (Math.hypot(axes[2] || 0, axes[3] || 0) > 0.35) markCheck('right-stick');
    const mapping = { 0: 'a', 1: 'b', 3: 'y', 7: 'rt', 9: 'start' };
    for (const [indexText, name] of Object.entries(mapping)) {
      const index = Number(indexText);
      const pressed = !!pad.buttons?.[index]?.pressed || (pad.buttons?.[index]?.value || 0) > 0.35;
      if (pressed) markCheck(name);
      if (name === 'y' && pressed && !previousButtons[index]) playVoiceTest();
    }
    previousButtons = (pad.buttons || []).map(button => !!button.pressed || button.value > 0.35);
  } else {
    previousButtons = [];
    setState(controllerState, snapshot?.error ? 'GAMEPAD API ERROR' : 'NOT VISIBLE TO PAGE', 'bad');
  }
  requestAnimationFrame(pollController);
}

function gamepadEvent(kind, event) {
  emit(kind, {
    index: event.gamepad?.index,
    id: event.gamepad?.id,
    mapping: event.gamepad?.mapping,
    buttons: event.gamepad?.buttons?.length,
    axes: event.gamepad?.axes?.length,
  });
}
window.addEventListener('gamepadconnected', event => gamepadEvent('gamepad_connected', event));
window.addEventListener('gamepaddisconnected', event => gamepadEvent('gamepad_disconnected', event));
window.addEventListener('focus', () => emit('window_focus'));
window.addEventListener('blur', () => emit('window_blur'));
document.addEventListener('visibilitychange', () => emit('visibility_change', { state: document.visibilityState }));
document.addEventListener('keydown', event => {
  if (!event.repeat) emit('dom_keydown', { code: event.code, key: event.key });
});
document.addEventListener('pointerdown', event => emit('dom_pointerdown', {
  pointer_type: event.pointerType, button: event.button, target: event.target?.id || event.target?.tagName,
}), { passive: true });

async function playVoiceTest() {
  if (voiceRunning) return;
  voiceRunning = true;
  setState(voiceState, 'STARTING', 'pending');
  try {
    if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) throw new Error('Web Speech API unavailable');
    const voices = speechSynthesis.getVoices().map(voice => ({ name: voice.name, lang: voice.lang, local: voice.localService }));
    await emit('voice_test_requested', { voices });
    const utterance = new SpeechSynthesisUtterance('Cameras rolling, bets locked. Welcome to the Thunderdome.');
    utterance.rate = 1.0;
    utterance.pitch = 0.95;
    utterance.volume = 0.86;
    const english = speechSynthesis.getVoices().find(voice => /^en/i.test(voice.lang));
    if (english) utterance.voice = english;
    utterance.onstart = () => { setState(voiceState, 'PLAYING', 'good'); emit('voice_started', { voice: utterance.voice?.name || null }); };
    utterance.onend = event => { setState(voiceState, 'FINISHED', 'good'); voiceRunning = false; emit('voice_ended', { elapsed: event.elapsedTime || null }); };
    utterance.onerror = event => { setState(voiceState, `ERROR: ${event.error}`, 'bad'); voiceRunning = false; emit('voice_error', { error: event.error }); };
    speechSynthesis.cancel();
    speechSynthesis.speak(utterance);
    setTimeout(() => {
      if (!voiceRunning) return;
      voiceRunning = false;
      setState(voiceState, 'NO END EVENT', 'bad');
      emit('voice_timeout');
    }, 12000);
  } catch (error) {
    voiceRunning = false;
    setState(voiceState, 'UNAVAILABLE', 'bad');
    await emit('voice_exception', compactError(error));
  }
}

$('voice-test').addEventListener('click', playVoiceTest);
rerun.addEventListener('click', () => runGraphicsProbes('manual'));

async function boot() {
  try {
    await openSession();
    pollController();
    await runGraphicsProbes('initial');
  } catch (error) {
    codeEl.textContent = 'ERROR';
    setState(uploadState, 'SESSION FAILED', 'bad');
    overallState.textContent = 'RELOAD THIS PAGE';
    console.error('[xbox diagnostics] startup failed', error);
  }
}

boot();
