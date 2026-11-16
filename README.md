# github-core-clone-01 — a standalone GitHub-compatible git forge

[![make.fun bounty](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/FadliAR/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/FadliAR/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

One Node 22 process, standard library only, no UI and no outside service.
It serves four surfaces from its own in-memory store:

- **Git smart HTTP** at `/{owner}/{repo}.git` — upload-pack protocol v2
  (capability advertisement, `ls-refs`, `fetch` with shallow support) and
  receive-pack protocol v0 with report-status, side-band-64k and
  delete-refs. Clone, fetch and push work with a real git client; every
  update must fast-forward.
- **REST v3** under `/api/v3` — repositories, branches, commits, contents,
  git data (refs / trees / blobs), labels, issues and comments, pull
  requests with files, commits and squash merges, milestones and search.
  Bearer-token auth: no or wrong token is 401, a repository under another
  owner is 404, errors are JSON with a `message`, and every reply carries
  an `X-GitHub-Request-Id` header.
- **GraphQL v4** at `/api/graphql` — queries and mutations of the shape
  `gh` and github-mcp-server send, connections with ordering and state
  filters, node ids, search, and introspection for `Issue`, `PullRequest`,
  `Repository` and the `SearchType` enum.
- **MCP** at `/mcp` — JSON-RPC 2.0 over streamable HTTP, speaking revision
  2026-07-28 via `server/discover` and the classic `initialize` handshake.
  Tools: `create_repo`, `get_repo`, `list_repos`, `create_issue`,
  `list_issues`, `get_issue`, `create_pull_request`, `merge_pull_request`.
  The tools act on the same store as REST, so ids are stable across
  surfaces.

## Lifecycle

The process binds an ephemeral port (port 0, never 8080), POSTs
`{"port": <port>}` to `$MAKEFUN_ENV_URL/register`, then polls
`$MAKEFUN_ENV_URL/done` and exits 0 when the suite says it is done.
Requests carry `Authorization: Bearer <$MAKEFUN_SHOP_TOKEN>`.

State is deterministic: ids come from counters and timestamps from a
logical clock, so two runs that receive the same requests produce the
same responses.

## Running locally

```sh
node main.ts
```

With no `MAKEFUN_ENV_URL` set the forge simply serves until stopped,
which is convenient for smoke-testing with a real git client.

This project is an entry to the
[github-core-clone-01 bounty on make.fun](https://make.fun/bounty/github-core-clone-01).

## License

MIT — see [LICENSE](LICENSE).
