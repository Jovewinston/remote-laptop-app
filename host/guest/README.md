# Bay sealed Linux guest

Golden Tart image used when `BAY_SANDBOX_BACKEND=vm`.

## What lives where

| Thing | Location |
|-------|----------|
| VM images | Tart’s store (`~/.tart/…`) — names `bay-golden`, `bay-job-<id>` |
| Host SSH key | `~/.bay/vms/ssh/id_ed25519` (baked into golden `bay` user) |
| Job metadata | `~/.bay/vms/jobs/<id>.json` |
| Workspace / deps | **Inside the guest disk** at `/home/bay/workspace` |
| Compute | Lender Mac CPU/RAM via Tart |

No host home mounts. No virtiofs shared folders for the workspace.

## Auth

The guest does **not** use the lender’s Claude Keychain or `HOME`.

Renters authenticate on the Bay Session page (never the lender’s Keychain):

1. **Claude Pro/Max (recommended)** — “Sign in with Claude” opens an OAuth URL from
   `claude auth login` inside the guest; renter pastes the code back into Bay.
2. **API key** — optional fallback; Host injects into `/home/bay/job.env`.

Handoff is ephemeral (not stored in SQLite). Host only pre-seeds `newSessionDefaults`.

## Build

```bash
brew install cirruslabs/cli/tart cirruslabs/cli/sshpass
pnpm --filter @bay/host guest:build
# rebuild: BAY_GOLDEN_FORCE=1 pnpm --filter @bay/host guest:build
```

Base image default: `ghcr.io/cirruslabs/ubuntu:latest` (admin/admin).

## Guest agent

- `bay-agent/healthz.js` — starts Yep on `127.0.0.1:3400`, serves `GET :3411/healthz`
- systemd unit `bay-agent.service`
- Job config injected over SSH into `/home/bay/job.env` at provision time
