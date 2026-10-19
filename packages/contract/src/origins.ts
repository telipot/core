import { Config } from "effect";

// CORS and the auth provider compare `Origin` exactly, so drop any path or trailing slash.
export const appOrigins = (appUrl: string): ReadonlyArray<string> => [new URL(appUrl).origin];

// `APP_URL`'s origins as a setting, so a malformed one fails the start naming it.
export const appOriginsConfig = Config.map(Config.URL("APP_URL"), (url): ReadonlyArray<string> => [
  url.origin,
]);
