'use strict';

/**
 * Joins a Zoom meeting in the browser (web client) and keeps itself in the
 * meeting until MAX_RUN_MIN. Screen + audio are captured by ffmpeg in
 * scripts/run.sh — this file only has to make sure the Zoom *web page* stays
 * on screen and readable.
 */

const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const ZOOM_LINK = (process.env.ZOOM_LINK || '').trim();
const ZOOM_NAME = process.env.ZOOM_NAME || 'Live';
const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome-stable';
const HEADLESS = process.env.HEADLESS === '1';
const SHOTS_DIR = process.env.SHOTS_DIR || '/tmp/shots';
const MAX_RUN_MIN = Number(process.env.MAX_RUN_MIN || 345);
const JOIN_TIMEOUT_MS = Number(process.env.JOIN_TIMEOUT_MIN || 40) * 60 * 1000;
const KEEPALIVE_MS = 10000;

const HARD_STOP = Date.now() + MAX_RUN_MIN * 60 * 1000;
let stopping = false;

function log(...a) {
  console.log(`[bot ${new Date().toISOString()}]`, ...a);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

fs.mkdirSync(SHOTS_DIR, { recursive: true });

async function shot(page, name) {
  try {
    await page.screenshot({ path: path.join(SHOTS_DIR, `${name}.png`) });
  } catch (_) {}
}

/* ------------------------------------------------------------------ */
/* Zoom link parsing                                                   */
/* ------------------------------------------------------------------ */

function parseZoomLink(raw) {
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch (_) {
    // maybe they pasted only a meeting id
    if (/^\d{6,}$/.test(raw)) return { meetingId: raw, pwd: '' };
    return null;
  }
  const m =
    url.pathname.match(/\/(?:j|s|wc)\/(\d{6,})/) ||
    (url.searchParams.get('confno') || '').match(/^(\d{6,})$/);
  if (!m) return null;
  const pwd =
    url.searchParams.get('pwd') ||
    (url.hash.match(/pwd=([^&]+)/) || [])[1] ||
    '';
  return { meetingId: m[1], pwd: decodeURIComponent(pwd) };
}

function webJoinUrl(info) {
  const base = `https://zoom.us/wc/${info.meetingId}/join`;
  const q = new URLSearchParams();
  if (info.pwd) q.set('pwd', info.pwd);
  q.set('uname', ZOOM_NAME);
  q.set('lang', 'en-US');
  return `${base}?${q.toString()}`;
}

/* ------------------------------------------------------------------ */
/* DOM helpers                                                         */
/* ------------------------------------------------------------------ */

async function clickFirst(page, candidates, timeout = 2000) {
  for (const sel of candidates) {
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count()) === 0) continue;
      if (!(await loc.isVisible().catch(() => false))) continue;
      await loc.click({ timeout });
      log('clicked:', sel);
      return true;
    } catch (_) {}
  }
  return false;
}

async function fillFirst(page, candidates, value) {
  for (const sel of candidates) {
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count()) === 0) continue;
      if (!(await loc.isVisible().catch(() => false))) continue;
      await loc.fill('');
      await loc.type(value, { delay: 40 });
      log('filled:', sel);
      return true;
    } catch (_) {}
  }
  return false;
}

