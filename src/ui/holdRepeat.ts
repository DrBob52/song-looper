/**
 * Make a stepper button repeat while it is held, faster the longer it is held.
 *
 * A plain click (or Enter/Space on the focused button) is one step: `step(1)`. Holding the pointer down for 450 ms
 * starts repeating, from about 7 steps a second up to about 25, and after a second and again after three seconds
 * each step is 10 and then 100 times bigger, so that a count that goes up to 9,999 can be crossed.
 */
export function holdRepeat(button: HTMLButtonElement, step: (size: number) => void): void {
  let timer = 0;
  let held = false;
  let startedAt = 0;
  let interval = 140;

  const sizeNow = (): number => {
    const held = performance.now() - startedAt;
    return held > 3000 ? 100 : held > 1000 ? 10 : 1;
  };
  const tick = (): void => {
    if (button.disabled) return stop();
    step(sizeNow());
    interval = Math.max(40, interval * 0.93);
    timer = window.setTimeout(tick, interval);
  };
  const stop = (): void => {
    window.clearTimeout(timer);
    timer = 0;
  };

  button.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || button.disabled) return;
    held = false;
    interval = 140;
    startedAt = performance.now();
    stop();
    timer = window.setTimeout(() => {
      held = true;
      startedAt = performance.now() - 450;
      tick();
    }, 450);
  });
  button.addEventListener('pointerup', () => {
    stop();
    // the click that ends a hold follows at once; if none does, forget the hold
    window.setTimeout(() => (held = false), 80);
  });
  for (const ev of ['pointercancel', 'pointerleave'] as const) {
    button.addEventListener(ev, () => {
      stop();
      held = false;
    });
  }
  button.addEventListener('click', (e) => {
    if (held) {
      // the hold already did its steps; the click that ends it is not one more
      held = false;
      e.preventDefault();
      return;
    }
    step(1);
  });
}
