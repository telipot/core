<p align="center">
  <a href="https://telipot.com">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="../../.github/assets/logo-dark.png">
      <img alt="telipot" src="../../.github/assets/logo-light.png" width="236">
    </picture>
  </a>
</p>

<h3 align="center">The telipot command line.<br>Find, price and run any catalog task from your shell.</h3>

<p align="center">
  <a href="../../LICENSE"><img alt="Licence: Apache 2.0" src="https://img.shields.io/badge/licence-Apache%202.0-4A4D4A?style=flat-square"></a>
  <img alt="Status: pre-release" src="https://img.shields.io/badge/status-pre--release-FF5A1F?style=flat-square">
</p>

<p align="center">
  <a href="https://telipot.com">Website</a> ·
  <a href="https://docs.telipot.com">Docs</a> ·
  <a href="https://telipot.com/catalog">Catalog</a> ·
  <a href="../..">Core</a> ·
  <a href="../../skills/telipot/SKILL.md">Skill</a>
</p>

<br>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../.github/assets/carrier-hello-dark.png">
  <img alt="The Carrier, telipot's character, saying hello" src="../../.github/assets/carrier-hello.png" width="168" align="right">
</picture>

`telipot` puts the whole catalog one command away. Say what you need in plain words, see every task that can do it with its price and whose account pays, then run one. The vendor's answer comes back unchanged on stdout, ready for a pipe.

It is the same API your agent calls through the skill file, the MCP server and the SDK, on the same token.

<br clear="right">

> **Pre-release.** `telipot` is not published yet. Watch [telipot/core](https://github.com/telipot/core) for the first release.

## Quick start

```bash
telipot login
telipot discover 'Hacker News stories about agent tools'
telipot inspect hackernews.news.search
telipot run hackernews.news.search --input-json '{"query":"agent tools"}' --quote
telipot run hackernews.news.search --input-json '{"query":"agent tools"}'
```

`login` shows a device code. Approve it on the dashboard, and the CLI keeps the organization token it is traded for. `--quote` prints the price and runs nothing.

## Commands

| Command                                  | Does                                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------------------- |
| `telipot login`                          | Shows a device code to approve on the dashboard, then keeps the organization's token   |
| `telipot discover <sentence>`            | Lists the tasks for a job, each with its price and whose credential would pay          |
| `telipot inspect <task>`                 | Prints a task's full schema, price and identity as JSON, without calling the provider  |
| `telipot run <task> --input-json <json>` | Runs a task: the vendor's answer on stdout; the call id, identity and charge on stderr |
| `telipot connect <provider>`             | Prints a connect link for your organization, or for an end user with `--as user:<id>`  |

### Act as someone

```bash
telipot run google-calendar.events.list --as user:ana --input-json '{"calendarId":"primary"}'
telipot connect google-calendar --as user:ana --redirect-uri https://your-app.example/connected
```

`--as` names the principal a call runs as. A task that acts in an end user's account is refused without one, never guessed. An end user's connect link returns to `--redirect-uri`, which must be on your organization's redirect allowlist.

### Pin a catalog version

```bash
telipot run hackernews.news.search --catalog-version 2026-10-04 --input-json '{"query":"agent tools"}'
```

A run uses the version served now unless you pin one. A pinned version the gateway no longer serves is refused before anything runs.

## In scripts

- **stdout is data.** The vendor's answer is printed as JSON, with every character that could rewrite a terminal escaped, so `| jq` reads it.
- **stderr is the receipt.** The call id, the identity the call ran as and its charge.
- **No colour in pipes.** Colour appears only on a terminal, and never when `NO_COLOR` is set.

## Configuration

| Setting                         | Effect                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `TELIPOT_TOKEN`                 | The token to use. It wins over the stored one, so a script can run on a token of its own                     |
| `TELIPOT_API_URL`               | Points every command at another gateway                                                                      |
| `~/.config/telipot/credentials` | Where `login` keeps the token (`$XDG_CONFIG_HOME/telipot/credentials` when set), readable by its owner alone |

## For catalog contributors

`telipot catalog` runs the same checks as `bun run catalog` in this repository, on the `@telipot/catalog` it ships with:

| Command                                          | Does                                                                                                                    |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `telipot catalog validate [dir]`                 | Checks every provider file against the schema and the cross-file rules, offline                                         |
| `telipot catalog new <provider> --openapi <url>` | Writes a provider's file header and its generated extended file from the vendor's OpenAPI document                      |
| `telipot catalog verify <provider>`              | Calls each task's test request with your own key, stopping before `--budget` when you give one, and records what passed |
| `telipot catalog scan --base <commit>`           | Refuses a change that adds a credential, or a contact detail to an example                                              |
| `telipot catalog drift [dir]`                    | Names a task whose route moved in the vendor's published spec                                                           |
| `telipot catalog schema`                         | Prints the JSON Schema an editor checks a provider file against, as `catalog/provider.schema.json` holds it             |

How to add or fix a provider is in the [repository README](../../README.md#contribute).

## Contribute

Bug reports and pull requests are welcome. A refusal from the gateway is printed with its `detail` and, when there is one, the link that fixes it; if a message leaves you stuck, that is a bug, so open an issue with the command and the output.

## Licence

[Apache 2.0](../../LICENSE).

<br>

<p align="center">
  <sub>Made by <a href="https://missing.studio">missing studio</a> · <a href="mailto:hello@missing.studio">hello@missing.studio</a></sub>
</p>