async function meetingState(page) {
  try {
    return await page.evaluate(() => {
      const t = (document.body && document.body.innerText) || '';
      if (/meeting has ended|meeting has been ended|host has ended/i.test(t)) return 'ended';
      if (/invalid meeting|meeting not found|this meeting link is invalid/i.test(t)) return 'invalid';
      if (/waiting for the host|please wait for the host|waiting room|host will let you in|you are in the waiting room/i.test(t))
        return 'waiting';
      if (/sign in to join|only signed in|authorized attendees/i.test(t)) return 'login-required';
      const inMeeting =
        document.querySelector(
          '#video-layout, .meeting-app, #meeting-app, .video-container, #wc-container, .participants-container, [class*="meeting-app"]'
        ) || /leave meeting|end meeting|participants\s*\(/i.test(t);
      if (inMeeting) return 'in';
      return 'out';
    });
  } catch (_) {
    return 'detached';
  }
}

/* ------------------------------------------------------------------ */
/* Join flow                                                           */
/* ------------------------------------------------------------------ */

async function joinFlow(page, info) {
  const target = info ? webJoinUrl(info) : ZOOM_LINK;
  log('navigating to', target.replace(/pwd=[^&]+/, 'pwd=***'));
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await sleep(5000);

  // A privacy/consent banner or the "launch zoom" page can show up first.
  await clickFirst(page, [
    '#onetrust-accept-btn-handler',
    'button:has-text("Accept")',
    'a:has-text("Join from your browser")',
    'button:has-text("Join from your browser")',
  ]);
  await sleep(1500);

  // Terms of service dialog
  await clickFirst(page, [
    '#agreeButton',
    'button:has-text("I Agree")',
    'button:has-text("I agree")',
    '#dialog-join button',
    'a:has-text("I Agree")',
  ]);
  await sleep(2000);

  // Passcode page
  const passcodeField = page.locator(
    '#inputpasscode, input[placeholder*="passcode" i], input[type="password"]'
  ).first();
  if ((await passcodeField.count()) > 0 && (await passcodeField.isVisible().catch(() => false))) {
    const code = info && info.pwd ? info.pwd : (await passcodeField.inputValue().catch(() => ''));
    if (code) {
      await passcodeField.fill(code).catch(() => {});
      await clickFirst(page, [
        '#passcode-join',
        'button:has-text("Join Meeting")',
        'button[type="submit"]',
        'button:has-text("Join")',
      ]);
      await sleep(3000);
    }
  }

  // Name + join
  for (let i = 0; i < 6; i++) {
    await fillFirst(page, [
      '#inputname',
      'input[placeholder*="Your Name" i]',
      'input[placeholder*="name" i]',
      'input[name="uname"]',
    ], ZOOM_NAME);
    await clickFirst(page, [
      '#joinBtn',
      'button:has-text("Join")',
      '#join-confno',
      'a[role="button"]:has-text("Join")',
    ]);
    await sleep(3000);
    const s = await meetingState(page);
    log('state after join attempt', i, '->', s);
    if (s !== 'out') break;
  }

  // Audio
  for (let i = 0; i < 8; i++) {
    const ok = await clickFirst(page, [
      'button:has-text("Join Audio by Computer")',
      'button:has-text("Join with Computer Audio")',
      'button:has-text("Computer Audio")',
      'button:has-text("Join Audio")',
      '#voip-join',
      '.join-audio-by-voip',
      'button[aria-label*="join audio" i]',
    ]);
    if (ok) {
      await sleep(2000);
      break;
    }
    await sleep(2000);
  }
}

/* ------------------------------------------------------------------ */
/* Main                                                               */
/* ------------------------------------------------------------------ */

(async () => {
  if (!ZOOM_LINK) {
    log('FATAL: ZOOM_LINK is empty');
    process.exit(2);
  }

  const info = parseZoomLink(ZOOM_LINK);
  if (info) log('meeting id:', info.meetingId, 'pwd:', info.pwd ? 'yes' : 'no');
  else log('could not parse meeting id, will use the raw link');

  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: HEADLESS,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-infobars',
      '--disable-features=Translate,MediaRouter,OptimizationHints',
      '--window-size=1280,720',
      '--window-position=0,0',
      '--start-fullscreen',
    ],
  });

  log('chrome launched');

  const context = await browser.newContext({
    viewport: null,
    ignoreHTTPSErrors: true,
    permissions: ['microphone'],
  });

  while (!stopping && Date.now() < HARD_STOP) {
    let page;
    try {
      page = await context.newPage();
      page.on('crash', () => log('page crashed'));

      await joinFlow(page, info);

      const joinDeadline = Date.now() + JOIN_TIMEOUT_MS;
      let lastState = '';

      while (!stopping && Date.now() < HARD_STOP) {
        await sleep(KEEPALIVE_MS);
        const state = await meetingState(page);
        if (state !== lastState) {
          log('meeting state ->', state);
          lastState = state;
        }

        if (state === 'in') continue;
        if (state === 'waiting') {
          if (Date.now() > joinDeadline) throw new Error('stuck in waiting room');
          continue;
        }
        if (state === 'ended' || state === 'invalid' || state === 'login-required' || state === 'out' || state === 'detached') {
          await shot(page, `lost-${Date.now()}`);
          throw new Error(`meeting state ${state}`);
        }
      }
    } catch (e) {
      log('rejoin needed:', e.message);
    } finally {
      if (page) await page.close().catch(() => {});
    }

    if (Date.now() < HARD_STOP) {
      log('retrying in 20s...');
      await sleep(20000);
    }
  }

  log('time is up, closing');
  await browser.close().catch(() => {});
  process.exit(0);
})().catch((e) => {
  log('FATAL', e);
  process.exit(1);
});
