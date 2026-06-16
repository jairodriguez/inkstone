# Contributing to Inkstone

Thanks for your interest in contributing! Inkstone is a local-first MCP memory server, and we welcome improvements.

## Getting Started

```bash
git clone https://github.com/jairodriguez/inkstone.git
cd inkstone
npm install
npm run build
```

## Development

```bash
npm run dev      # watch mode (tsc --watch)
npm test         # run tests
npm run start    # start MCP server
```

## Architecture

Inkstone has five major subsystems:

| Subsystem | Location | Purpose |
|-----------|----------|---------|
| **Storage** | `src/db/` | SQLite schema, FTS5 full-text search, migrations |
| **Memory** | `src/mcp/` | MCP server with 15+ tools for agents |
| **Dream** | `src/dream/` | 14-step maintenance cycle (decay, consolidation, archival) |
| **Ingest** | `src/ingest/` | Session and file ingestion pipelines |
| **Graph** | `src/graph/` | Entity relations and traversal |

## Submitting Changes

1. Fork the repo and create a feature branch
2. Make your changes — keep commits focused
3. Ensure `npm run build` and `npm test` pass
4. Open a PR with a clear description of what and why

## Code Style

- TypeScript strict mode
- No external runtime deps beyond `@modelcontextprotocol/sdk` and `zod`
- Prefer SQLite-native operations over application-layer logic
- Every new tool needs a test

## Reporting Issues

Use GitHub Issues. Include:
- Inkstone version (`node dist/index.js --version`)
- SQLite engine (better-sqlite3 or sql.js)
- Steps to reproduce
- Expected vs actual behavior
