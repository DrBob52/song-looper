import { test as base } from '@playwright/test';

/**
 * The page loads Google Fonts from a <link> (the one external host). The tests must not depend on the network, and a
 * failed font request is logged by the browser as a console error, which several tests treat as a failure. So in every
 * context the font stylesheet is answered locally with an empty one: the fallback fonts apply, as they do when Google
 * Fonts is blocked, and nothing leaves the machine. design.spec.ts checks the <link> itself and the blocked case.
 */
export const test = base.extend<{ fontsStubbed: void }>({
  fontsStubbed: [
    async ({ context }, use) => {
      await context.route(/fonts\.googleapis\.com\//, (route) =>
        route.fulfill({ status: 200, contentType: 'text/css', body: '/* Google Fonts is not loaded in the tests */' }),
      );
      await context.route(/fonts\.gstatic\.com\//, (route) => route.fulfill({ status: 204, body: '' }));
      await use();
    },
    { auto: true },
  ],
});

export { expect } from '@playwright/test';
