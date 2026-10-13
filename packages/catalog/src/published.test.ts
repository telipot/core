import { assert, describe, it } from "@effect/vitest";
import { Result } from "effect";

import { publishedRoutes } from "./published";

const failure = (read: ReturnType<typeof publishedRoutes>) =>
  Result.isFailure(read) ? read.failure : assert.fail("the document was read");

describe("publishedRoutes", () => {
  it("says an OpenAPI server is not a URL, and skips one that is not http", () => {
    const openapi = (url: string) =>
      JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Vendor" },
        servers: [{ url }],
        paths: { "/a": { get: {} } },
      });
    assert.include(
      failure(publishedRoutes(openapi("https://bad host"), "https://vendor.test/openapi.json")),
      "not a URL",
    );
    assert.deepStrictEqual(
      publishedRoutes(openapi("wss://vendor.test/v1"), "https://vendor.test/openapi.json"),
      Result.succeed([]),
    );
  });

  it("says a Swagger or Discovery document's server is not a URL, rather than throw", () => {
    const swagger = { swagger: "2.0", host: "bad host", paths: { "/a": { get: {} } } };
    assert.include(
      failure(publishedRoutes(JSON.stringify(swagger), "https://vendor.test/swagger.json")),
      "not a URL",
    );
    const discovery = {
      discoveryVersion: "v1",
      rootUrl: "not a url",
      servicePath: "v1/",
      resources: { items: { methods: { list: { httpMethod: "GET", path: "items" } } } },
    };
    assert.include(
      failure(publishedRoutes(JSON.stringify(discovery), "https://vendor.test/discovery.json")),
      "not a URL",
    );
  });
});
