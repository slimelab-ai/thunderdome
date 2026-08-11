import { detectXboxBrowser } from './platform.js';

// Current Xbox Edge only identifies itself through an asynchronous Client Hint.
// Resolve it before evaluating the game module so every synchronous platform
// consumer sees the same answer during setup.
detectXboxBrowser()
  .then((xbox) => {
    if (xbox) document.body.classList.add('xbox-browser');
    return import('./main.js');
  })
  .catch((error) => {
    // Graphics startup failures render their own recovery screen in main.js.
    // Keep the module rejection visible for unrelated boot failures.
    console.error('[startup] game bootstrap failed', error);
  });
