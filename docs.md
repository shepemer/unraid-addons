# Unraid Addons Docs

This file holds the detailed reference material for the five-component Unraid Addons suite. The short install and connection path lives in [README.md](README.md).

## Version Mismatch And Codex Updates

If Codex Desktop reports a Codex version mismatch when connecting over SSH, manually restart the `codex-terminal` container from the Unraid Docker page or run:

```sh
docker restart codex-terminal
```

The terminal container updates Codex CLI during startup by default:

```text
npm install -g @openai/codex@latest
```

The update runs as root before SSH and WebUI sessions start, has a fixed 180-second limit, and verifies `codex --version` as the `codex` user. The interactive `codex` user does not need write access to global npm packages. If npm is unavailable or the update fails or times out, the container logs a warning and continues with the bundled Codex version. The supported Unraid and Compose deployments always request `@openai/codex@latest`; the former update toggles, version selector, and timeout are no longer published configuration.

## Upgrade From unraid-codex-terminal

The legacy GHCR packages remain available at their last published versions, but they are frozen and do not redirect to the new packages. Update every installed image Repository explicitly:

| Component | Frozen legacy Repository | New Repository |
| --- | --- | --- |
| `codex-terminal` | `ghcr.io/shepemer/unraid-codex-terminal:latest` | `ghcr.io/shepemer/unraid-addons-codex-terminal:latest` |
| `unraid-mcp` | `ghcr.io/shepemer/unraid-codex-terminal-unraid-mcp:latest` | `ghcr.io/shepemer/unraid-addons-unraid-mcp:latest` |
| `media-mcp` | `ghcr.io/shepemer/unraid-codex-terminal-media-mcp:latest` | `ghcr.io/shepemer/unraid-addons-media-mcp:latest` |
| `media-issue-agent` | `ghcr.io/shepemer/unraid-codex-terminal-media-issue-agent:latest` | `ghcr.io/shepemer/unraid-addons-media-issue-agent:latest` |
| `utilities-mcp` | `ghcr.io/shepemer/unraid-codex-terminal-utilities-mcp:latest` | `ghcr.io/shepemer/unraid-addons-utilities-mcp:latest` |

The same release also reduces the five DockerMan templates from 105 fields to 66. Replacing an XML file alone neither changes an installed Repository nor removes environment rows already saved in an Unraid container. Use the staged migration below rather than editing an existing container in place indefinitely.

### Release precondition after merge

Merging to `main` publishes the immutable full commit-SHA tag and the mutable `:main` tag; it does **not** update `:latest`. The templates point at `:latest`, so promote the exact tested merge commit before recreating anything. From a clone with GitHub CLI access:

```sh
MERGED_PR_NUMBER=123  # Replace 123 with the merged pull-request number.
MERGE_SHA="$(gh pr view "$MERGED_PR_NUMBER" --json mergeCommit --jq '.mergeCommit.oid')"
gh run list --workflow docker.yml --branch main --event push --limit 5
# Wait for the push run containing $MERGE_SHA to complete successfully.
gh workflow run docker.yml --ref main -f ref="$MERGE_SHA" -f channel=latest
gh run list --workflow docker.yml --event workflow_dispatch --limit 5
# Watch the new workflow_dispatch run and require a successful result.
gh run watch <workflow-dispatch-run-id> --exit-status
```

If you use the Web UI, open **Actions → Docker → Run workflow**, leave the workflow branch as `main`, enter the full merge SHA in **Git ref to publish**, select `latest`, and wait for every build and scan job to pass. Optionally promote the same SHA to `beta` first for a canary. Do not use a later moving `main` ref for the second promotion; promote the same immutable SHA.

### Unraid migration

1. Have the retained API keys, bearer tokens, WebUI passwords, integration credentials, host ports, and host paths available for recreation. Record the exact existing host sources mounted at the issue agent's `/state` and `/codex-home` targets, whether terminal SSH uses plaintext or a crypt-format hash, and every old `MEDIA_MCP_PATH_MAPS` entry. Do not export secrets into an unprotected text file.
2. Edit the installed `media-issue-agent` Repository to `ghcr.io/shepemer/unraid-addons-media-issue-agent:<MERGE_SHA>` and select Apply **without changing its existing `/state` and `/codex-home` mounts or legacy environment rows**. This applies whether the old Repository uses the frozen legacy namespace or an earlier `unraid-addons` image. Let the exact new image complete one healthy start and confirm the Web UI still shows issue history and settings. That intermediate boot imports non-default, non-secret runner and operations settings into SQLite before those DockerMan fields disappear.
3. Edit the other four installed Repository fields to their corresponding `unraid-addons` packages. Replacing the template XML alone is not sufficient.
4. Stop the stack. Remove only the Docker containers, not their images or appdata, then copy/install the reduced templates and recreate the containers with the same names on `codex-mgmt`. This explicit recreation is what removes obsolete environment rows. Do not remove appdata and do not use Unraid's **Delete Image And Container** cleanup option.
5. For `media-issue-agent`, the parent-only migration is zero-move only when the old host sources are sibling directories named `state` and `codex` beneath `/mnt/user/appdata/media-issue-agent`. In that default layout, map the existing parent to `/config`; the children become `/config/state` and `/config/codex`. If either old source was customized, disjoint, or named differently, map a persistent parent to `/config` and manually add two narrow DockerMan Path entries: the exact old `/state` host source to `/config/state`, and the exact old `/codex-home` host source to `/config/codex`. Docker's nested bind mounts preserve both custom locations without moving their contents. Re-enter the retained secrets in the new template.
6. On `codex-terminal`, keep SSH key login or enable password login and fill exactly one of **SSH Password** and **SSH Password Hash**. On `media-mcp`, an install that relied on the former implicit `/downloads=/mnt/unraid/downloads` mapping must now set **Download Path** to `/downloads`; translate an explicit mapping the same way. Translate `/media=/mnt/unraid/media` to **Media Path** `/media`; use the actual source roots from your old maps rather than these examples. Both fields are optional and should stay blank when no translation is needed. Arbitrary old maps with multiple source roots or custom target subdirectories remain expert-only legacy environment overrides and must be added manually if still required.
7. Start `unraid-mcp`, `media-mcp`, `utilities-mcp`, `codex-terminal`, then `media-issue-agent`. In the authenticated issue-agent Web UI, open **Operations**, enter the comma-separated exact usernames/reporter names allowed to supply server-owner guidance, select **Save Operations**, and approve the trust confirmation.
8. Verify terminal auth/config, Unraid MCP state and logs, media path resolution, issue history, repair workspaces, and Codex authentication before deleting any recoverable appdata or backup. The former Unraid MCP `backups/` host directory is no longer mounted or used; this migration deliberately leaves it untouched for manual review or later cleanup.

The image's legacy environment/path support makes the intermediate issue-agent boot safe, but it is not a substitute for recreating the DockerMan definition. Saved Web UI values take precedence over a legacy environment value, which takes precedence over the image default.

### Compose migration

First boot the new issue-agent image once through your existing Compose file, while that file still mounts `/state` and `/codex-home` and passes the legacy settings. You can do that by changing only `ISSUE_AGENT_IMAGE` to the new package, then running `docker compose --profile issue-agent pull media-issue-agent` and `docker compose --profile issue-agent up -d media-issue-agent`.

After that healthy intermediate start, fetch this repository or replace `docker-compose.yml` and `.env.example` with the current versions. When the old paths are the default sibling `./data/media-issue-agent/state` and `./data/media-issue-agent/codex` directories, replace `ISSUE_AGENT_STATE_DIR` and `ISSUE_AGENT_CODEX_HOME` with `ISSUE_AGENT_CONFIG_DIR=./data/media-issue-agent`; this mounts their existing parent at `/config` without moving data.

