// index.ts
import { registerPlugin } from "@capacitor/core";
import type { Pdf417Plugin } from "./definitions";

const Pdf417 = registerPlugin<Pdf417Plugin>("Pdf417", {
  web: () => import("./web").then((m) => new m.Pdf417Web()),
});

export * from "./definitions";
export { Pdf417 };
