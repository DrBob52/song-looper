import { expect, test } from './fixtures';

test('app shell loads', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Song Looper' })).toBeVisible();
});
