import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';

/**
 * The render pipeline: HDR scene → ambient occlusion → bloom → tone map → AA → grade.
 *
 * Quality tiers exist because the game ships to phones as well as desktops. Each
 * tier is a set of passes, not a set of magic numbers — the look is meant to
 * survive dropping to `low`, just with less of it.
 */

export const QUALITY_TIERS = ['low', 'medium', 'high'];

const TIERS = {
  low:    { ao: false, bloom: true,  smaa: false, grade: true,  maxPixelRatio: 1.0, shadowMap: 1024, softShadows: false },
  medium: { ao: false, bloom: true,  smaa: true,  grade: true,  maxPixelRatio: 1.35, shadowMap: 2048, softShadows: true },
  high:   { ao: true,  bloom: true,  smaa: true,  grade: true,  maxPixelRatio: 1.75, shadowMap: 2048, softShadows: true },
};

/**
 * Final colour grade, applied after tone mapping so the numbers behave like a
 * colourist's controls rather than like exposure.
 *
 * The split-tone is the signature of the look: shadows pulled cool and slightly
 * green-blue (damp concrete under mercury light), highlights pushed warm (sodium
 * lamps). Vignette, grain and a touch of radial chromatic aberration sell "shot on
 * a cheap camera bolted to the cage" — the fiction is that you are watching a
 * broadcast of an illegal fight.
 */
