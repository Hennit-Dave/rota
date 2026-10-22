import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LAUNCH_CYCLE_MS, launchPhase, msUntilHandover } from './launchPhase';
import {
  LAUNCH_FADE_MS,
  LOGO,
  TIMELINES,
  arrangements,
  barBox,
  markSize,
  staticArrangement,
  totalMs,
  type Arrangement,
  type BarName,
  type SwapVariant,
} from './swapTimelines';

/** The Figma frames list every bar as an absolute box; these are those boxes relative to the mark's top-left. */
const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

function boxes(variant: SwapVariant, arrangement: Arrangement) {
  const out = {} as Record<BarName, ReturnType<typeof barBox>>;
  for (const bar of ['top', 'middle', 'bottom'] as const) out[bar] = barBox(variant, bar, arrangement[bar]);
  return out;
}

test('launch timing matches Motion 261:76-78: swap 540 ms, back 540 ms, then a 150 ms fade, about 1.2 s', () => {
  assert.equal(LAUNCH_CYCLE_MS, 1080);
  assert.equal(LAUNCH_FADE_MS, 150);
  assert.equal(totalMs(TIMELINES.launch.steps) + LAUNCH_FADE_MS, 1230);
});

test('loading loops 3.5 s: 600 rest, 500 + 150 + 500 forward, 600 rest, 500 + 150 + 500 back (Motion 261:129-131)', () => {
  assert.equal(totalMs(TIMELINES.loading.steps), 3500);
  assert.equal(TIMELINES.loading.loop, true);
});

test('success is about 0.9 s and settles (no loop, never moves back); empty plays once about 2 s after a 300 ms delay', () => {
  assert.equal(totalMs(TIMELINES.success.steps), 900);
  assert.equal(TIMELINES.success.loop, false);
  assert.equal(TIMELINES.empty.startDelayMs, 300);
  assert.equal(totalMs(TIMELINES.empty.steps), 1950);
  assert.equal(TIMELINES.empty.loop, false);
});

test('success uses the softer ease-out for Move B only', () => {
  const moves = TIMELINES.success.steps.filter((step) => step.kind === 'move');
  assert.deepEqual(
    moves.map((step) => step.kind === 'move' && step.easing),
    ['inOut', 'out'],
  );
});

test('launch, loading and empty end back on the logo arrangement, so the end state matches the static mark', () => {
  for (const variant of ['launch', 'loading', 'empty'] as const) {
    const all = arrangements(TIMELINES[variant].steps);
    assert.deepEqual(all[all.length - 1], LOGO, variant);
  }
});

test('success ends on the swapped arrangement: bar-middle, bar-bottom, bar-top (Motion 261:13)', () => {
  const all = arrangements(TIMELINES.success.steps);
  assert.deepEqual(all[all.length - 1], { top: 3, middle: 1, bottom: 2 });
  assert.deepEqual(staticArrangement('success'), { top: 3, middle: 1, bottom: 2 });
});

test('launch geometry: a 180 x 120 mark, bars 35 tall, row pitch 42.5 (Motion 261:73, frames 261:27-261:35)', () => {
  assert.deepEqual(markSize(1.25), { width: 180, height: 120 });
  assert.deepEqual(boxes('launch', LOGO), {
    top: box(0, 0, 140, 35),
    middle: box(40, 42.5, 140, 35),
    bottom: box(0, 85, 90, 35),
  });
  const all = arrangements(TIMELINES.launch.steps);
  // after Move A (step 1): bar-top (40, 42.5), bar-middle (0, 0)
  assert.deepEqual(boxes('launch', all[1]!).top, box(40, 42.5, 140, 35));
  assert.deepEqual(boxes('launch', all[1]!).middle, box(0, 0, 140, 35));
  // after Move B (step 3): bar-top (0, 85), bar-bottom (40, 42.5); the swapped arrangement
  assert.deepEqual(boxes('launch', all[3]!).top, box(0, 85, 140, 35));
  assert.deepEqual(boxes('launch', all[3]!).bottom, box(40, 42.5, 90, 35));
  assert.deepEqual(boxes('launch', all[3]!).middle, box(0, 0, 140, 35));
});

test('loading and empty geometry: a 72 x 48 mark, bars 14 tall, row pitch 17 (Motion 261:126, frames 261:106, 262:79)', () => {
  assert.deepEqual(markSize(0.5), { width: 72, height: 48 });
  for (const variant of ['loading', 'empty'] as const) {
    assert.deepEqual(boxes(variant, LOGO), {
      top: box(0, 0, 56, 14),
      middle: box(16, 17, 56, 14),
      bottom: box(0, 34, 36, 14),
    });
  }
});

test('success geometry: a 108 x 72 mark, bars 21 tall, row pitch 25.5 (Motion 262:36, frames 262:3, 262:11)', () => {
  assert.deepEqual(markSize(0.75), { width: 108, height: 72 });
  assert.deepEqual(boxes('success', LOGO), {
    top: box(0, 0, 84, 21),
    middle: box(24, 25.5, 84, 21),
    bottom: box(0, 51, 54, 21),
  });
  assert.deepEqual(boxes('success', staticArrangement('success')), {
    top: box(0, 51, 84, 21),
    middle: box(0, 0, 84, 21),
    bottom: box(24, 25.5, 54, 21),
  });
});

test('reduce motion shows the logo arrangement for launch, loading and empty (Motion 261:22)', () => {
  for (const variant of ['launch', 'loading', 'empty'] as const) assert.deepEqual(staticArrangement(variant), LOGO);
});

test('launch rule: it never adds waiting. The instant the session is ready the phase is done, at any point in the animation', () => {
  for (let elapsedMs = 0; elapsedMs <= 6000; elapsedMs += 10) {
    assert.equal(launchPhase({ ready: true, elapsedMs }), 'done', `ready at ${elapsedMs} ms`);
  }
});

test('launch rule: it plays for one cycle while the session restores, then hands over to Loading if restore is still running', () => {
  assert.equal(launchPhase({ ready: false, elapsedMs: 0 }), 'launch');
  assert.equal(launchPhase({ ready: false, elapsedMs: LAUNCH_CYCLE_MS - 1 }), 'launch');
  assert.equal(launchPhase({ ready: false, elapsedMs: LAUNCH_CYCLE_MS }), 'loading');
  assert.equal(launchPhase({ ready: false, elapsedMs: 15_000 }), 'loading');
});

test('the hand-over timer fires at the end of the cycle, never negative', () => {
  assert.equal(msUntilHandover(0), LAUNCH_CYCLE_MS);
  assert.equal(msUntilHandover(400), LAUNCH_CYCLE_MS - 400);
  assert.equal(msUntilHandover(5000), 0);
});