For custom, disjoint, or differently named old paths, keep their exact host sources and add nested binds in `docker-compose.override.yml` while retaining the new parent mount:

```yaml
services:
  media-issue-agent:
    volumes:
      - ${ISSUE_AGENT_CONFIG_DIR:-./data/media-issue-agent}:/config:rw
      - /exact/old/state-source:/config/state:rw
      - /exact/old/codex-home-source:/config/codex:rw
```

Replace both example sources with the paths from the old deployment. Remove obsolete configuration keys, update any other image overrides, and run `docker compose pull` followed by `docker compose up -d` with the same profile and file flags you already use. With local `:dev` images, run `docker compose build` before `up -d` instead.

Translate the old media path-map behavior before starting the new Compose file. If you relied on the former implicit `/downloads=/mnt/unraid/downloads` mapping, or configured that entry explicitly, set `MEDIA_MCP_DOWNLOADS_PATH=/downloads`. A former `/media=/mnt/unraid/media` entry becomes `MEDIA_MCP_MEDIA_PATH=/media`. If every explicit old entry fits those two fixed targets, remove `MEDIA_MCP_PATH_MAPS` from `.env`. For multiple sources or a custom target subdirectory that cannot be translated, keep the old value and explicitly pass it through a local `docker-compose.override.yml`:

```yaml
services:
  media-mcp:
    environment:
      MEDIA_MCP_PATH_MAPS: ${MEDIA_MCP_PATH_MAPS:-}
```

The base Compose file intentionally publishes only the two supported fields. Leaving `MEDIA_MCP_PATH_MAPS` in `.env` without this override does not pass it into the container.

Do not run `docker compose down`, rename the Compose project, or move `./data`. The compatibility project name remains `unraid-codex-terminal` specifically so upgrades reuse the existing containers and state.

If you follow `:beta`, use `:beta` on the corresponding new package. Historical SHA tags were not copied: keep an old SHA pinned to its frozen legacy package, or move to `main`, `beta`, `latest`, or a SHA published after the new packages were created.

The unchanged host appdata preserves terminal Codex auth and config, SSH keys, workspace files, Unraid MCP state/logs, and the issue agent database, logs, repair workspaces, and Codex auth. Only the issue agent's internal mount layout is consolidated. Media and utilities credentials must be re-entered when an Unraid container is recreated.

## Architecture

- `codex-terminal`: OpenSSH server on container port `2222`, `ttyd` WebUI on container port `7681`, Codex CLI, common diagnostic tools, persistent `/config`, and `/workspace` backed by `/config/workspace`.
- `unraid-mcp`: pinned `unraid-mcp==1.2.4` HTTP MCP server on the internal `codex-mgmt` network.
- `media-mcp`: optional HTTP MCP server on the internal `codex-mgmt` network for Sonarr, Radarr, Plex, Tautulli, Tracearr, Bazarr, Prowlarr, qBittorrent, NZBGet, Threadfin, and Seerr-family media automation.
- `media-issue-agent`: optional human-in-the-loop worker on the internal `codex-mgmt` network for Plex-native reports and Seerr-family issue triage and repair. It uses `media-mcp` for media API access and local Codex ChatGPT auth for investigation summaries, autonomous repair runs, and comment drafts.
- `utilities-mcp`: optional HTTP MCP server on the internal `codex-mgmt` network for Scrutiny storage health monitoring.
- `codex-mgmt`: user-defined Docker bridge network. SSH and the WebUI are published to the host; MCP is internal only.

## Configuration Surface

The reduced DockerMan templates expose 67 fields, with 22 shown routinely and the rest behind Advanced View:

| Container | Routine | Advanced | Total |
| --- | ---: | ---: | ---: |
| `codex-terminal` | 6 | 10 | 16 |
| `unraid-mcp` | 3 | 2 | 5 |
| `media-mcp` | 7 | 25 | 32 |
| `media-issue-agent` | 4 | 8 | 12 |
| `utilities-mcp` | 2 | 0 | 2 |

DockerMan owns host ports and mounts plus credentials that must exist before startup. Fixed internal hostnames, listener ports, transport, timeouts, and derived paths are image concerns and are not form fields. The authenticated issue-agent Web UI owns its non-secret runner and operations preferences. This separation does not remove manual backend environment compatibility, but those expert overrides are outside the supported template/Compose contract.

## Unraid Install Details

1. Create the internal Docker network from the Unraid terminal:

   ```sh
   docker network create codex-mgmt
   ```

2. Copy the templates from `templates/` into:

   ```text
   /boot/config/plugins/dockerMan/templates-user/
   ```

3. Confirm the templates reference the published images:

   - `ghcr.io/shepemer/unraid-addons-codex-terminal:latest`
   - `ghcr.io/shepemer/unraid-addons-unraid-mcp:latest`
   - `ghcr.io/shepemer/unraid-addons-media-mcp:latest`
   - `ghcr.io/shepemer/unraid-addons-media-issue-agent:latest`
   - `ghcr.io/shepemer/unraid-addons-utilities-mcp:latest`

4. Install `unraid-mcp` first. Set:

   - `UNRAID_API_URL`, usually `http://tower.local/graphql` or `https://tower.local/graphql`
   - `UNRAID_API_KEY`
   - `UNRAID_MCP_BEARER_TOKEN`

5. Install `codex-terminal`. Set the same `UNRAID_MCP_BEARER_TOKEN`, at least one public SSH key in `SSH_AUTHORIZED_KEYS`, and a strong `WEBUI_PASSWORD`. WebUI authentication, username `codex`, the safe ttyd log level, client limit, and tmux session are fixed internally. If you need SSH password login, set `SSH_PASSWORD_LOGIN=true` and exactly one of the masked **SSH Password** and **SSH Password Hash** fields. The hash must be a complete crypt-format value accepted by `chpasswd -e`.

   Optional terminal diagnostics can compare media-service paths with host files. Select narrow existing shares using their exact capitalization, then set `CODEX_MEDIA_PATH_MAPS` to mappings such as `/downloads=/mnt/unraid/downloads,/media=/mnt/unraid/media`. The terminal media mount is read-only. Its downloads mount is read/write for intentional shell-side archive checks or extraction; leave it empty if that capability is not needed.

6. Optional: install `media-mcp` on `codex-mgmt`. For guarded archive extraction, select the existing downloads share with its exact capitalization and mount it read/write at `/mnt/unraid/downloads`. If a media app reports that same root under another absolute path, set the optional Advanced **Download Path** field to the service-side root, such as `/downloads`; it maps to `/mnt/unraid/downloads`. For scoped raw media-file operations, select the narrowest existing media library root with its exact capitalization, mount it at `/mnt/unraid/media`, optionally set **Media Path** to the service-side root, such as `/media`, and explicitly allow deletion with `MEDIA_MCP_MEDIA_ROOTS=/mnt/unraid/media`. The path fields do not create mounts, and leaving one blank creates no mapping. Set `MEDIA_MCP_BEARER_TOKEN` and at least one complete service credential set:

   - Sonarr: `SONARR_URL` and `SONARR_API_KEY`
   - Radarr: `RADARR_URL` and `RADARR_API_KEY`
   - Plex: `PLEX_URL` and `PLEX_TOKEN`
   - Bazarr: `BAZARR_URL` and `BAZARR_API_KEY`
   - Prowlarr: `PROWLARR_URL` and `PROWLARR_API_KEY`
   - qBittorrent: `QBITTORRENT_URL`, `QBITTORRENT_USERNAME`, and `QBITTORRENT_PASSWORD`
   - NZBGet: `NZBGET_URL`, `NZBGET_USERNAME`, and `NZBGET_PASSWORD`
   - Seerr, Overseerr, or Jellyseerr: `SEERR_URL` and `SEERR_API_KEY`
   - Tautulli: `TAUTULLI_URL` and `TAUTULLI_API_KEY`
   - Tracearr: `TRACEARR_URL` and `TRACEARR_API_KEY`
   - Threadfin: `THREADFIN_URL`, plus optional `THREADFIN_USERNAME` and `THREADFIN_PASSWORD`, or optional `THREADFIN_TOKEN`

   Set the same `MEDIA_MCP_BEARER_TOKEN` in `codex-terminal` to add this optional sidecar to `/config/.codex/config.toml`.

