# Security

Report a vulnerability privately, through this repository's Security tab: **Report a vulnerability**. Do not open an issue or a pull request for it. If you cannot use GitHub, write to hello@missing.studio.

Say what you found, the commit or package version, and the steps that show it. We reply in the same advisory, and credit you when the fix is published unless you ask us not to.

## What this covers

- The catalog: a provider file that would send a credential somewhere it should not go, or an example that holds a secret or a person's contact details.
- The packages: `@telipot/catalog`'s request binding and send, the contract, the SDK and the `telipot` CLI.
- The skill file, where its instructions would leak a token or run something the caller did not ask for.

A problem in the hosted service at telipot.com, such as the API, the dashboard or the connect pages, goes the same way. Only test against your own organization and your own accounts.

A provider file is data, but it decides where a credential is sent, so a change to a `base_url`, an OAuth URL or an auth scheme is reviewed as security work.