const GradeShader = {
  uniforms: {
    tDiffuse:      { value: null },
    uTime:         { value: 0 },
    uShadowTint:   { value: new THREE.Color(0.86, 0.95, 1.06) },
    uHighlightTint:{ value: new THREE.Color(1.06, 1.0, 0.92) },
    uContrast:     { value: 1.06 },
    uSaturation:   { value: 0.94 },
    uVignette:     { value: 0.42 },
    uGrain:        { value: 0.035 },
    uAberration:   { value: 0.0016 },
    uFlash:        { value: 0.0 },
    uFlashColor:   { value: new THREE.Color(1, 0.1, 0.1) },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform float uTime, uContrast, uSaturation, uVignette, uGrain, uAberration, uFlash;
    uniform vec3 uShadowTint, uHighlightTint, uFlashColor;
    varying vec2 vUv;

    // Hash-based grain. Animated per frame, weighted toward the shadows where real
    // sensor noise lives — uniform grain over highlights reads as dirt on a lens.
    float hash(vec2 p) {
      p = fract(p * vec2(443.897, 441.423));
      p += dot(p, p + 19.19);
      return fract((p.x + p.y) * p.x);
    }

    void main() {
      vec2 uv = vUv;
      vec2 fromCenter = uv - 0.5;
      float r2 = dot(fromCenter, fromCenter);

      // Radial chromatic aberration: channels sampled at slightly different scales,
      // strength growing toward the frame edge like a real cheap lens.
      float ab = uAberration * r2 * 4.0;
      vec3 color = vec3(
        texture2D(tDiffuse, uv - fromCenter * ab).r,
        texture2D(tDiffuse, uv).g,
        texture2D(tDiffuse, uv + fromCenter * ab).b
      );

      // Split-tone by luminance.
      float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
      vec3 tint = mix(uShadowTint, uHighlightTint, smoothstep(0.15, 0.75, luma));
      color *= tint;

      // Contrast around mid grey, then saturation.
      color = (color - 0.5) * uContrast + 0.5;
      color = mix(vec3(luma), color, uSaturation);

      // Damage/event flash tints the whole frame at the grade stage so it reads over
      // bloom and AA instead of being an HTML overlay fighting the 3D image.
      color = mix(color, uFlashColor, uFlash);

      // Vignette.
      color *= 1.0 - uVignette * smoothstep(0.12, 0.75, r2);

      // Grain.
      float g = hash(uv * 1024.0 + fract(uTime) * 91.7) - 0.5;
      color += g * uGrain * (1.0 - smoothstep(0.0, 0.8, luma));

      gl_FragColor = vec4(max(color, 0.0), 1.0);
    }
  `,
};

export class RenderPipeline {
  constructor(scene, camera, { quality = 'high', container = document.body } = {}) {
    this.scene = scene;
    this.camera = camera;

    this.renderer = new THREE.WebGLRenderer({
      antialias: false,              // SMAA does this; MSAA would cost us the HDR buffer
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    // Half-float targets: bloom needs values above 1.0 to have anything to pick out,
    // which an 8-bit target clips away before the pass ever sees them.
    this.composer = new EffectComposer(this.renderer, new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples: 0,
    }));

    this.renderPass = new RenderPass(scene, camera);

    this.aoPass = new GTAOPass(scene, camera, window.innerWidth, window.innerHeight);
    this.aoPass.output = GTAOPass.OUTPUT.Default;
    this.aoPass.blendIntensity = 0.85;
    this.aoPass.updateGtaoMaterial({
      radius: 0.6,                  // metres — contact shadows, not a global dimmer
      distanceExponent: 1.4,
      thickness: 1.0,
      scale: 1.0,
      samples: 12,
      screenSpaceRadius: false,
    });

    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.62,   // strength
      0.55,   // radius
      0.82,   // threshold — only genuine emissives and specular hits bloom
    );

    this.outputPass = new OutputPass();      // tone map + sRGB transfer
    this.smaaPass = new SMAAPass(window.innerWidth, window.innerHeight);
    this.gradePass = new ShaderPass(GradeShader);

    this.setQuality(quality);
    window.addEventListener('resize', () => this.resize());
  }

  get tier() { return TIERS[this.quality]; }

  setQuality(name) {
    if (!TIERS[name]) name = 'medium';
    this.quality = name;
    const tier = TIERS[name];

    this.renderer.shadowMap.type = tier.softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, tier.maxPixelRatio));

    // Rebuild the chain rather than toggling `enabled`: a disabled pass still costs
    // its render target, and GTAO's is the expensive one.
    this.composer.passes.length = 0;
    this.composer.addPass(this.renderPass);
    if (tier.ao) this.composer.addPass(this.aoPass);
    if (tier.bloom) this.composer.addPass(this.bloomPass);
    this.composer.addPass(this.outputPass);
    if (tier.smaa) this.composer.addPass(this.smaaPass);
    if (tier.grade) this.composer.addPass(this.gradePass);

    this.onShadowMapSize?.(tier.shadowMap);
    this.resize();
  }

  /**
   * Bake a reflection probe from inside the arena.
   *
   * Metal without an environment map is just a dark surface with a hotspot, so the
   * cage, gantries and weapons need this to read as steel. Rendering the actual
   * scene into a cubemap (rather than shipping an HDRI) means the reflections carry
   * the room's own sodium lamps and red signage for free.
   *
   * Called again once streamed props have arrived, since the first bake happens
   * before they exist.
   */
  bakeEnvironment(at = new THREE.Vector3(0, 2.6, 0)) {
    const cubeTarget = new THREE.WebGLCubeRenderTarget(128, { type: THREE.HalfFloatType });
    const cubeCam = new THREE.CubeCamera(0.3, 60, cubeTarget);
    cubeCam.position.copy(at);
    this.scene.add(cubeCam);
    // The probe must not capture the post stack or the player's viewmodel; it renders
    // straight through the raw renderer with the camera's children hidden.
    const vmVisible = [];
    this.camera.traverse((o) => { if (o !== this.camera) { vmVisible.push([o, o.visible]); o.visible = false; } });
    const prevEnv = this.scene.environment;
    this.scene.environment = null;
    cubeCam.update(this.renderer, this.scene);
    this.scene.environment = prevEnv;
    for (const [o, v] of vmVisible) o.visible = v;
    this.scene.remove(cubeCam);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    pmrem.compileCubemapShader();
    const env = pmrem.fromCubemap(cubeTarget.texture);
    this.scene.environment?.dispose?.();
    this.scene.environment = env.texture;
    // Full-strength IBL would flatten a room this dark; the probe is a specular
    // hint, and the lamp rig stays the only real light in the pit.
    this.scene.environmentIntensity = 0.42;
    pmrem.dispose();
    cubeTarget.dispose();
    return env.texture;
  }

  /** Whole-frame tint, used by damage and event feedback. */
  setFlash(amount, color) {
    this.gradePass.uniforms.uFlash.value = amount;
    if (color) this.gradePass.uniforms.uFlashColor.value.set(color);
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio, this.tier.maxPixelRatio);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h);
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(w, h);
    this.aoPass.setSize(w * dpr, h * dpr);
    this.bloomPass.setSize(w * dpr, h * dpr);
    this.smaaPass.setSize(w * dpr, h * dpr);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render(elapsed) {
    this.gradePass.uniforms.uTime.value = elapsed;
    this.composer.render();
  }

  get domElement() { return this.renderer.domElement; }
}
