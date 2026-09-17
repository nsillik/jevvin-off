# GRWM report — jevvin-off

- Tool: omp-grwm 0.1.0 · catalog 0.1.0

- Repository: `jevvin-off`
- Git: branch `main`
- Scanned: 2026-09-17T15:04:05.298Z

## What was created

| File | Bytes | SHA-256 | Invariants |
|---|---|---|---|
| `lsp.json` | 341 B | `55cfd79dcaec` | json-parse, schema, secret-scan, absolute-path |
| `.omp/grwm/state.json` | 5.5 KiB | `014064816a66` | n/a |

## What was refused

- `AGENTS.md` (context-file): invariant failed: absolute-path (absolute path leaked: /Users/nsillik)

## Decisions

- typescript-language-server 6.0.0 needs a JavaScript tsserver. This repo pins TypeScript 7.0.2 (the native port), which ships no lib/tsserver.js, so the server would exit with 'Could not find a valid TypeScript installation'. Fixed this session by installing typescript@5.9.3 nested under the global language-server package; the workspace's TypeScript 7.0.2 pin is untouched and `bun run typecheck` still uses it. Consequence: LSP features are served by TypeScript 5.9.3 and can disagree with the workspace compiler.
- No MCP server is proposed: there is no UI (playwright), no git remote or issue tracker (github), no Sentry usage in evidence, omp already has filesystem and git access, and the only dependency is covered by the vendored typesafe-ai skill (context7 would add network plus query telemetry for one pre-1.0 SDK).
- No subagent is proposed: the curated catalog is empty, and the `task` tool already covers exploration in a 15-file repo.
- No skill is proposed: the curated entries (changelog, release-checklist) assume releases or PR titles, and this repo has two commits, no remote and no release process.
- `bun run at-proto` exists in package.json but the scan did not record it in the commands list, so it is not selected as a command; it is described in extraNotes instead.
- No lint or format tooling exists in this repo (no eslint/prettier/biome config or dependency), so no lint or format command was selected.

- Instruction file: `AGENTS.md`
- LSP: 1 server(s) → `lsp.json`

## Probe ledger

Read-only evidence gathered this session. `[verified]` tags in created files cite these rows.

| Probe | Result | Evidence |
|---|---|---|
| `bun` | ok | /Users/nsillik/.local/share/mise/shims/bun |
| `bun --version` | ok | 1.4.2 |
| `typescript-language-server` | failed | not found on PATH or in project-local bin directories |
| `typescript-language-server --version` | failed | typescript-language-server did not resolve; not executing |
| `vscode-json-language-server` | failed | not found on PATH or in project-local bin directories |
| `npx` | ok | /Users/nsillik/.local/state/fnm_multishells/10079_1789653044935/bin/npx |
| `npx --version` | ok | 11.16.0 |
| `uvx` | ok | /opt/homebrew/bin/uvx |
| `marksman` | failed | not found on PATH or in project-local bin directories |
| `package.json` | ok | valid JSON · keys: name, private, type, scripts, dependencies, devDependencies |
| `tsconfig.json` | ok | valid JSON · keys: compilerOptions, include |
| `skills-lock.json` | ok | valid JSON · keys: version, skills |
| `examples` | ok | 2 entries: at-proto/, quickstart.ts |
| `**/*.test.ts` | failed | rejected by the probe allowlist: `file` contains shell metacharacters: **/*.test.ts |
| `git log --no-merges --pretty=%s -n 20` | ok | Initial commit |
| `git status --porcelain` | ok | exit 0 |
| `git config --get remote.origin.url` | failed | Command failed: git config --get remote.origin.url |
| `typescript-language-server` | ok | /Users/nsillik/.local/state/fnm_multishells/10079_1789653044935/bin/typescript-language-server |
| `typescript-language-server --version` | ok | 6.0.0 |
| `typescript-language-server --help` | ok | Usage: typescript-language-server [options] |
| `tsserver` | failed | not found on PATH or in project-local bin directories |

## Gaps recorded at baseline

- **high** no-instructions: No AGENTS.md, CLAUDE.md, or harness instruction file anywhere omp looks.
- **medium** no-lsp: No LSP server configured; omp will fall back to its built-in auto-detection only.
- **medium** no-subagents: No project subagents defined.
- **medium** no-ci: No CI configuration found; required checks cannot be documented from evidence.

## Discovered configuration

Every source the harness would load, in precedence order, with the provider and priority that resolve collisions. This is the per-machine record: the committed `AGENTS.md` lists only what lives in the repository.

**Instructions**
- nothing found

**Rules**
- nothing found

**Skills**
- `~/.omp/agent/skills/herdr/SKILL.md` — native, priority 100, user scope
- `.agents/skills/typesafe-ai/SKILL.md` — agents, priority 70, project
- `~/.agents/skills/find-skills/SKILL.md` — agents, priority 70, user scope
- `~/.agents/skills/tavily-search/SKILL.md` — agents, priority 70, user scope
- `~/.claude/plugins/cache/temp_local_1789653081600_iy2xdj/skills/typesafe-ai/SKILL.md` — claude-plugins, priority 70, user scope; needs `enabledProviders`; not loaded — shadowed by agents `.agents/skills/typesafe-ai/SKILL.md`
- `~/.claude/plugins/marketplaces/typesafe-ai/skills/typesafe-ai/SKILL.md` — claude-plugins, priority 70, user scope; needs `enabledProviders`; not loaded — shadowed by agents `.agents/skills/typesafe-ai/SKILL.md`

**Subagents**
- nothing found

**MCP servers**
- `~/.claude.json` — claude, priority 80, user scope; needs `enabledProviders`
- `~/.config/opencode/opencode.json` — opencode, priority 55, user scope; needs `enabledProviders`

**LSP servers**
- nothing found

**Hooks**
- nothing found

**Settings**
- `~/.omp/agent/config.yml` — native, priority 100, user scope
- `~/.claude/settings.json` — claude, priority 80, user scope; needs `enabledProviders`

**Extensions**
- `~/.omp/agent/extensions/herdr-omp-agent-state.ts` — native, priority 100, user scope

## Next steps

- Commit the created files (or don't — GRWM never stages anything).
- Newly installed tools, hooks, or extension modules need a session **restart**; skills and slash commands refresh with `/reload-plugins`.
- Re-run `/grwm` to re-scan; `/grwm scan` dumps the inventory without interviewing.

> The repository was left with a dirty working tree on purpose: GRWM performs no git operations.
