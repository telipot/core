import { Schema } from "effect";
import { Provider } from "./schema";

// Beside the provider files in the catalog folder; each names it in its first line.
export const providerSchemaFile = "provider.schema.json";
export const schemaModeline = `yaml-language-server: $schema=../${providerSchemaFile}`;

// What an editor checks a provider file against as it is typed. Cross-file rules and price
// rules are not in it, so `telipot catalog validate` stays the authority.
export const providerJsonSchema = () => {
  const { schema, definitions } = Schema.toJsonSchemaDocument(Provider, {
    onExcessProperty: "error",
  });

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "telipot provider file",
    ...schema,
    $defs: definitions,
  };
};
