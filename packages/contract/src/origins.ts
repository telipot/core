// CORS and the auth provider compare `Origin` exactly, so drop any path or trailing slash.
export const appOrigins = (appUrl: string): ReadonlyArray<string> => [new URL(appUrl).origin];
