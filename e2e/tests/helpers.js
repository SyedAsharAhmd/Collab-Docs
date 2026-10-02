import { createHmac } from 'node:crypto';
import { expect } from '@playwright/test';
import { E2E_JWT_SECRET } from '../playwright.config.js';

// Registers a new user through the real UI and lands on the document list.
export async function signUp(page, name) {
  const email = `${name.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
  await page.goto('/login');
  await page.getByRole('button', { name: 'No account? Create one' }).click();
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('password123');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Documents' })).toBeVisible();
  return email;
}

// Creates a document and waits until its live connection is up.
export async function createDocument(page) {
  await page.getByRole('button', { name: 'New document' }).click();
  await expect(page).toHaveURL(/\/doc\/[0-9a-f-]{36}$/);
  await expectLive(page);
  return page.url();
}

export const expectLive = (page) => expect(page.getByText('Live', { exact: true })).toBeVisible();

export const editor = (page) => page.locator('.tiptap');

export async function share(page, email, role) {
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Email address').fill(email);
  await dialog.getByLabel('Role', { exact: true }).selectOption(role);
  await dialog.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(dialog.getByText(email)).toBeVisible();
  return dialog;
}

// An HS256 JWT signed like the API signs them, e.g. to fake an expired session.
export function signToken(payload) {
  const encode = (part) => Buffer.from(JSON.stringify(part)).toString('base64url');
  const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}`;
  const signature = createHmac('sha256', E2E_JWT_SECRET).update(unsigned).digest('base64url');
  return `${unsigned}.${signature}`;
}
