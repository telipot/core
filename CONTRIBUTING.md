# Contributing

Thank you for improving the catalog. Most contributions are one provider file: a vendor's API
described as YAML, with no TypeScript.

1. Read [`catalog/AGENTS.md`](catalog/AGENTS.md): how a provider and its tasks are written, which
   file to copy, and what every task needs before it can be served.
2. Check your change the way the pull request's checks will:

   ```sh
   bun install
   bun run validate
   bun run telipot catalog scan --base origin/main
   bun run test
   ```

3. Sign off every commit (`git commit -s`): it states the [Developer Certificate of
   Origin](https://developercertificate.org), that you may contribute it under this repository's
   [Apache 2.0](LICENSE) licence.
4. Describe a provider from the vendor's own documentation, never from another catalog, and put
   no credential, contact detail or private person's name in any file.

A maintainer reviews and merges. A merged change reaches the hosted gateway when telipot moves its pin
of this repository to it; being in the catalog does not by itself make a task callable on telipot's own
credentials.

Report a security problem privately, through this repository's Security tab ("Report a vulnerability"), not in an issue.
