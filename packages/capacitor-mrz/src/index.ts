// index.ts
import { registerPlugin } from "@capacitor/core";
import type { MrzPlugin } from "./definitions";

const Mrz = registerPlugin<MrzPlugin>("Mrz", {
  web: () => import("./web").then((m) => new m.MrzWeb()),
});

export * from "./definitions";
export { Mrz };
