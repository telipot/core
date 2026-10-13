import { fileURLToPath } from "node:url";

export const openApiFixtures = Object.freeze({
  widgetly: fileURLToPath(new URL("../data/openapi/widgetly.json", import.meta.url)),
  keyed: fileURLToPath(new URL("../data/openapi/keyed.json", import.meta.url)),
  jobs: fileURLToPath(new URL("../data/openapi/jobs.json", import.meta.url)),
});

export type OpenApiFixtureName = keyof typeof openApiFixtures;
