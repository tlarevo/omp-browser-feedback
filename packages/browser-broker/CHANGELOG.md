# Changelog

## [16.1.23] - 2026-07-04

### Added

- Local browser feedback broker: WebSocket/HTTP server with a session
  registry and an in-memory feedback store (bounded events per channel),
  plus a screenshot store for picker captures.
- Port/host resolution with configurable port ranges, bearer-token auth,
  and a `/api/health` endpoint.
- Discovery file at `~/.omp/browser-broker.json` (base URL, auth token,
  pid, started-at) so the OMP extension and Chrome extension can find a
  running broker without manual configuration.
