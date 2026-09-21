// Device detection and the "install app" prompt.

const ua = navigator.userAgent;

export const isAndroid = /Android/i.test(ua);
// iPads report themselves as a Mac with touch.
export const isIOS = !isAndroid && (/iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
export const isMobile = isIOS || isAndroid;

/** Browsers built into WhatsApp, Instagram, Facebook etc. can't install apps. */
export const isInAppBrowser = /FBAN|FBAV|Instagram|Line\/|Snapchat|LinkedInApp|MicroMessenger|; wv\)|WhatsApp/i.test(ua);

export function isStandalone() {
  return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

let deferredPrompt = null;
const listeners = new Set();

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  listeners.forEach((fn) => fn());
});
window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  try { localStorage.setItem('officeboy.installed', '1'); } catch {}
  listeners.forEach((fn) => fn());
});

export function canPromptInstall() {
  return !!deferredPrompt;
}

/** Calls fn whenever install availability changes. Returns an unsubscribe function. */
export function onInstallChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Shows Android's install dialog. Resolves true if the person accepted. */
export async function promptInstall() {
  if (!deferredPrompt) return false;
  const prompt = deferredPrompt;
  deferredPrompt = null;
  prompt.prompt();
  const { outcome } = await prompt.userChoice;
  listeners.forEach((fn) => fn());
  return outcome === 'accepted';
}

export function markInstalledHint() {
  try { return localStorage.getItem('officeboy.installed') === '1'; } catch { return false; }
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    return copied;
  }
}
