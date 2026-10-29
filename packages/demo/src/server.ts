import type { RequestListener } from "node:http";
import { createDemoApp, type DemoAppOptions } from "./app.js";
import { seedDemo, type DemoBrain, type SeedOptions } from "./seed.js";

const DAY_MS = 86_400_000;

export interface DemoServerOptions extends DemoAppOptions {
  seed?: (options: SeedOptions) => Promise<DemoBrain>;
  now?: () => Date;
  setTimer?: (run: () => void, ms: number) => unknown;
  log?: (line: string) => void;
}

/** Milliseconds from `now` to the next midnight UTC. */
export function untilMidnight(now: Date): number {
  return DAY_MS - (now.getTime() % DAY_MS);
}

/**
 * Seeds the demo store and serves it, then seeds a fresh copy every
 * midnight UTC and swaps it in, so dates stay current and every visitor's
 * Accept and Dismiss clicks are cleared. A reseed that fails leaves the
 * current copy serving and tries again the next night.
 */
export async function startDemo(options: DemoServerOptions): Promise<{ handler: RequestListener; current: () => DemoBrain }> {
  const seed = options.seed ?? seedDemo;
  const now = options.now ?? (() => new Date());
  const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms).unref());
  const log = options.log ?? ((line) => console.log(line));

  let brain = await seed({ now: now() });
  let app = createDemoApp(brain, options);
  const describe = (b: DemoBrain) => `${b.sources.length} systems, ${b.sources.reduce((n, s) => n + s.ingested, 0)} events, ${b.recommendations.length} recommendations`;
  log(`demo seeded: ${describe(brain)}`);

  const schedule = () =>
    setTimer(() => {
      seed({ now: now() })
        .then((fresh) => {
          brain = fresh;
          app = createDemoApp(fresh, options);
          log(`demo reseeded: ${describe(fresh)}`);
        })
        .catch((error: unknown) => log(`demo reseed failed, keeping yesterday's copy: ${error instanceof Error ? error.message : String(error)}`))
        .finally(schedule);
    }, untilMidnight(now()));
  schedule();

  return { handler: (req, res) => app(req, res), current: () => brain };
}
