import { DEFAULT_TOUCH_SETTINGS } from './input.js';

const STORAGE_KEY = 'thunderdome-touch-v1';
const LAYOUTS = new Set(['thumbs', 'left', 'claw']);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function normalizeTouchSettings(value = {}) {
  return {
    layout: LAYOUTS.has(value.layout) ? value.layout : DEFAULT_TOUCH_SETTINGS.layout,
    aimAssist: clamp(
      Number.isFinite(Number(value.aimAssist)) ? Number(value.aimAssist) : DEFAULT_TOUCH_SETTINGS.aimAssist,
      0,
      1
    ),
  };
}

export class TouchSettingsPanel {
  constructor(touch, input, doc = document, storage = localStorage) {
    this.touch = touch;
    this.input = input;
    this.doc = doc;
    this.storage = storage;
    this.root = doc.getElementById('touch-settings');
    if (!touch) {
      this.root.classList.add('hidden');
      return;
    }

    this.settings = this._load();
    this.layoutButtons = [...this.root.querySelectorAll('[data-touch-layout]')];
    this.aimAssist = doc.getElementById('touch-aim-assist');
    this.aimAssistValue = doc.getElementById('touch-aim-assist-value');

    for (const button of this.layoutButtons) {
      button.addEventListener('click', () => {
        this.settings = normalizeTouchSettings({
          ...this.settings,
          layout: button.dataset.touchLayout,
        });
        this._apply(true);
      });
    }
    this.aimAssist.addEventListener('input', () => {
      this.settings = normalizeTouchSettings({
        ...this.settings,
        aimAssist: Number(this.aimAssist.value),
      });
      this._apply(true);
    });
    doc.getElementById('touch-settings-reset').addEventListener('click', () => {
      this.settings = { ...DEFAULT_TOUCH_SETTINGS };
      this._apply(true);
    });
    this._apply(false);
  }

  _load() {
    try {
      return normalizeTouchSettings(JSON.parse(this.storage.getItem(STORAGE_KEY) || '{}'));
    } catch {
      return { ...DEFAULT_TOUCH_SETTINGS };
    }
  }

  _apply(save) {
    this.touch.setLayout(this.settings.layout);
    this.input.setTouchSettings(this.settings);
    this.aimAssist.value = this.settings.aimAssist;
    this.aimAssistValue.textContent = `${Math.round(this.settings.aimAssist * 100)}%`;
    for (const button of this.layoutButtons) {
      const selected = button.dataset.touchLayout === this.settings.layout;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    }
    if (save) {
      try { this.storage.setItem(STORAGE_KEY, JSON.stringify(this.settings)); } catch { /* private mode */ }
    }
  }
}
