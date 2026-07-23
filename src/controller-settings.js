import { DEFAULT_CONTROLLER_SETTINGS, STICK, stickCurve } from './input.js';

const STORAGE_KEY = 'thunderdome-controller-v1';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function normalizeControllerSettings(value = {}) {
  return {
    sensitivity: clamp(Number(value.sensitivity) || DEFAULT_CONTROLLER_SETTINGS.sensitivity, 0.3, 1.5),
    exponent: clamp(Number(value.exponent) || DEFAULT_CONTROLLER_SETTINGS.exponent, 1.2, 3),
    aimAssist: clamp(Number.isFinite(Number(value.aimAssist)) ? Number(value.aimAssist) : DEFAULT_CONTROLLER_SETTINGS.aimAssist, 0, 1),
  };
}

export function responseCurvePoints(exponent, steps = 36) {
  return Array.from({ length: steps + 1 }, (_, index) => {
    const raw = index / steps;
    return { raw, output: stickCurve(raw, 0, STICK.deadzone, exponent).mag };
  });
}

export class ControllerSettingsPanel {
  constructor(input, doc = document, storage = localStorage) {
    this.input = input;
    this.doc = doc;
    this.storage = storage;
    this.settings = this._load();
    this.controls = {
      sensitivity: doc.getElementById('controller-sensitivity'),
      exponent: doc.getElementById('controller-exponent'),
      aimAssist: doc.getElementById('controller-aim-assist'),
    };
    this.values = {
      sensitivity: doc.getElementById('controller-sensitivity-value'),
      exponent: doc.getElementById('controller-exponent-value'),
      aimAssist: doc.getElementById('controller-aim-assist-value'),
    };
    this.curve = doc.getElementById('controller-curve-path');
    this.dot = doc.getElementById('controller-curve-dot');
    this.sample = doc.getElementById('controller-curve-sample');

    for (const [key, control] of Object.entries(this.controls)) {
      control.value = this.settings[key];
      control.addEventListener('input', () => {
        this.settings = normalizeControllerSettings({ ...this.settings, [key]: Number(control.value) });
        this._apply(true);
      });
    }
    doc.getElementById('controller-settings-reset').onclick = () => {
      this.settings = { ...DEFAULT_CONTROLLER_SETTINGS };
      for (const [key, control] of Object.entries(this.controls)) control.value = this.settings[key];
      this._apply(true);
    };
    input.onControllerSample = (point) => this.showSample(point);
    this._apply(false);
    this.showSample({ raw: 0, curved: 0 });
  }

  _load() {
    try {
      return normalizeControllerSettings(JSON.parse(this.storage.getItem(STORAGE_KEY) || '{}'));
    } catch {
      return { ...DEFAULT_CONTROLLER_SETTINGS };
    }
  }

  _apply(save) {
    this.input.setControllerSettings(this.settings);
    this.values.sensitivity.textContent = `${this.settings.sensitivity.toFixed(2)}×`;
    this.values.exponent.textContent = this.settings.exponent.toFixed(2);
    this.values.aimAssist.textContent = `${Math.round(this.settings.aimAssist * 100)}%`;
    const points = responseCurvePoints(this.settings.exponent);
    this.curve.setAttribute('d', points.map((point, index) => {
      const x = 22 + point.raw * 256;
      const y = 126 - point.output * 100;
      return `${index ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(' '));
    if (save) {
      try { this.storage.setItem(STORAGE_KEY, JSON.stringify(this.settings)); } catch { /* private mode */ }
    }
  }

  showSample({ raw = 0, curved = 0 }) {
    const x = 22 + clamp(raw, 0, 1) * 256;
    const y = 126 - clamp(curved, 0, 1) * 100;
    this.dot.setAttribute('cx', x.toFixed(1));
    this.dot.setAttribute('cy', y.toFixed(1));
    this.dot.classList.toggle('curve-dot-live', raw > STICK.deadzone);
    this.sample.textContent = `STICK ${Math.round(raw * 100)}%  →  TURN ${Math.round(curved * 100)}%`;
  }
}
