// Records docs/demo.gif: Alice and Bob in two separate browsers editing the welcome
// document, side by side. Needs a running stack with the demo seed applied:
//   npm run dev in server/, collab/, client/, then npm run seed:demo in collab/
//   cd e2e && npm run demo:gif            (BASE_URL defaults to http://localhost:5173)
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import gifenc from 'gifenc'; // CommonJS package: no named imports

const { GIFEncoder, applyPalette, quantize } = gifenc;

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173';
const OUTPUT = new URL('../../docs/demo.gif', import.meta.url);
const PASSWORD = 'try-collab-docs';
const PAGE = { width: 620, height: 500 };
const GAP = 12;
const HEADER = 34;
const WIDTH = PAGE.width * 2 + GAP;
const HEIGHT = PAGE.height + HEADER;

const browser = await chromium.launch();
const gif = GIFEncoder();

async function openAs(email) {
  const context = await browser.newContext({ viewport: PAGE }); // separate logins and storage
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/login`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await page.getByRole('link', { name: 'Welcome to Collab Docs' }).click();
  await page.getByText('Live', { exact: true }).waitFor();
  return page;
}

const alice = await openAs('alice@demo.example.com');
const bob = await openAs('bob@demo.example.com');

// A blank page whose canvas puts the two screenshots side by side, with a label above
// each, and hands back the raw pixels.
const compositor = await browser.newPage();
await compositor.setContent(`<canvas id="c" width="${WIDTH}" height="${HEIGHT}"></canvas>`);

async function captureFrame(delay) {
  const [left, right] = await Promise.all([alice.screenshot(), bob.screenshot()]);
  const rgbaBase64 = await compositor.evaluate(
    async ({ left, right, PAGE, GAP, HEADER, WIDTH, HEIGHT }) => {
      const load = (b64) =>
        new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.src = `data:image/png;base64,${b64}`;
        });
      const ctx = document.getElementById('c').getContext('2d');
      ctx.fillStyle = '#e5e7eb';
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
      ctx.fillStyle = '#111827';
      ctx.font = '600 16px system-ui, sans-serif';
      ctx.fillText('Alice (owner), in browser 1', 12, 23);
      ctx.fillText('Bob (editor), in browser 2', PAGE.width + GAP + 12, 23);
      ctx.drawImage(await load(left), 0, HEADER);
      ctx.drawImage(await load(right), PAGE.width + GAP, HEADER);
      const pixels = ctx.getImageData(0, 0, WIDTH, HEIGHT).data;
      let binary = '';
      for (let i = 0; i < pixels.length; i += 0x8000) {
        binary += String.fromCharCode(...pixels.subarray(i, i + 0x8000));
      }
      return btoa(binary);
    },
    { left: left.toString('base64'), right: right.toString('base64'), PAGE, GAP, HEADER, WIDTH, HEIGHT },
  );
  const rgba = new Uint8Array(Buffer.from(rgbaBase64, 'base64'));
  const palette = quantize(rgba, 256);
  gif.writeFrame(applyPalette(rgba, palette), WIDTH, HEIGHT, { palette, delay });
}

// Types `text` in a new paragraph under the given paragraph, capturing a frame every
// few keystrokes so the other window can be seen catching up.
async function typeUnder(page, paragraphText, text) {
  // Put the caret at the very end of that paragraph. (Clicking and pressing End would
  // only reach the end of the visual line when the paragraph wraps.)
  await page.locator('.tiptap p', { hasText: paragraphText }).first().evaluate((p) => {
    p.closest('.tiptap').focus();
    const range = document.createRange();
    range.selectNodeContents(p);
    range.collapse(false);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await page.keyboard.press('Enter');
  for (let i = 0; i < text.length; i += 3) {
    await page.keyboard.type(text.slice(i, i + 3), { delay: 30 });
    await captureFrame(140);
  }
}

await captureFrame(1500); // both windows, before anything happens
await typeUnder(alice, 'Three demo users share', 'Alice here: Bob, can you see me typing?');
await captureFrame(1200);
await typeUnder(bob, 'Alice here', 'Bob here: yes, live, in a different browser.');
// Each window must show the other person's line before the final frame.
await bob.locator('.tiptap').getByText('Alice here: Bob, can you see me typing?').waitFor();
await alice.locator('.tiptap').getByText('Bob here: yes, live, in a different browser.').waitFor();
await captureFrame(3000); // hold the result

// The final frame as a PNG too, for places where a GIF doesn't fit.
await compositor.locator('#c').screenshot({ path: fileURLToPath(new URL('../../docs/screenshot.png', import.meta.url)) });

gif.finish();
await writeFile(OUTPUT, gif.bytes());
console.log(`Wrote ${fileURLToPath(OUTPUT)} (${Math.round(gif.bytes().length / 1024)} KB)`);
await browser.close();
