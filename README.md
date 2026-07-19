# Bay

Invite-only marketplace to **borrow a friend's Mac** for **Claude Code** or **Codex**.

- **Website** — sign up, browse Mac cards, reserve, connect
- **Bay Host** — runs on the lender Mac (health check, Tailscale status, sandbox sessions)
- **Bay Connect** — one-click SSH tunnel for the renter

Not the same as [Airlift](https://github.com/ojaskandy/airlift) — inspired by it, built as a new product with listings, schedules, and sandbox wipe.

## Quick start

```bash
pnpm install
pnpm --filter @bay/shared build
pnpm db:seed
pnpm dev:api    # http://127.0.0.1:8788
pnpm dev:web    # http://127.0.0.1:3200
# or: bash scripts/dev.sh
```

Demo invite codes: `BAY-FRIENDS` or `BAY-DEMO`.

Open **http://127.0.0.1:3200** → Sign up with an invite.

### Lend a Mac

1. Website → **Lend** → **Register this account’s Mac** → copy host token  
2. Run Bay Host (guided wizard + live Tailscale/power checks):

```bash
pnpm --filter @bay/host start
# opens http://127.0.0.1:3410
pnpm --filter @bay/host run doctor   # optional CLI health dump
```

3. In the Host UI: paste token → **Install Tailscale** if needed → wait for ✓ Connected → **Turn Available on**  
4. Keep the Mac **plugged in** (lid closed usually sleeps the machine)

Your Mac then appears as a Borrow card (chip, RAM, disk, online, charger, free hours).

### Borrow a Mac

1. **Borrow** → pick a card → **Claude** or **Codex** → hours → **Reserve**  
2. Session page shows live status (network → preparing Mac → open agent)  
3. **Start session** → **Connect** (copies a connect command / opens `bay://` link)

```bash
./scripts/connect.sh <reservationId> <connectToken>
# same as: pnpm --filter @bay/connect start -- <reservationId> <connectToken>
```

Bay Connect checks Tailscale, opens an SSH tunnel to the lender cockpit, and launches the browser. Sign into **your** Claude/Codex account there.

**End session** asks the Host app to wipe the job (folder sandbox or Tart VM — see below).

## Ports

| Service | Port |
|---------|------|
| Web | 3200 |
| API | 8788 |
| Host UI | 3410 |
| Cockpit (Yep Anywhere) | 3400 |

## Sandbox backends

### Folder (default)

`BAY_SANDBOX_BACKEND=folder` (or unset)

- Jobs under `~/.bay/sandbox/jobs/<id>` on the lender Mac
- Uses lender Claude Keychain/HOME for auth (convenient demo, weaker isolation)

### Sealed Linux VM (Tart)

Apple Silicon lender Mac:

```bash
brew install cirruslabs/cli/tart
brew install cirruslabs/cli/sshpass   # for unattended golden build
pnpm --filter @bay/host guest:build  # clones Ubuntu → installs tools → bay-golden
export BAY_SANDBOX_BACKEND=vm
pnpm --filter @bay/host start
```

- Per reservation: `tart clone bay-golden bay-job-<id>` → start guest → SSH-forward `127.0.0.1:3400` → same Connect UX
- Workspace lives on the **guest virtual disk** (`/home/bay/workspace`) — not lender Desktop/Documents
- **No lender HOME/Keychain mount** — renter signs into Claude/Codex inside Yep
- Wipe: `tart stop` + `tart delete` the job VM
- Caps (optional in `~/.bay/host.json`): `vmCpu` (default 4), `vmMemoryMb` (default 8192)

Smoke (no image download): `pnpm --filter @bay/host smoke:sandbox`

## Security (MVP)

- Cockpit is reached only via Tailscale + SSH tunnel (host loopback `:3400`)
- Invite-only signup
- **Folder mode:** soft isolation under `~/.bay/sandbox`
- **VM mode:** sealed Linux guest; renter auth only; destroy VM on end

## Monorepo

```
apps/web      Next.js UI
apps/api      Hono + SQLite control plane
packages/shared
host/         Bay Host (lender) — folder + Tart VM sandboxes
host/guest/   Golden Linux image build + bay-agent
connect/      Bay Connect (renter tunnel)
```
