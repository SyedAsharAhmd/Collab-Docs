import { expect, test } from '@playwright/test';
import { createDocument, editor, expectLive, share, signToken, signUp } from './helpers.js';

// Two separate browser contexts = two users with separate logins and storage.
test.beforeEach(async ({ browser }, testInfo) => {
  testInfo.owner = await browser.newContext();
  testInfo.guest = await browser.newContext();
});

test.afterEach(async ({}, testInfo) => {
  await testInfo.owner.close();
  await testInfo.guest.close();
});

async function ownerAndGuest(testInfo, guestRole) {
  const ownerPage = await testInfo.owner.newPage();
  const guestPage = await testInfo.guest.newPage();
  const guestEmail = await signUp(guestPage, 'Guest');
  await signUp(ownerPage, 'Owner');
  const docUrl = await createDocument(ownerPage);
  if (guestRole) {
    const dialog = await share(ownerPage, guestEmail, guestRole);
    await dialog.getByRole('button', { name: 'Done' }).click();
    await guestPage.goto(docUrl);
    await expectLive(guestPage);
  }
  return { ownerPage, guestPage, docUrl };
}

test('two users see each other\'s edits live', async ({}, testInfo) => {
  const { ownerPage, guestPage } = await ownerAndGuest(testInfo, 'editor');

  await editor(ownerPage).click();
  await ownerPage.keyboard.type('Hello from the owner. ');
  await expect(editor(guestPage)).toContainText('Hello from the owner.');

  await editor(guestPage).click();
  await guestPage.keyboard.press('Control+End');
  await guestPage.keyboard.type('And hello back.');
  await expect(editor(ownerPage)).toContainText('Hello from the owner. And hello back.');
});

test('a viewer sees changes but cannot edit', async ({}, testInfo) => {
  const { ownerPage, guestPage } = await ownerAndGuest(testInfo, 'viewer');

  await expect(guestPage.getByText('View only')).toBeVisible();
  await expect(guestPage.getByRole('toolbar')).toHaveCount(0);
  await expect(editor(guestPage)).toHaveAttribute('contenteditable', 'false');

  await editor(ownerPage).click();
  await ownerPage.keyboard.type('Owner text');
  await expect(editor(guestPage)).toContainText('Owner text');

  await editor(guestPage).click();
  await guestPage.keyboard.type('viewer typing');
  await ownerPage.waitForTimeout(500);
  await expect(editor(ownerPage)).not.toContainText('viewer typing');
  await expect(editor(guestPage)).not.toContainText('viewer typing');
});

test('content persists after a reload', async ({}, testInfo) => {
  const { ownerPage } = await ownerAndGuest(testInfo, null);

  await editor(ownerPage).click();
  await ownerPage.keyboard.type('Survives a reload');
  await ownerPage.reload();
  await expectLive(ownerPage);
  await expect(editor(ownerPage)).toContainText('Survives a reload');
});

test('removing a collaborator shows them "Access removed" right away', async ({}, testInfo) => {
  const { ownerPage, guestPage } = await ownerAndGuest(testInfo, 'editor');

  await ownerPage.getByRole('button', { name: 'Share', exact: true }).click();
  const dialog = ownerPage.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Remove' }).click();
  await expect(dialog.getByRole('button', { name: 'Remove' })).toHaveCount(0);

  await expect(guestPage.getByText('Access removed')).toBeVisible();
});

test('deleting a document tells everyone who has it open', async ({}, testInfo) => {
  const { ownerPage, guestPage } = await ownerAndGuest(testInfo, 'editor');

  await ownerPage.getByRole('link', { name: '← Documents' }).click();
  ownerPage.once('dialog', (dialog) => dialog.accept()); // the "Delete …?" confirm
  await ownerPage.getByRole('button', { name: 'Delete' }).click();

  await expect(guestPage.getByText('Document no longer exists')).toBeVisible();
});

test('a session that expires mid-edit asks to log in again and keeps the offline edits', async ({ page }) => {
  // Every WebSocket to the collab server passes through this route, so the test can
  // cut the connection like a sleeping laptop would, and refuse reconnects while "offline".
  let offline = false;
  const sockets = [];
  await page.routeWebSocket(/:1334/, (ws) => {
    if (offline) return ws.close();
    ws.connectToServer();
    sockets.push(ws);
  });

  await signUp(page, 'Sleeper');
  await createDocument(page);
  await editor(page).click();
  await page.keyboard.type('Typed before. ');

  // The laptop sleeps: the login expires and the connection drops.
  const userId = await page.evaluate(() => {
    const payload = localStorage.getItem('token').split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(payload)).sub;
  });
  const expired = signToken({ sub: userId, exp: Math.floor(Date.now() / 1000) - 60 });
  await page.evaluate((token) => localStorage.setItem('token', token), expired);
  offline = true;
  sockets.forEach((ws) => ws.close());
  await expect(page.getByText('Offline. Reconnecting…')).toBeVisible();
  await page.keyboard.type('Typed offline.');

  // The network comes back; the reconnect sends the expired token and is refused.
  offline = false;
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Session expired', { timeout: 20000 });
  await expect(page).toHaveURL(/\/doc\//); // still on the document, not the login page
  await dialog.getByLabel('Password').fill('password123');
  await dialog.getByRole('button', { name: 'Log in' }).click();
  await expect(dialog).toHaveCount(0);
  await expectLive(page);

  // Proof the offline text reached the server: a fresh load shows it.
  await page.reload();
  await expectLive(page);
  await expect(editor(page)).toContainText('Typed before. Typed offline.');
});

test('an expired session sends the user back to the login page', async ({ page }) => {
  const expired = signToken({ sub: '00000000-0000-4000-8000-000000000000', exp: Math.floor(Date.now() / 1000) - 60 });
  await page.goto('/login');
  await page.evaluate((token) => localStorage.setItem('token', token), expired);

  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('token'))).toBeNull();
});