7. Optional: install `media-issue-agent` on `codex-mgmt` after `media-mcp`.

   Set:

   - `ISSUE_AGENT_MEDIA_MCP_BEARER_TOKEN`, matching the media MCP bearer token until scoped tokens are available
   - `ISSUE_AGENT_WEB_PASSWORD`, a strong Web UI password
   - one persistent appdata parent mounted to `/config`

   The issue agent uses the fixed internal media endpoint `http://media-mcp:6971/mcp`, WebUI listener `0.0.0.0:6983`, database `/config/state/media-issue-agent.sqlite`, log `/config/state/media-issue-agent.log`, repair workspaces `/config/state/repair-workspaces`, and Codex home `/config/codex`. The appdata parent and its subdirectories must be writable by the container's `agent` user, which runs as uid/gid `1000`. For the default Unraid template path:

   ```sh
   mkdir -p /mnt/user/appdata/media-issue-agent/state /mnt/user/appdata/media-issue-agent/codex
   chown -R 1000:1000 /mnt/user/appdata/media-issue-agent
   ```

   The issue agent refuses `OPENAI_API_KEY` and `CODEX_API_KEY`. It is intended to use ChatGPT-managed Codex access, such as a Pro plan, through Codex local authentication. The separately named `ISSUE_AGENT_OPENAI_MODERATION_API_KEY` is accepted only for optional Slack message moderation and is never used by Codex. On first start, open the Web UI and use the Codex Auth panel to start a ChatGPT device-login flow. To prepare the mounted Codex home from a trusted shell instead, run:

   ```sh
   docker compose --profile issue-agent run --rm media-issue-agent codex login --device-auth
   ```

   You can also copy a trusted Codex `auth.json` into the mounted Codex home. Treat `auth.json` like a password: never commit it, paste it into chat, include it in issue reports, or expose it in logs.

   Open the Web UI at:

   ```text
   http://<unraid-ip>:6983/
   ```

   Use username `operator` and `ISSUE_AGENT_WEB_PASSWORD` for browser Basic auth. The Web UI can complete Codex ChatGPT setup, poll, list current snapshots, start investigations, steer investigations with operator notes, inspect jobs, configure Codex model/speed defaults and non-secret repair context, configure poll interval/snapshot retention/comma-separated trusted server-owner reporters, reset either settings group to its fallback, and approve or reject pending work. Reporter matching is exact and case-insensitive; duplicates and surrounding whitespace are normalized. A structured username takes precedence over a display name when both exist, and Slack identities never inherit this trust. Reporter-name-only aliases apply across non-Slack issue sources and may be mutable or non-unique, so use them only when an upstream source supplies no stable username and you have verified the collision risk. Changing the trusted set requires an explicit confirmation and creates an audit event. Investigations are cached per job after they run; selecting an issue shows the cached investigation when one exists, while Re-investigate reruns Codex and replaces the stored investigation. Each steering note supersedes the previous pending repair prompt approval and creates a new one. Action approval either records a client-side/no-op determination or launches an autonomous `codex exec --json` repair run with full access inside the issue-agent container and direct `media-mcp` access. While a repair runs, the detail pane shows a focused, human-readable live activity stream; the full investigation is available from a separate report dialog. After the repair run returns verified final JSON, the job moves to approve-fix with a structured execution result and drafted resolution comment. A failed repair remains in a failure-review state with its result and offers Retry same repair, Re-investigate, or Close anyway; it does not silently create a replacement approval. Final approval posts the resolution, adds `Closed.`, and resolves Seerr-family issues when applicable. The CLI remains available for the same workflow:

   ```sh
   docker compose --profile issue-agent run --rm media-issue-agent node src/cli.js poll-once
   docker compose --profile issue-agent run --rm media-issue-agent node src/cli.js list
   docker compose --profile issue-agent run --rm media-issue-agent node src/cli.js investigate 1 1
   docker compose --profile issue-agent run --rm media-issue-agent node src/cli.js investigate 1 1 --force
   docker compose --profile issue-agent run --rm media-issue-agent node src/cli.js steer 1 "Treat this as client-side; no server-side action is needed."
   docker compose --profile issue-agent run --rm media-issue-agent node src/cli.js approve 1
   docker compose --profile issue-agent run --rm media-issue-agent node src/cli.js continue 1
   docker compose --profile issue-agent run --rm media-issue-agent node src/cli.js status
   ```

   Local state stores snapshots, job state, approvals, retries, and audit events only. Plex and Seerr remain the source of truth for issue status and comments.

8. Optional: install `utilities-mcp` on `codex-mgmt`. Set `UTILITIES_MCP_BEARER_TOKEN` and the full Scrutiny endpoint:

   - Scrutiny: `SCRUTINY_URL`, including any reverse-proxy path, for example `https://host.example/scrutiny`

   Set the same `UTILITIES_MCP_BEARER_TOKEN` in `codex-terminal` to add this optional sidecar to `/config/.codex/config.toml`.

Do not add a port mapping for `unraid-mcp`, `media-mcp`, or `utilities-mcp`. The media issue agent publishes only its password-protected Web UI port; expose it only on LAN, VPN, or Tailscale.

`UNRAID_API_URL` must include `/graphql` and must match the scheme your Unraid WebUI/API actually serves. If `https://<unraid-ip>` refuses port `443` but `http://<unraid-ip>` works on port `80`, use `http://<unraid-ip>/graphql`.

## Unraid Share Path Casing

The optional media and downloads mounts have no host-path defaults. Before configuring either mount, use the Unraid terminal to list the existing share names:

```sh
ls -1 /mnt/user
```

Copy the path exactly as shown. Linux paths are case-sensitive, and Docker volume syntax can create a missing source directory. For example, entering `/mnt/user/media` when the existing share is `/mnt/user/Media` can create a second share and trigger Fix Common Problems warnings.

For Compose, direct file access is disabled in the base file. Set `MEDIA_MCP_DOWNLOADS_DIR` and `MEDIA_MCP_MEDIA_DIR` to existing exact-case paths, then include the guarded override:

```sh
docker compose \
  -f docker-compose.yml \
  -f docker-compose.media-paths.yml.example \
  --profile media up -d media-mcp
```

The override uses `create_host_path: false`, so startup fails instead of creating a misspelled share. Leave the mounts, `MEDIA_MCP_DOWNLOADS_PATH`, `MEDIA_MCP_MEDIA_PATH`, and `MEDIA_MCP_MEDIA_ROOTS` blank when direct filesystem tools are not needed. A service-path setting is useful only when the media apps report a different root from the corresponding fixed container mount. Multiple source namespaces or custom destination subdirectories require an expert manual legacy `MEDIA_MCP_PATH_MAPS` environment override; that compatibility input is intentionally not exposed by the template or base Compose file.

If Fix Common Problems already reports two differently cased shares, stop every container that mounts either path. Compare both shares and their per-disk directories before moving or deleting anything:

```sh
du -sh /mnt/user/Media /mnt/user/media 2>/dev/null
find /mnt/disk* /mnt/cache -maxdepth 1 -type d -iname media -print 2>/dev/null
```

Update container mappings to the intended existing share. If both shares contain data, merge them with the Unraid file manager or another trusted file tool. Remove the unwanted share only after it is empty, then restart the containers and rescan Fix Common Problems. Do not delete either path merely based on capitalization.

## WebUI

Open the container WebUI at:

