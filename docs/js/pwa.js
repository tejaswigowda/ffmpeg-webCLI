// js/pwa.js
//
// Service-worker registration (offline support + CDN precaching) and the
// PWA install-prompt / installed event hooks. Pure side-effect module —
// no exports; importing it once from main.js is enough to wire everything.

import { addLog } from './ui.js';

// ── PWA Install Prompt ─────────────────────────────────────────────────
// Let the browser handle native install UI in the address bar.
window.addEventListener('beforeinstallprompt', (_e) => {
  // Don't prevent default - let browser show native UI
});

// Handle app installed event
window.addEventListener('appinstalled', () => {
  addLog('App installed successfully!', 'ok', 'fas fa-circle-check');
});

// ── Service Worker Registration ─────────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('./service-worker.js', {
        scope: './',
        updateViaCache: 'none',
      });

      // Check for updates periodically
      setInterval(async () => {
        try {
          await registration.update();
        } catch (err) {
          // Silent — update checks are best-effort.
        }
      }, 60000); // Check every 60 seconds

      // Handle new service worker
      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            // New service worker is ready, show update notification
            addLog('New version available - reload to update', 'ok', 'fas fa-circle-info');
          }
        });
      });

      // Log offline/online status
      window.addEventListener('online', () => {
        addLog('Back online', 'ok', 'fas fa-wifi');
      });

      window.addEventListener('offline', () => {
        addLog('Offline - working with cached resources', 'warn', 'fas fa-triangle-exclamation');
      });
    } catch (err) {
      // Silent — SW registration is best-effort.
    }
  });
}
