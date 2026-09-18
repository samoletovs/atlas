import type { Locator, Page } from '@playwright/test';
import { test, expect, LOCAL_BASE_URL } from './fixtures/learningPortal';

test.use({ baseURL: LOCAL_BASE_URL, serviceWorkers: 'block' });

async function expectPageWithinViewport(page: Page) {
  const widths = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(widths.document).toBeLessThanOrEqual(widths.viewport + 1);
  expect(widths.body).toBeLessThanOrEqual(widths.viewport + 1);
}

async function expectContentToFit(locator: Locator) {
  const size = await locator.evaluate(element => ({
    client: element.clientWidth,
    scroll: element.scrollWidth,
  }));
  expect(size.scroll, 'Content must wrap, not overflow or be clipped').toBeLessThanOrEqual(size.client + 1);
}

async function doubleTextSize(page: Page) {
  await page.evaluate(() => {
    const sizes = Array.from(document.querySelectorAll<HTMLElement>('*'))
      .map(element => ({ element, size: parseFloat(getComputedStyle(element).fontSize) }));
    for (const { element, size } of sizes) element.style.setProperty('font-size', `${size * 2}px`, 'important');
  });
}

for (const width of [320, 390, 1280]) {
  test.describe(`${width}px long Topics titles`, () => {
    test.use({ viewport: { width, height: 844 }, lessonLanguage: 'ru', appearance: 'dark' });

    test('keeps the complete lesson title within List and Graph detail', async ({ page, portal }) => {
      const title = portal.lessons().recommended.title;
      await portal.goto('/atlas');
      const listTitle = page.locator('.topic-atlas-list-item').getByRole('button', { name: title, exact: true });
      await expect(listTitle).toBeVisible();
      await expectContentToFit(listTitle);
      await expectPageWithinViewport(page);

      await page.getByRole('button', { name: 'Graph', exact: true }).click();
      await page.locator('.atlas-node').filter({ has: page.locator('text', { hasText: 'Traffic Safety' }) }).focus();
      const detail = page.locator('.topic-atlas-detail');
      await expect(detail.getByRole('button', { name: title, exact: true })).toBeVisible();
      await expectContentToFit(detail);
      await expectPageWithinViewport(page);
    });
  });
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`${theme} recovery contrast`, () => {
    test.use({ appearance: theme, viewport: { width: 320, height: 844 } });

    test('uses AA contrast for Topics failure text', async ({ page, portal }) => {
      portal.failures.add('all');
      await portal.goto('/atlas');
      const error = page.getByRole('alert');
      await expect(error).toBeVisible();
      const colors = await error.evaluate(element => ({
        foreground: getComputedStyle(element).color,
        background: getComputedStyle(document.body).backgroundColor,
      }));
      const luminance = (color: string) => {
        const rgb = color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
        if (!rgb || rgb.length !== 3) throw new Error(`Expected an opaque RGB color, got ${color}`);
        return rgb.map(value => {
          const channel = value / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        }).reduce((total, channel, index) => total + channel * [0.2126, 0.7152, 0.0722][index], 0);
      };
      const foreground = luminance(colors.foreground);
      const background = luminance(colors.background);
      expect((Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)).toBeGreaterThanOrEqual(4.5);
    });
  });
}

test.describe('small phone with enlarged text', () => {
  test.use({ viewport: { width: 320, height: 844 } });

  test('keeps repository context usable and reflows header navigation and main actions', async ({ page, portal }) => {
    await portal.goto();
    const selector = page.getByRole('combobox', { name: 'Switch repo' });
    await expect(selector).toBeVisible();
    const selectorBox = await selector.boundingBox();
    expect(selectorBox?.width).toBeGreaterThanOrEqual(96);
    expect(selectorBox?.height).toBeGreaterThanOrEqual(44);

    await doubleTextSize(page);
    const brand = await page.locator('.brand').boundingBox();
    const account = await page.locator('.topbar-right').boundingBox();
    if (!brand || !account) throw new Error('Header groups must remain rendered');
    expect(brand.x + brand.width <= account.x + 1 || account.x + account.width <= brand.x + 1
      || brand.y + brand.height <= account.y + 1 || account.y + account.height <= brand.y + 1).toBe(true);
    for (const link of await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link').all()) {
      await expectContentToFit(link);
      const box = await link.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(44);
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }
    await expectContentToFit(page.getByRole('link', { name: 'Read lesson', exact: true }));
    await expectPageWithinViewport(page);

    await portal.goto(`/lesson/${portal.lessons().recommended.id}`);
    await expect(page.getByRole('button', { name: 'Mark read', exact: true })).toBeVisible();
    await doubleTextSize(page);
    await expectContentToFit(page.locator('.reader-header'));
    await expectContentToFit(page.locator('.reader-actions'));
    await expectPageWithinViewport(page);
  });
});