```text
http://<unraid-ip>:7681/
```

The WebUI is a `ttyd` browser terminal attached to the fixed persistent `tmux` session named `codex`. It starts Codex automatically with `--dangerously-bypass-approvals-and-sandbox`, matching the Home Assistant add-on behavior; set `AUTO_LAUNCH_CODEX=false` or `CODEX_WEBUI_BYPASS_APPROVALS=false` if you want a plain shell or normal Codex approval prompts.

Because this is a shell, authentication is fixed on with username `codex`. Use a strong `WEBUI_PASSWORD` and expose the port only on LAN, VPN, or Tailscale. The internal ttyd log level is fixed at the safe value that avoids printing the basic-auth credential in startup logs.

## Unraid API Key

Do not use an `ADMIN` key by default. Create a scoped operator key in Settings > Management Access > API Keys.

Recommended starting permissions:

- Read: `INFO`, `LOGS`, `DOCKER`, `ARRAY`, `DISK`, `SHARE`, `VMS`, `NOTIFICATIONS`
- Mutating: Docker start, stop, restart, and update if you want Codex to manage containers
- Optional: VM start and stop if you want Codex to manage VMs

Leave array mutations, flash, API key, config, network, OS, permission, and plugin mutation permissions disabled until you intentionally need them.

## SSH Config

Add an SSH host on your workstation:

```sshconfig
Host unraid-codex
  HostName <unraid-ip-or-tailnet-name>
  Port 2222
  User codex
  IdentityFile ~/.ssh/id_ed25519
```

Verify:

```sh
ssh unraid-codex codex --version
ssh unraid-codex codex mcp list --json
```

Codex Desktop Remote SSH should detect this host from your local SSH config. Open `/workspace` as the project path.

SSH password auth is disabled by default. If a client cannot use SSH keys, set `SSH_PASSWORD_LOGIN=true` and exactly one of `SSH_PASSWORD` or `SSH_PASSWORD_HASH`; setting both, or setting neither while password login is enabled, stops startup. Generate a SHA-512 crypt hash without putting the plaintext in the DockerMan template by running `openssl passwd -6`, entering the password at its prompts, and pasting the complete one-line `$6$...` result into **SSH Password Hash**. In a Compose `.env` file, single-quote the hash (`SSH_PASSWORD_HASH='$6$...'`) so dollar signs remain literal. Keep SSH exposed only on LAN, VPN, or Tailscale.

SSH as `codex`, not `root`. Root login is intentionally disabled.

## Codex Auth And State

The container persists these paths under `/mnt/user/appdata/codex-terminal`:

- `/config/.codex` for Codex auth and configuration
- `/config/ssh` for SSH host keys and authorized keys
- `/config/workspace` for the default project workspace

On first start, the entrypoint creates `/config/.codex/config.toml` with:

```toml
[mcp_servers.unraid]
url = "http://unraid-mcp:6970/mcp"
bearer_token_env_var = "UNRAID_MCP_BEARER_TOKEN"
```

When `MEDIA_MCP_BEARER_TOKEN` is set on `codex-terminal`, startup also adds this block if it is not already present:

```toml
[mcp_servers.media]
url = "http://media-mcp:6971/mcp"
bearer_token_env_var = "MEDIA_MCP_BEARER_TOKEN"
```

When `UTILITIES_MCP_BEARER_TOKEN` is set on `codex-terminal`, startup also adds this block if it is not already present:

```toml
[mcp_servers.utilities]
url = "http://utilities-mcp:6972/mcp"
bearer_token_env_var = "UTILITIES_MCP_BEARER_TOKEN"
```

Sign in to Codex inside the SSH container if needed:

```sh
ssh -t unraid-codex codex login
```

## Optional Media MCP

The [capability backlog audit](media-mcp/CAPABILITY-GAPS.md) maps the recorded missing tools to their implementations and remaining upstream limits. It covers Plex season/addition evidence, scan and playback diagnostics, exact download handoffs and import watching, release suppression, mapped file probes, compatibility copies, and subtitle timing tools. Mutation tools retain dry-run defaults and the issue agent's repair approval gate; private session/log tools remain outside public Slack research.

`media-mcp` exposes a single `media` MCP server with a conservative first-party tool set:

- Shared: configured service status, compact media admin overview, diagnostics bundles, exact queue-item diagnosis, exact queue repair plans, issue diagnosis, request triage, scoped media file deletion, and video content probing.
- Sonarr: list, lookup, add series, queue, guarded queue removal, manual import candidates/import, queue-item file inspection, episode inventory, safe exact episode-file replacement, dry-run-first queue-item import, paginated wanted missing, wanted missing exact-ID collection, dry-run-first exact missing episode searches, cutoff unmet, recent history, blocklist, command status/cancel, command triggers for missing/cutoff/episode/series/season searches, rescan/refresh, dry-run-first rename/download scans, interactive release search/grab, recent logs, quality profiles, generic quality profile/custom format/quality definition management, and root folders.
- Radarr: list, lookup, add movies, queue, guarded queue removal, manual import candidates/import, queue-item file inspection, dry-run-first queue-item import, exact movie-file deletion without replacement search, paginated wanted missing, wanted missing exact-ID collection, dry-run-first exact missing movie searches, cutoff unmet, recent history, blocklist, command status/cancel, command triggers for missing/cutoff/movie searches, rescan/refresh, dry-run-first rename/download scans, interactive release search/grab, recent logs, quality profiles, generic quality profile/custom format/quality definition management, and root folders.
- Plex: server status, libraries, library items, search, metadata, season-child listing, exact metadata deletion/section scan/empty-trash, active sessions, and normalized Seerr/Plex-native user-reported issue views with Plex-native comment replies.
- Tautulli: current activity and playback history diagnostics.
- Tracearr: health, OpenAPI, stats, today stats, activity trends, active streams, users, violations, and playback history diagnostics.
- Threadfin: status, configuration snapshots with summaries, M3U/HDHomeRun/XMLTV source management, M3U group/channel discovery from configured playlist sources, group-title filter creation, M3U updates from existing playlist fields, selector-based XEPG mapping updates, XMLTV source lookup, output verification against `/lineup.json`, `/m3u/`, and `/discover.json`, settings patches, user management, logs, backup/restore, PPV enable/disable, exported output inspection, refresh/update commands, and guarded raw API/websocket commands.
- Bazarr: status, wanted movie subtitles, wanted episode subtitles, providers, subtitle history, and subtitle overview.
- Prowlarr: list indexers, search, and indexer health/history summary.
- qBittorrent: list torrents, pause or resume selected hashes, recheck/reannounce exact hashes, and delete selected hashes with explicit optional file deletion.
- NZBGet and local files: NZBGet status, queue, history/detail, exposed download files, archive diagnosis, dry-run-first post-processing retry, guarded history removal, optional local archive extraction with filesystem fallback, pause or resume downloads, set rate limits, and dry-run-first exact media-file deletion constrained to `MEDIA_MCP_MEDIA_ROOTS`.
- Seerr, Overseerr, or Jellyseerr: search media, list/request details, guarded request status updates, and list/comment/resolve/reopen/delete reported issues. Plex-native reports can be listed, diagnosed, and commented on through Plex's community GraphQL API; the current Plex Web API does not expose resolve/reopen/archive/delete state transitions for those native reports.

Container lifecycle management stays with `unraid-mcp` and the scoped Unraid API. The media sidecar does not mount the Docker socket or appdata directories. The optional downloads mount is only for guarded archive extraction, and the optional media mount is only for `media_file_delete` paths constrained by `MEDIA_MCP_MEDIA_ROOTS`. Threadfin management goes through Threadfin's own API and web UI websocket control surfaces. Tracearr support is read-only and does not expose stream termination.

