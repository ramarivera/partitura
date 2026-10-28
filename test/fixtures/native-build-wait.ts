/** Leave cleanup time inside Vitest's five-second live-test deadline. */
export const waitUntil = async (
  ready: () => Promise<boolean>,
  clock = { now: Date.now, pause: () => Bun.sleep(5) },
) => {
  const deadline = clock.now() + 4_500;
  do {
    if (await ready()) return;
    await clock.pause();
  } while (clock.now() < deadline);
  throw new Error("Fixture did not reach expected state");
};
