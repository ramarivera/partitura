import { readFileSync } from "node:fs";
import { expect, it } from "@effect/vitest";
import { t3TestPorts } from "./fixtures/t3-ports.js";

const first = t3TestPorts();
const second = t3TestPorts();
it("leases disjoint blocks for concurrent fixtures outside the outgoing connection range", () => {
  const a = first(8),
    b = second(8);
  expect(a + 8 <= b || b + 8 <= a).toBe(true);
  const ephemeral = Number(
    readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8")
      .trim()
      .split(/\s+/u)[0],
  );
  expect(a + 8).toBeLessThanOrEqual(ephemeral);
  expect(b + 8).toBeLessThanOrEqual(ephemeral);
});
