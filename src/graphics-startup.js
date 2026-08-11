export function graphicsFailureCopy(xbox = false) {
  if (xbox) {
    return {
      title: 'EDGE LOST THE XBOX GRAPHICS DEVICE',
      detail: 'The game cannot create a WebGL 2 graphics context. Your career is safe, and lowering the game\'s visual quality will not fix this browser state.',
      steps: [
        'Press the Xbox button and highlight Microsoft Edge.',
        'Press the Menu button, then choose Quit.',
        'Open Edge again and return to Thunderdome.',
      ],
      note: 'Reloading this page is not enough — Edge itself must be fully quit.',
    };
  }
  return {
    title: 'GRAPHICS COULD NOT START',
    detail: 'The browser could not create the WebGL 2 context required by Thunderdome.',
    steps: [
      'Close and reopen the browser.',
      'Make sure browser hardware acceleration is enabled.',
      'Update the browser and graphics driver if the problem continues.',
    ],
    note: '',
  };
}

export function showGraphicsStartupFailure(error, { xbox = false, doc = document } = {}) {
  const copy = graphicsFailureCopy(xbox);
  const overlay = doc.createElement('main');
  overlay.id = 'graphics-startup-failure';
  overlay.setAttribute('role', 'alert');

  const eyebrow = doc.createElement('div');
  eyebrow.className = 'graphics-failure-eyebrow';
  eyebrow.textContent = 'THUNDERDOME // GRAPHICS STARTUP';

  const title = doc.createElement('h1');
  title.textContent = copy.title;

  const detail = doc.createElement('p');
  detail.textContent = copy.detail;

  const steps = doc.createElement('ol');
  for (const instruction of copy.steps) {
    const item = doc.createElement('li');
    item.textContent = instruction;
    steps.appendChild(item);
  }

  overlay.append(eyebrow, title, detail, steps);
  if (copy.note) {
    const note = doc.createElement('strong');
    note.textContent = copy.note;
    overlay.appendChild(note);
  }

  const diagnostic = doc.createElement('small');
  diagnostic.textContent = `TECHNICAL DETAIL: ${error?.message || error || 'WebGL 2 context creation failed'}`;
  overlay.appendChild(diagnostic);
  doc.body.appendChild(overlay);
  return overlay;
}
