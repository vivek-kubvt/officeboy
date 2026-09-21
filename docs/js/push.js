// Phone notifications through Firebase Cloud Messaging.
// The Firebase SDK is only downloaded when someone turns notifications on.

import { api } from './api.js';
import { isIOS, isStandalone } from './platform.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2';
const KEY = 'officeboy.pushToken';

export function pushSupport() {
  if (isIOS && !isStandalone()) return { ok: false, reason: 'On iPhone, notifications only work in the installed app. Add OfficeBoy to your home screen and open it from there.' };
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    return { ok: false, reason: 'This browser can’t show notifications. Use Chrome on Android or the installed app on iPhone (iOS 16.4 or newer).' };
  }
  return { ok: true };
}

/** 'on' | 'off' | 'blocked' | 'unsupported' */
export function pushState() {
  if (!pushSupport().ok) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  let token = null;
  try { token = localStorage.getItem(KEY); } catch {}
  return Notification.permission === 'granted' && token ? 'on' : 'off';
}

/** Must be called from a tap. Asks for permission, gets a Firebase token and saves it in the sheet. */
export async function enablePush(firebase) {
  const support = pushSupport();
  if (!support.ok) throw new Error(support.reason);
  if (!firebase?.config || !firebase.vapidKey) throw new Error('Your admin hasn’t set up notifications yet (Settings → Phone notifications).');

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(isIOS
      ? 'Notifications are off. Turn them on in iPhone Settings → Notifications → OfficeBoy.'
      : 'Notifications are blocked. Tap the lock icon next to the address, or open phone Settings → Apps → Chrome → Notifications.');
  }

  const registration = await navigator.serviceWorker.ready;
  const [{ initializeApp, getApps }, { getMessaging, getToken, isSupported }] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-messaging.js`),
  ]);
  if (!(await isSupported())) throw new Error('This browser doesn’t support Firebase notifications.');
  const app = getApps().find((a) => a.name === 'officeboy') || initializeApp(firebase.config, 'officeboy');
  const token = await getToken(getMessaging(app), { vapidKey: firebase.vapidKey, serviceWorkerRegistration: registration });
  if (!token) throw new Error('Firebase didn’t return a notification token. Try again.');

  await api('registerDevice', { deviceToken: token, platform: isIOS ? 'ios' : /Android/i.test(navigator.userAgent) ? 'android' : 'desktop' });
  try { localStorage.setItem(KEY, token); } catch {}
  return token;
}
