import { test, expect } from '@playwright/test';

test('submits durable work, inspects state, filters failures, resubmits and navigates', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type())) errors.push(message.text());
  });
  await page.goto('/');
  await expect(page.getByText('All systems operational')).toBeVisible();
  const id = `browser-${Date.now()}`;
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('textbox', { name: 'Actor ID', exact: true }).fill(JSON.stringify(id));
  await page.getByRole('textbox', { name: 'Payload', exact: true }).fill('{"amount":7}');
  await page.getByRole('dialog').getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Durably accepted');
  await page.getByRole('button', { name: /^Actors/ }).click();
  await page.getByRole('textbox', { name: 'Search actors' }).fill(id);
  await page.getByRole('button', { name: id, exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('"value": 7');
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('combobox', { name: 'Message type' }).selectOption('counter.fail');
  await page
    .getByRole('textbox', { name: 'Payload', exact: true })
    .fill('{"reason":"browser expected failure"}');
  const invocation = `failure-${Date.now()}`;
  await page.getByRole('textbox', { name: 'Invocation ID' }).fill(invocation);
  await page.getByRole('dialog').getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('button', { name: 'Invocations', exact: true }).click();
  await page.getByRole('combobox', { name: 'Status filter' }).selectOption('FAILED');
  await page.getByRole('textbox', { name: 'Search invocations' }).fill(invocation);
  await page.getByRole('button', { name: invocation, exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('browser expected failure');
  await page.getByRole('button', { name: 'Resubmit as new invocation' }).click();
  await expect(page.getByRole('status')).toContainText('New invocation accepted');
  await page.getByRole('button', { name: 'Reminders', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Pending reminders' })).toBeVisible();
  await page.getByRole('button', { name: 'Catalogue', exact: true }).click();
  await page.getByRole('button', { name: 'counter.add' }).click();
  await expect(page.getByRole('dialog')).toContainText('payloadSchema');
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Runtime', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Replica', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('mobile navigation and empty state have no horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByText('All systems operational')).toBeVisible();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: /^Actors/ }).click();
  await page.getByRole('textbox', { name: 'Search actors' }).fill('no-such-actor-xyz');
  await expect(page.getByText('No matching records')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('read-only permission hides management controls', async ({ page }) => {
  await page.route('**/api/brando/session', (route) =>
    route.fulfill({ json: { permission: 'read' } }),
  );
  await page.goto('/');
  await expect(page.getByText('All systems operational')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toHaveCount(0);
});
