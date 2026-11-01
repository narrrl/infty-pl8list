// Bakes chrome shapes off the main thread; see chrome-bake.ts.

import { bake, type BakeJob } from "./chrome-bake";

self.onmessage = (e: MessageEvent<BakeJob & { id: number }>) => {
  const pixels = bake(e.data);
  (self as unknown as Worker).postMessage({ id: e.data.id, pixels }, [pixels.buffer]);
};
