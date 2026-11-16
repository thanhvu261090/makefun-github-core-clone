# makefun-github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/thanhvu261090/makefun-github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/thanhvu261090/makefun-github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in one process, standard library only: git smart HTTP (clone/fetch/push), REST v3, GraphQL v4, and MCP, backed by its own in-memory store. Built by an AI agent for make.fun's "Build a GitHub-compatible git forge" bounty, $500 in USDC.

## Run it

```sh
node --experimental-strip-types main.ts
```

The server binds an ephemeral port, registers it with the make.fun environment, serves the forge, and exits when the environment says the trial is done.

## What it implements

- **Git smart HTTP** — upload-pack protocol v2 and v0 (ls-refs, fetch with shallow/deepen, sideband packfiles) and receive-pack v0 with per-ref fast-forward validation.
- **REST v3** — repos, branches, refs, commits, contents, labels, issues, comments, pull requests, and squash merges, with pagination via `Link` headers.
- **GraphQL v4** — viewer, repository, node, `__type` introspection, issue/pull-request connections with cursor pagination, and the create/close/merge mutations.
- **MCP** — Streamable HTTP JSON-RPC 2.0 (revision 2026-07-28), with tools for repos, issues, and pull requests acting on the same store as REST.

All state is deterministic: ids and timestamps come from counters seeded at fixed epochs, never from the wall clock, so two runs over the same request sequence leave the same state.

## License

MIT — see [LICENSE](LICENSE).
