import { fileURLToPath } from "node:url";

export const catalogFixtures = Object.freeze({
  clean: fileURLToPath(new URL("../data/catalog/clean/", import.meta.url)),
  "clean-input": fileURLToPath(new URL("../data/catalog/clean-input/", import.meta.url)),
  refused: fileURLToPath(new URL("../data/catalog/refused/", import.meta.url)),
  "refused-fx": fileURLToPath(new URL("../data/catalog/refused-fx/", import.meta.url)),
  "refused-search": fileURLToPath(new URL("../data/catalog/refused-search/", import.meta.url)),
  gateway: fileURLToPath(new URL("../data/catalog/gateway/", import.meta.url)),
  oauth: fileURLToPath(new URL("../data/catalog/oauth/", import.meta.url)),
  paged: fileURLToPath(new URL("../data/catalog/paged/", import.meta.url)),
  verify: fileURLToPath(new URL("../data/catalog/verify/", import.meta.url)),
});

export type CatalogFixtureName = keyof typeof catalogFixtures;