Mutating media tools use exact IDs, exact hashes, or exact manual-import paths, and file-changing admin actions default to `dryRun=true`. Threadfin write tools also require `confirm=true` when `dryRun=false`. Use `media_queue_repair_plan` before `media_apply_queue_repair_plan`; real execution accepts only exact plan actions or exact Seerr follow-up actions.

Sonarr/Radarr search, rescan, and refresh command tools queue the native Arr command immediately and return the queued command record. Global missing and cutoff searches can fan out into many indexer searches and may grab releases depending on each app's own settings. Prefer `sonarr_wanted_missing_ids` plus `sonarr_search_missing_exact`, or `radarr_wanted_missing_ids` plus `radarr_search_missing_exact`, when you need controlled missing-media searches: the exact tools page through wanted records, apply monitored/aired/available safeguards, default to `dryRun=true`, and queue only `EpisodeSearch` or `MoviesSearch` batches when explicitly executed. File-changing actions such as rename, downloaded scan, manual import, release grab, queue removal, download-client cleanup, and Servarr profile/custom format/quality definition updates are guarded with exact IDs/names/paths and dry-run-first behavior. Servarr config dry-runs return the current object, proposed object, compact diff, validation errors, and exact API method/path before any PUT or POST is attempted.

Queue-based manual import tools use the queue item's decoded `outputPath`, `downloadId`, and target `seriesId` or `movieId` when calling the Arr manual import API. If the API returns rows from library roots such as `/tv/...` or `/movies/...` instead of the queue/download folder, those rows are excluded from valid candidates and reported as blockers. Queue summaries expose decoded display paths and include raw values when upstream fields arrive HTML-escaped.

NZBGet post-processing retry tools are dry-run-first and never remove history or files. Use `download_client_archive_diagnosis` with a Sonarr/Radarr queue item to match the NZBGet history record by Arr `downloadId`/NZBGet `drone` parameter, inspect `UnpackStatus`, and report archive files exposed by NZBGet. Use `nzbget_retry_postprocess` with `dryRun=false` to call `editqueue("HistoryProcess", 0, [NZBID])` for one exact history item. Deleted history items require `force=true`. `nzbget_extract_archives` only operates inside the matched history item's `DestDir`, requires `dryRun=false`, and requires the media MCP container to see that path, write to it, and run `unrar` or `7z`/`7zz`. If NZBGet exposes no `listfiles` archive roots for a completed history item, the tool maps `DestDir` through the configured **Download Path**, finds root archives directly on disk, skips volume-only files such as `.r00`, extracts the roots, and can queue the matching Sonarr/Radarr downloaded scan for the original download path and download ID.

Use `media_archive_environment_check` or the container command below to verify the archive environment. The command reports `unrar`, `7z` or `7zz`, and a safe temporary write probe under the downloads mount when it is present:

```sh
archive-tools-check --downloads-dir /mnt/unraid/downloads
```

## Optional Media Issue Agent

`media-issue-agent` is a separate worker for user-reported media issues. It periodically reconciles Plex-native reports, Seerr-family issues, and locally archived Slack reports, writes a GitHub-flavored Markdown table with stable numeric indexes, serves a password-protected Web UI, and stores automation bookkeeping in SQLite.

Important behavior:

