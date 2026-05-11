# Version Monitor

A self-hosted web app that shows installed versions of your self-hosted services vs. their latest GitHub releases — styled like Uptime Kuma's status grid.

![Status grid with green/red indicators per service](https://placehold.co/800x400/0d1117/3fb950?text=Version+Monitor)

## Features

- **Status grid** — dark theme, one card per service; green = up to date, yellow = update available, red = status unknown
- **Two version sources** — HTTP endpoint (JSON key or template) or manual input via the UI
- **GitHub releases** — fetches latest release once per day (configurable); no token needed for typical setups
- **Telegram notifications** — single message listing outdated services and fetch failures, sent on the same schedule as the version check
- **Settings UI** — add, edit, and delete services without touching `services.yaml` by hand
- **Persistent manual versions** — stored in SQLite, survive restarts
- **`/health` endpoint** — for monitoring the monitor (Uptime Kuma, etc.)
- **Systemd-native** — no Docker; runs as a dedicated `vmonitor` user in a Proxmox LXC or any Debian/Ubuntu host
- **GitHub Actions CI/CD** — lint on every push, SSH deploy to multiple hosts on merge to `main`

## Quick Start

### 1. Clone

```bash
git clone https://github.com/ylei0910/version-monitor.git
cd version-monitor
```

### 2. Configure

```bash
cp .env.example .env
cp services.yaml.example services.yaml
```

Edit `.env`:

```env
TELEGRAM_BOT_TOKEN=your_bot_token_here
TELEGRAM_CHAT_ID=your_chat_id_here
GITHUB_CHECK_INTERVAL_MINUTES=1440   # once per day; 0 = disable scheduler
```

Edit `services.yaml` (or use the Settings panel in the UI):

```yaml
services:
  - name: Gitea
    github: go-gitea/gitea
    version_url: "http://192.168.1.10:3000/api/v1/version"
    version_key: "version"

  - name: Immich
    github: immich-app/immich
    version_url: "http://192.168.1.11:2283/api/server/version"
    version_template: "{major}.{minor}.{patch}"

  - name: Vaultwarden
    github: dani-garcia/vaultwarden
    # no version_url — set version manually in the UI
```

### 3. Run locally

```bash
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8080
```

Open [http://localhost:8080](http://localhost:8080).

## Proxmox LXC / Debian Install

Run as root on the LXC:

```bash
# From a local copy
bash setup.sh

# Or with a repo URL
REPO_URL=https://github.com/ylei0910/version-monitor.git bash setup.sh
```

The script will:
- Install Python and git
- Create a `vmonitor` system user
- Set up a virtualenv at `/opt/version-monitor/venv`
- Generate an SSH keypair and print the public key for CI/CD
- Install and enable the systemd service on port **8080**

View logs:

```bash
journalctl -u version-monitor -f
```

## CI/CD (GitHub Actions)

Two workflows are included:

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` | Every push / PR | Syntax check + ruff lint |
| `deploy.yml` | Push to `main` | Runs `deploy.sh` on each registered self-hosted runner |

Deployment uses **self-hosted runners** — the runner process on each LXC polls GitHub for jobs, so no ports need to be exposed.

### Setup

1. Run `setup.sh` on each LXC (see [Proxmox LXC / Debian Install](#proxmox-lxc--debian-install)).  
   Supply a registration token to register the runner automatically:
   ```bash
   REPO_URL=https://github.com/ylei0910/version-monitor \
   RUNNER_TOKEN=<token_from_github> \
   RUNNER_LABEL=lxc-home \
   bash setup.sh
   ```
   Get the token from: **GitHub repo → Settings → Actions → Runners → New self-hosted runner**

2. Add a repository variable named **`RUNNER_LABELS`** (Settings → Variables):
   ```json
   ["lxc-home", "lxc-office"]
   ```
   Each entry is the `RUNNER_LABEL` you set when running `setup.sh` on that host.  
   If `RUNNER_LABELS` is not set, the workflow falls back to `["self-hosted"]` (any available runner).

Every push to `main` will deploy to all listed runners in parallel. A failure on one host does not block the others.

`services.yaml` and `.env` are gitignored — they survive `git pull` on each host.

## `services.yaml` Reference

| Field | Required | Description |
|---|---|---|
| `name` | Yes | Display name (must be unique) |
| `github` | No | `owner/repo` — used to fetch latest release |
| `version_url` | No | HTTP endpoint to fetch installed version from |
| `version_key` | No | Dot-notation path into JSON response, e.g. `server.version` |
| `version_template` | No | Template with JSON field names, e.g. `{major}.{minor}.{patch}` |

If neither `version_url` nor `version_key`/`version_template` is set, the service uses **manual input** via the UI.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | **Required.** From [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_CHAT_ID` | — | **Required.** Your chat/group ID |
| `GITHUB_CHECK_INTERVAL_MINUTES` | `1440` | Check interval in minutes. `0` disables the scheduler |
| `GITHUB_TOKEN` | — | Optional. Only needed for very short intervals or many services |

## Telegram Notification Format

```
Version Monitor — 2026-05-10 09:00 UTC

Updates available:
• Immich: 1.100.0 → 1.102.0
• Vaultwarden: 1.30.1 → 1.31.0

Check failures:
• Gitea: unreachable (ConnectError)

2 updates, 1 failure
```

A notification is only sent when there is something to report. If everything is up to date and all checks pass, no message is sent.

## API

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | `{"status":"ok","version":"1.0.0"}` |
| `GET` | `/api/services` | All services with versions and status |
| `POST` | `/api/services/{name}/version` | Save a manual version |
| `POST` | `/api/notify` | Trigger check + Telegram notification now |
| `GET` | `/api/config` | Current service list and settings |
| `POST` | `/api/config/services` | Replace full service list |
| `DELETE` | `/api/config/services/{name}` | Remove a service |
| `POST` | `/api/config/settings` | Update check interval |

## License

[MIT](LICENSE)
