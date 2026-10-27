import { v3HttpFixturesFirst } from "./effect-v3-http-first.js";
import { v3HttpFixturesSecond } from "./effect-v3-http-second.js";

export const v3HttpFixtures = [
  ...v3HttpFixturesFirst,
  ...v3HttpFixturesSecond,
] as const;