- Plex-native reports with any comment exactly `Closed.` are treated as resolved. Matching is case-insensitive and ignores leading or trailing whitespace.
- If a Plex list response does not include comments, or `commentCount` shows comments may exist, the agent fetches issue details before deciding whether the report is open.
- Local SQLite state never overrides Plex or Seerr truth. It stores snapshots, job state, locks, approval records, retries, timestamps, redacted audit events, per-job repair runner history, and non-secret UI settings. Snapshot retention is configured in the Web UI.
- Investigation summaries and sanitized evidence are cached per job. Selecting an issue in the Web UI shows the cached investigation when one exists; Re-investigate or CLI `--force` reruns Codex and replaces the cached result.
- The agent uses Codex local through ChatGPT auth for investigation summaries, autonomous repair runs, and comment drafts. It refuses generic Codex API-key auth, so `OPENAI_API_KEY` and `CODEX_API_KEY` must be unset. The optional Slack integration separately requires a restricted key used only by the free OpenAI Moderation endpoint.
- Issue resolution defaults to `gpt-6-astra`, `ultra` reasoning, and Fast mode (`service_tier=fast`). These settings apply to investigations, steered investigations, repairs, and resolution drafts. Slack conversation classification and reply drafting keep the existing low reasoning and Fast mode settings; background diagnostics use the normal investigation settings. Content filtering remains on `omni-moderation-latest`. Ultra is a reasoning setting; it is separate from the Ultrafast speed tier. Configure model, reasoning, Fast mode, and service tier in the Web UI; legacy `ISSUE_AGENT_CODEX_*` environment variables remain fallback inputs.
- [GPT-5.5 retired from ChatGPT-authenticated Codex on October 14, 2026](https://learn.chatgpt.com/docs/models#gpt-55-retirement). Existing `gpt-5.5` environment defaults and saved settings are automatically migrated to GPT-6 Astra. The old default `xhigh` reasoning becomes `ultra`; other explicit reasoning, speed, and context choices are retained. Saved settings are migrated on startup. Other model selections are preserved.
- The Web UI requires Basic auth with fixed username `operator` and `ISSUE_AGENT_WEB_PASSWORD`.
- If Codex auth is missing, the Web UI starts in setup mode and can launch `codex login --device-auth` against `/config/codex`.
- Runner settings and Operations settings are saved separately. Each API response reports `defaults`, `effective`, `saved`, and per-field `sources`; precedence is saved UI value, then legacy environment value, then code default. Reset deletes the saved group and exposes the next fallback.
- Operations settings cover poll interval, snapshot retention, and a comma-separated list of trusted server-owner usernames/reporter names. Poll interval must be at least 30 seconds and retention at least 1. Reporter names are trimmed, de-duplicated case-insensitively, and matched exactly without case sensitivity; a structured username wins over a display name. A reporter-name-only alias is a deliberate fallback that applies across non-Slack issue sources and may be mutable or non-unique. Granting or changing the trusted set requires confirmation and is audited; clearing it does not require confirmation. Trust changes affect new or re-run investigations rather than rewriting cached evidence.
- The first upgraded start imports non-default legacy, non-secret settings once. Credentials are never imported into the settings table or returned by these APIs.
- Authenticated clients can use `GET`/`POST`/`DELETE /api/settings/codex` and `GET`/`POST`/`DELETE /api/settings/operations`. Reporter trust grants or changes in the Operations POST include `confirmServerOwnerReporterTrust: true`.
- The Web UI defaults to dark mode and includes an optional light theme. The selected theme is stored in the browser only and does not change server-side agent behavior.
- Job rows in the Activity panel are clickable. Investigation review prioritizes the current determination and safe next steps, with the full report available in a dialog. During autonomous execution the detail pane shows only a chronological, human-readable live repair stream. Completed and failed runs use structured result views with the summary, actions taken, verification, and proposed closing comment; verbose event JSON remains in downloadable logs.
- The investigation pane includes a steering box. Each steering note reruns Codex against sanitized evidence and the previous summary, updates the investigation, supersedes the old action approval, and creates a fresh approval for the new plan.
- Action approval starts the job flow. If the approved determination is client-side or requires no server-side action, the job records that no server-side media action was executed and moves directly to approve-fix with a drafted resolution comment. Otherwise it launches Codex as an autonomous repair runner with `--dangerously-bypass-approvals-and-sandbox`, `--skip-git-repo-check`, `--ephemeral`, `--json`, selected model/reasoning settings, a live `tools/list` briefing from `media-mcp`, the configured non-secret repair context, and the configured `media` MCP server.
- The repair runner is intentionally broad for media-side repair work. It can choose the `media-mcp` tools that fit the evidence instead of going through an issue-agent repair allowlist. During that autonomous phase, the issue agent routes Codex through a repair-scoped MCP proxy that blocks reporter comments, issue resolve/reopen, and issue delete tools; those lifecycle changes stay behind the final human approval.
- Each repair run gets a persistent per-job scratch workspace under `/config/state/repair-workspaces`. Codex sessions remain ephemeral, but retry runs can inspect prior scratch files and operator retry notes.
- The repair runner must return strict final JSON with status, summary, actions taken, verification, draft comment, and close recommendation. It may return `needs_operator_decision` with proposed choices when multiple risky valid repairs need human selection. Invalid JSON, failed runs, decision requests, or output that asks the server owner/operator to do media-side repair work becomes a failure-review state and does not create a success resolution approval. From there the operator can retry the same approved prompt, re-investigate with current evidence, or close the issue with an editable summary of what was attempted.
- Final resolution approval posts the drafted comment, posts the exact `Closed.` marker, and resolves Seerr-family issues when applicable. These final closure actions run live after approval.
- Mutating media repairs are performed by the approved autonomous Codex runner through `media-mcp`; final reporter comments and issue closure still require explicit approval in the issue agent.
- Plex-native final comments must be 300 characters or fewer and automated comments must end with `Automated response from Codex.`
- Slack responses do not use the `Automated response from Codex.` suffix because the bot identity already makes automation explicit.

### Optional Slack bot

The Slack integration uses Socket Mode, so it does not expose a public HTTP webhook. Create a Slack app from `media-issue-agent/slack-app-manifest.yml`, install it to the workspace, and create an app-level token with the `connections:write` scope. Configure:

- `ISSUE_AGENT_SLACK_ENABLED=true`
- `ISSUE_AGENT_SLACK_APP_TOKEN` with the secret `xapp-` app-level token
- `ISSUE_AGENT_SLACK_BOT_TOKEN` with the secret `xoxb-` bot OAuth token
- `ISSUE_AGENT_SLACK_CHANNEL_ID` with the ID of one public issue-report channel
- `ISSUE_AGENT_SLACK_OWNER_USER_IDS` with comma-separated stable Slack member IDs (`U…` or `W…`) permitted to steer investigations and approve work; leave empty to disable owner controls in chat
- `ISSUE_AGENT_OPENAI_MODERATION_API_KEY` with a restricted OpenAI Platform key for the Moderation endpoint

Create the moderation key in a separate OpenAI Platform project when possible and restrict it to the Moderations endpoint. Do not place it in `OPENAI_API_KEY`, because that generic variable remains forbidden and would also make accidental Codex API-key auth easier. Moderation requests use `POST /v1/moderations` with `omni-moderation-latest`; OpenAI documents the moderation model as free for API users, subject to account rate limits.

The manifest requests `app_mention`, `message.channels`, and `message.im` events. The configured channel must be public and must not be a Slack Connect or organization-shared channel. The process ignores ordinary channel traffic: a new channel conversation must explicitly mention the bot. Replies inside an already tracked bot thread can omit the mention, including older issue threads. In those threads, obvious social replies are ignored and the chat classifier uses conversation context to distinguish useful follow-ups, evidence, and owner controls from human-to-human conversation. Unmentioned small talk does not get an automatic response. Explicit mentions and direct messages from the authenticated workspace are handled normally. It ignores bot messages, message subtypes, external-workspace users, other channels, and untracked channel threads. The bot joins the configured public channel at startup when needed.

Every accepted message first passes deterministic normalization, prompt-injection and exposed-secret checks, then OpenAI `omni-moderation-latest`. Only allowed normalized text is released to the existing low-reasoning/Fast chat classifier. Moderation failures fail closed without stopping the rest of media-issue-agent. Classification and final reply drafting remain tool-free in fresh empty read-only workspaces with user configuration, rules, plugins, and shell access disabled. Content filtering also runs before generated replies are delivered.

Questions needing research first receive a checking reply. A separate backend Codex agent then uses the configured investigation model and reasoning settings to work out the answer. It discovers the live media tool catalog through a read-only gateway, can combine eligible tools as needed, and can use public web research. This is a general research and analysis workflow, not a fixed menu of checks. For example, it can inspect recent additions and public reviews to recommend a few shows actually in the library, calculate hours watched over the last seven days from aggregate seconds, compare options, or trace a specific title across download and import services. The low-reasoning chat model presents the backend’s conclusions, calculations, evidence, uncertainties, and source citations rather than repeating canned status text.

Replies default to about 80 words, with Slack `mrkdwn` bold labels, short paragraphs, and up to three bullets when useful. Line breaks survive moderation and delivery. Investigation handoffs summarize the saved findings and proposed work once, without starting another research run merely to announce completion. Owner approval commands and notification mentions remain visible in a separate footer. Steering and re-investigation receive one acknowledgement followed by the findings, without another generic checking message.

Watch-time totals use Tautulli’s `total_duration` for the requested period and media type. Its similarly named `filter_duration` describes only the returned page and must not be treated as the period total. Exact-title queries and unavailable or malformed totals use bounded history pagination; only aggregates are returned to chat, with incomplete results marked accordingly.

The gateway exposes only tools explicitly marked read-only, rejects mutation and generic endpoint capabilities, excludes individual account/viewing tools and unsafe arguments, and removes sensitive fields and identifying text from results. The backend has no shell, local-file access, direct service credentials, approval tools, or repair authority. Aggregate watch time and play counts are allowed; identifying who watched what is not. Private identities, device/account details, addresses, paths, credentials, raw download names, and internal operational identifiers must not appear in replies. Public research uses public terms or media titles, never private viewing records or conversation details. Public citations must correspond to sources observed during the research and pass URL validation; private hosts, IP addresses, embedded credentials, and secret-bearing URLs are excluded.

The research-and-reply phase has a 150-second deadline, including at most 120 seconds for backend work and at most 30 seconds for the final chat draft. The gateway enforces a maximum of 12 media calls. Public research has an 8-operation budget; the worker is cancelled if its observed web operations exceed that budget. Its rollout budget is 24,000 weighted tokens; the final draft has a 6,000-weighted-token budget. Weighted rollout budgets guide computation and are not exact billing-token caps; recorded token usage still includes the actual backend and chat usage. These limits are fixed in server code. When work is too broad or a budget is reached, the reply retains useful verified findings, states what remains uncertain, and suggests a narrower question instead of repeatedly retrying.

The `media-issue-agent` container must not be given media or download mounts. The supplied Docker Compose service and Unraid template mount one appdata parent at `/config`; direct media/download access belongs exclusively to `media-mcp`. Conversation classification has no media MCP access. Safe messages that do not map to a server action are handled as ordinary, message-specific conversation. Requests for actions the bot cannot execute are answered conversationally around the underlying goal rather than with limitation notices, while capability lists are reserved for explicit capability questions. Legitimate media questions receive concise conversational answers, while detected prompt injection receives a deterministic rejection without executing a lookup or incorporating the attacker's wording.

Slack messages never inherit trusted server-owner reporter status, even when a Slack display name matches the reporter configured in Operations settings. Owner authority in Slack is checked separately against the configured stable member IDs and the authenticated workspace; display names and model output cannot grant it. A confident, concrete report creates a normal `slack` issue and automatically queues a read-only investigation. The completed investigation posts its privacy-safe findings and next steps in the original thread and mentions the configured owners so they can approve or steer it. No repair starts automatically. Material new evidence is archived and invalidates a stale repair plan; status questions and requests for explanation receive answers without changing the issue evidence version. Media requests accept conversational wording, multiple explicit titles, and bounded relative groups such as the two latest movies in a franchise. Ranked Seerr matching can resolve unique or explicitly latest/oldest results without requiring a year. Ambiguous matches produce a numbered list, and a later option number, title, or year selects from that list deterministically. Plex availability requests return only online/offline state and active stream count. A top-level channel status request receives a top-level response that mentions the requester; a status request made inside an existing thread stays in that thread. All issue, media-information, media-request, clarification, conversational, and lifecycle responses stay in the originating thread.

Owners can control the existing approval workflow directly in the issue thread:

| Owner reply | Effect |
| --- | --- |
| `approve repair` or `complete the repair` | Approve the current repair plan and begin the repair. A stale plan is refreshed and requires a new approval. |
| `steer: check the season 5 import history first` | Revise the investigation using the owner’s instructions and publish a new plan. |
| `re-investigate` | Collect current evidence and investigate again. |
| `retry repair` | Retry a failed repair under owner authorization. |
| `approve resolution` or `close the issue` | Approve the pending resolution and close the issue after repair review. |

Repair approval and final resolution approval remain separate. A bare acknowledgement such as “okay” does not approve either stage. Controls are checked again by the agent, tied to their source Slack event, and cannot authorize a different approval stage when an event is retried. Non-owners can still ask questions and add evidence. Anyone can ask “what is the status?” or request more details without changing the repair plan.

Repair progress questions read the latest attempt’s persisted activity: current service operation, recent returned calls, recorded errors, and verification outcome when available. Stale or missing activity is reported explicitly, and a returned tool call is not treated as proof of a successful fix. Failure notifications explain the recorded cause and next owner options once per attempt; raw logs, commands, paths, and identifying details are excluded. The background command handler does not send a second generic status message after that result.

The behavior also applies to existing tracked Slack issues saved in the local database before this upgrade. After upgrading the service with its existing state directory, open issues that still need an initial investigation are picked up during reconciliation; current findings can be delivered to their original threads. Existing approvals are not treated as consent to a new repair. The owner notification is deduplicated for each investigation result. Replies require the original Slack thread and channel to remain available. If the channel was archived or the thread is missing, the locally saved issue remains in the Web UI and the bot does not redirect the discussion elsewhere.

Allowed inbound and safely moderated outbound Slack text is archived in SQLite so old issue history survives Slack retention or deletion. Before moderation, inbound text exists only as AES-GCM ciphertext protected by a process-local key. Blocked or failed messages are scrubbed and retain only a placeholder, category metadata, policy version, timestamp, and keyed digest; they are excluded from issue evidence and Codex context. Pending ciphertext left by a restart cannot be decrypted and is scrubbed with a neutral retry response. General issue-list and snapshot APIs do not include the verbatim allowed archive; authenticated issue detail and investigation evidence can use it. If Slack reports that an old thread is missing, archived history remains available and delivery is marked unavailable without creating a replacement thread or DM.

Hardcoded abuse guards limit each user independently to 180 accepted interactions per 10 minutes, 75 Codex classifications per hour, and 300 queued messages. One user cannot consume another user's quota. At most six inbound workers run concurrently across the service, while messages in one thread are processed in order. Every message received while a user is limited gets its own response with the remaining sliding-window wait; a full queue reports that it clears when an earlier message finishes. These limits intentionally cannot be relaxed through untrusted chat input.

If Slack says it encountered an internal processing error, inspect `slack_message_processing_failed` in the diagnostic log. A preceding `slack_moderation_allow` means the content check passed. Codex failures retain bounded, redacted stdout and stderr, with the final structured error first; a temporary-directory cleanup warning must not hide a model or authentication error. Moderation service outages have a separate unavailable-service reply and still fail closed.

When Pushover is configured, allowed inbound Slack messages and successfully sent bot messages generate redacted, truncated previews after moderation. Blocked messages generate category-only notifications with no raw text. New Slack issues do not generate a second generic new-issue notification. Codex usage reported by Slack classification, diagnostic, and reply-drafting calls is recorded in the same daily token counter shown in the Web UI as investigation and repair usage. Slack tokens and `ISSUE_AGENT_OPENAI_MODERATION_API_KEY` are secrets: never commit, log, paste, or place them in issue reports. The moderation key is never passed to Codex or `media-mcp`.

The Web UI, authorized Slack issue-thread replies, and CLI share the approval workflow. The CLI remains available for the same operations:

```sh
media-issue-agent poll-once
media-issue-agent list
media-issue-agent investigate <snapshot-id> <index> [--force]
media-issue-agent steer <job-id> <message>
media-issue-agent approve <job-id>
media-issue-agent reject <job-id>
media-issue-agent continue <job-id>
media-issue-agent status
```

Do not mount media libraries, download shares, unrelated appdata, Docker sockets, or broad host paths into `media-issue-agent`. It needs only its own parent appdata at `/config`, the fixed internal `media-mcp` endpoint, and the media MCP bearer token.

The `/config` bind mount must be writable by uid/gid `1000`; otherwise SQLite cannot create `/config/state/media-issue-agent.sqlite` and Codex cannot refresh ChatGPT auth under `/config/codex`.

Example media MCP payloads:

```json
{
  "tool": "sonarr_wanted_missing",
  "arguments": {
    "page": 2,
    "pageSize": 100
  }
}
```

```json
{
  "tool": "sonarr_wanted_missing_ids",
  "arguments": {
    "monitoredOnly": true,
    "airedOnly": true,
    "includeSpecials": false
  }
}
```

```json
{
  "tool": "sonarr_search_missing_exact",
  "arguments": {
    "batchSize": 100,
    "dryRun": true
  }
}
```

```json
{
  "tool": "sonarr_search_episode",
  "arguments": {
    "episodeIds": [12345]
  }
}
```

```json
{
  "tool": "radarr_search_movie",
  "arguments": {
    "movieIds": [6789]
  }
}
```

```json
{
  "tool": "radarr_search_missing_exact",
  "arguments": {
    "batchSize": 100,
    "dryRun": true
  }
}
```

```json
{
  "tool": "radarr_command_status",
  "arguments": {
    "commandIds": [101, 102, 103]
  }
}
```

```json
{
  "tool": "sonarr_interactive_search_episode",
  "arguments": {
    "episodeId": 12345,
    "limit": 10
  }
}
```

```json
{
  "tool": "radarr_grab_release",
  "arguments": {
    "guid": "exact-guid-from-interactive-search",
    "indexerId": 4,
    "dryRun": true
  }
}
```

```json
{
  "tool": "sonarr_rename_files",
  "arguments": {
    "seriesId": 55,
    "files": [9876],
    "dryRun": true
  }
}
```

```json
{
  "tool": "sonarr_queue_item_files",
  "arguments": {
    "queueId": 1309106746,
    "limit": 50
  }
}
```

```json
{
  "tool": "sonarr_import_queue_item",
  "arguments": {
    "queueId": 1309106746,
    "importMode": "move",
    "dryRun": true
  }
}
```

```json
{
  "tool": "nzbget_retry_postprocess",
  "arguments": {
    "nzbId": 70001,
    "dryRun": true
  }
}
```

```json
{
  "tool": "download_client_archive_diagnosis",
  "arguments": {
    "service": "sonarr",
    "queueId": 1309106746
  }
}
```

## Codex-Terminal Path Diagnostics

The `media-path-check` command runs inside `codex-terminal`, not the MCP sidecars. It only performs `stat` and readability checks:

```sh
media-path-check --json /downloads/example.mkv /media/library-item
```

When `CODEX_MEDIA_PATH_MAPS=/downloads=/mnt/unraid/downloads,/media=/mnt/unraid/media`, the command reports both the original service path and the mapped mount alternative. Keep mounts narrow. Do not mount `/mnt/user`, `/`, `/boot`, appdata, or the Docker socket for this workflow.

## Optional Utilities MCP

`utilities-mcp` exposes a separate `utilities` MCP server for operational services that do not belong in media automation:

- Shared: configured service status.
- Scrutiny: API health, device summary, temperature history, and device details.

## Local Development

Create `.env` from `.env.example`, fill in the required values, then run:

```sh
docker compose config
docker compose build
docker compose up -d
```

For local SSH testing, set `SSH_AUTHORIZED_KEYS` to your public key. To test SSH password login, set `SSH_PASSWORD_LOGIN=true` and exactly one of `SSH_PASSWORD` or `SSH_PASSWORD_HASH`. For local WebUI testing, set `WEBUI_PASSWORD` before starting the container.

The Unraid MCP sidecar entrypoint refuses to start unless `UNRAID_API_URL`, `UNRAID_API_KEY`, and `UNRAID_MCP_BEARER_TOKEN` are set. The media MCP sidecar refuses to start unless `MEDIA_MCP_BEARER_TOKEN` and at least one supported media service credential set are configured. The media issue agent refuses to start if OpenAI API key auth is present or `ISSUE_AGENT_MEDIA_MCP_BEARER_TOKEN` is unset. When `/config/codex/auth.json` is missing, it starts in setup mode so ChatGPT login can be completed. The utilities MCP sidecar refuses to start unless `UTILITIES_MCP_BEARER_TOKEN` and `SCRUTINY_URL` are configured.

To include the optional media sidecar in local compose runs:

```sh
docker compose --profile media config
docker compose --profile media build media-mcp
```

To include the optional media issue agent in local compose runs:

```sh
docker compose --profile issue-agent config
docker compose --profile issue-agent build media-issue-agent
```

To include the optional utilities sidecar in local compose runs:

```sh
docker compose --profile utilities config
docker compose --profile utilities build utilities-mcp
```

## Release Channels

The Docker workflow separates validation from release promotion:

- Pull requests build and scan all images, but do not push tags.
- Merges to `main` build, scan, and push `:main` plus an immutable full commit SHA tag.
- Pushing a Git tag named `v*`, such as `v0.2.0`, builds, scans, and pushes that version tag plus the full commit SHA tag.
- Manual workflow runs promote a chosen Git ref to either `:beta` or `:latest`.

Published images use Docker schema 2 manifests because released Unraid update checkers do not accept individual OCI manifests. The workflow verifies every published tag with Unraid's registry request headers and requires an update digest, so a successful publication also confirms update detection compatibility.

Use these image channels:

- `:beta` for preview installs you control.
- `:latest` for the stable public install path.
- `:main` for the newest merged code after CI passes.
- `:<sha>` for an exact immutable build.
- `:v*` for named release tags.

To promote a ref in GitHub:

1. Open Actions > Docker > Run workflow.
2. Enter the ref to publish, such as `main`, a full commit SHA, or `v0.2.0`.
3. Choose `beta` or `latest`.
4. Run the workflow and wait for the build, scan, and push steps to pass.

Example release flow:

```text
Merge PR to main
Run Docker workflow with ref=main, channel=beta
Test :beta on your Unraid install
Run Docker workflow with the same commit SHA, channel=latest
Optionally create and push v0.2.0 for an immutable named release
```

## Validation

Static checks:

```sh
bash -n entrypoint.sh
bash -n media-path-check
bash -n web-terminal.sh
bash -n codex-terminal-shell
bash -n archive-tools-check
sh -n codex-terminal-profile.sh
npm --prefix media-mcp run check
npm --prefix media-mcp run test:arr-commands
npm --prefix media-mcp run test:repair-capabilities
npm --prefix media-mcp run test:threadfin
npm --prefix media-issue-agent run check
npm --prefix media-issue-agent test
npm --prefix media-issue-agent run test:web
npm --prefix media-issue-agent run sil
npm --prefix utilities-mcp run check
npm --prefix utilities-mcp run test:scrutiny-url
python3 scripts/validate-deployment.py
python3 -c 'import xml.etree.ElementTree as ET; [ET.parse(p) for p in ("templates/codex-terminal.xml", "templates/unraid-mcp.xml", "templates/media-mcp.xml", "templates/media-issue-agent.xml", "templates/utilities-mcp.xml")]'
docker compose config
docker compose --profile media config
docker compose --profile issue-agent config
docker compose --profile utilities config
docker compose --profile media --profile utilities config
tmpdir="$(mktemp -d)" && mkdir -p "$tmpdir/downloads" && touch "$tmpdir/downloads/sample.mkv" && CODEX_MEDIA_PATH_MAPS="/downloads=$tmpdir/downloads" ./media-path-check --json /downloads/sample.mkv >/dev/null
```

CI builds all images locally and scans them with Trivy for fixed high and critical OS/library vulnerabilities on pull requests. Pushes to `main`, tags, and manual runs publish to GHCR only after scans pass.

Container checks:

```sh
mkdir -p /tmp/codex-terminal-smoke
docker run --rm --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m --tmpfs /run:rw,nosuid,size=64m --tmpfs /var/run:rw,nosuid,size=32m -v /tmp/codex-terminal-smoke:/config:rw ghcr.io/shepemer/unraid-addons-codex-terminal:latest /usr/sbin/sshd -t -f /run/codex-terminal/sshd_config
ssh unraid-codex codex --version
ssh unraid-codex test ! -S /var/run/docker.sock
ssh unraid-codex test ! -w /mnt/user
curl -fsS -u codex:<webui-password> http://<unraid-ip>:7681/
```

Unraid acceptance:

- Codex Desktop can connect to `unraid-codex` and open `/workspace`.
- If Codex Desktop reports a version mismatch, restart `codex-terminal` and reconnect.
- MCP can list Unraid system status and Docker containers.
- Optional media MCP can list configured media service status.
- Optional utilities MCP can list configured utility service status.
- Destructive MCP actions require explicit confirmation.
- Recreating containers preserves Codex config, SSH host keys, authorized keys, and workspace files.
- Recreating the issue agent with its appdata parent at `/config` preserves history, logs, repair workspaces, and Codex auth in the existing host subdirectories.

## Security Notes

- Never expose SSH directly to the public internet. Use LAN, VPN, or Tailscale.
- Prefer SSH keys. If SSH password login is enabled, use a strong unique password.
- Never expose the WebUI directly to the public internet. It is an authenticated browser shell, not a hardened public web app.
- WebUI authentication, username, and the safe ttyd log level are fixed in the supported deployment; use a strong password.
- Never mount `/var/run/docker.sock`.
- Never mount `/`, `/boot`, broad `/mnt`, or all of `/mnt/user/appdata`.
- Use a narrow read-only media diagnostic mount. Enable the terminal's read/write downloads mount only for intentional shell-side archive work.
- Keep the Unraid API key only in the MCP sidecar.
- Keep Sonarr, Radarr, Plex, Tautulli, Tracearr, Bazarr, Prowlarr, qBittorrent, NZBGet, Threadfin, and Seerr-family credentials only in the optional media MCP sidecar.
- Keep Scrutiny endpoints only in the optional utilities MCP sidecar.
- MCP sidecars require bearer-token auth; do not add host port mappings for MCP.
- The terminal container root filesystem is writable so it can apply an SSH password at startup. It still runs without privileged mode, host networking, host devices, host PID/IPC, broad mounts, or Docker socket access.
- Codex CLI startup updates download `@openai/codex@latest` from npm as root before user sessions start and fall back to the bundled version on failure.
- The MCP sidecar keeps a read-only root filesystem. It starts as root only to fix ownership on its mounted appdata directories, then runs the server as the unprivileged `mcp` user.
- The media MCP sidecar runs as the unprivileged `mcp` user with a read-only root filesystem. Optional direct-file mounts must be narrow and intentionally read/write.

## MCP Fallback

The default sidecar image builds from pinned `unraid-mcp==1.2.4` from the `jmagar/unraid-mcp` package lineage. If you need a prebuilt fallback image instead, `ghcr.io/mlamoure/unraid-mcp:latest` is documented by that fork, but it should be evaluated separately before use.
