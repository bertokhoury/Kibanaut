# Changelog

## 0.1.0

First release.

- Full-screen TUI with Elastic-themed highlighting, live lint, contextual completion, results table, record view, history, and meta commands.
- `init` wizard storing credentials in the macOS Keychain, Secret Service, or a 0600 file; password-to-API-key exchange.
- CLI: `query`, `lint` (text, JSON, SARIF, GitHub), `fmt`, `complete`, `schema`, `docs`, `config`, `completion`.
- Kibana console-proxy transport (default) and direct Elasticsearch transport with async polling.
- 16 lint rules, column-flow tracking, function signatures synced from Elasticsearch v9.4.0.
- Demo backend for trying the tool without a cluster; headless frame capture for screenshots and tests.
