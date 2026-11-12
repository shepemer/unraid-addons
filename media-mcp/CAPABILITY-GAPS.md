# Media capability backlog audit

This follow-up covers all 30 active MCP capability reports retrieved from the issue agent on 2026-11-12. Repeated reports are grouped below. It does not dismiss the persisted backlog or execute repairs on the server.

| Backlog IDs | Capability | Implementation / boundary |
| --- | --- | --- |
| 102 | Exact Prowlarr torrent handoff | Fetch the torrent payload inside media-mcp, submit its bytes, and verify the resulting torrent by its computed identity. An unrelated newly added torrent is never accepted as proof. |
| 101 | Pending URL diagnostics and cancellation | Media-mcp-managed handoffs expose job status and cancellation before submission. Native qBittorrent URL jobs without an upstream status/cancel API remain explicitly unknown; cancellation does not delete an imported torrent. |
| 96, 83, 81, 65 | Playback/session/transcoder diagnostics | Scoped Plex session metadata and available server logs support correlation. Missing historical client errors remain unavailable. These private diagnostic tools are excluded from Slack's read-only gateway. |
| 90 | Delayed Sonarr replacement suppression | Bounded observation includes resulting search-command state and queue changes; an unfinished observation cannot claim suppression is complete. |
| 89, 48 | Plex path scan and scan status | Correct the section refresh HTTP method and expose activity/status evidence. Accepted scan requests do not prove completion. |
| 84, 73, 56, 54 | Readable media path mapping | Existing configured mappings remain authoritative. Common library markers now include `TV Shows`; `media_path_map_status` exposes mapping/access diagnostics, constrained to existing media roots. |
| 82 | Safe compatibility remux | `media_remux_compatibility_copy` creates a separate MKV copy, optionally changes audio encoding/default stream flags, and verifies stream count, duration, codec and requested flags. It never overwrites the original. |
| 74 | Playback test harness | Bounded server-side transcode decision diagnostics expose server decisions/errors. They cannot certify playback on a particular physical client. |
| 68, 64 | Interval decode probe | `media_probe_decode_interval` decodes a bounded audio/video interval through ffmpeg, with process and output limits. It reports the exact tested interval. |
| 67, 57 | Radarr imported-source suppression | Derive an exact release from file/history evidence and suppress that release through an isolated profile assigned only to that movie, without initiating a retry. This is explicitly distinct from an unsupported native blocklist insertion. |
| 66, 55 | Radarr movie monitoring | Dry-run-first exact movie monitoring updates with verification. |
| 63 | Default audio/subtitle stream | Scoped Plex stream preference support and the separate compatibility-copy tool cover account-specific selection and file default flags respectively; neither is represented as the other. |
| 62 | Download/import watcher | Bounded, exact-identifier observation of download/queue/history/import state; timeout means incomplete, not repaired. |
| 53 | Sidecar backup and retime | `media_retime_subtitle_sidecar` validates SRT cues and shifts timestamps. Apply requires the inspected SHA256; it writes a separate copy by default and creates an exclusive backup before optional replacement. |
| 52 | Subtitle timing verification | `media_verify_subtitle_sync` returns cue timings and comparisons with a supplied known-good SRT reference. Timestamp agreement alone does not prove spoken-audio synchronization. |
| 51 | Missing-episode candidate matrix | Series/season-scoped candidate checks retain parser mappings and rejection reasons with bounded work. |
| 50 | Series missing-episode report | Scoped missing episode inventory avoids scanning unrelated series. |
| 49 | Exact Prowlarr TV search | TV identifier/season/episode scoped discovery retains strict matching evidence; ambiguous releases cannot be labeled safe to grab. |
| 47 | Series file listing | `media_list_series_files` lists a bounded exact mapped directory, skips symlinks, and rejects targets outside configured media roots. |
| 24 | Direct Sonarr candidate suppression | Already covered by `sonarr_blocklist_release_candidates`, using exact candidate custom-format suppression where native blocklist insertion is unsupported. |

## Chat evidence fixes

Plex returns season records from its global recent-additions endpoint. Dropping those records hid season 5 even though Plex had all ten episodes. Recent additions now preserve season identity and addition timestamps; season/episode listings retain date and pagination evidence. A season-specific claim must use that season's records, not whole-series file totals or Seerr's cached availability.

The chat gateway preserves Plex's structural `MediaContainer.Directory` collection while removing filesystem locations and identifying fields. Large nested results retain useful bounded records instead of becoming an empty truncation marker. Media identifiers can be used internally to traverse discovered tools; they are removed from the presentation evidence and must never be included in public web queries or Slack replies. Diagnostic telemetry records tool names, outcomes and budgets without raw parameters or results.

Watch-time research supports all retained history, calendar lookbacks in days/months/years, and explicit date ranges. The same scope is preserved through chat classification, research, the MCP tool and the reply. Whole-library totals use Tautulli's aggregate duration; exact-title queries filter history privately and can continue with an opaque cursor. Results identify incomplete coverage, and continuation totals replace the preceding cumulative total. Request duration, API calls and response size remain limited; the requested calendar period is not silently shortened.

Existing Slack threads do not reopen or launch another investigation merely because someone adds a comment. Information questions and incidental conversation are separate from issue evidence and owner commands. An owner's `stop investigating` pauses the issue durably, cancels its active investigation and suppresses stale findings; `re-investigate` explicitly resumes it. Stopping an investigation does not cancel an approved repair.

## Operational constraints

The file tools need an existing media mount and `MEDIA_MCP_MEDIA_ROOTS`; they do not add mounts or Docker access. New mutation tools use dry-run defaults and remain behind the existing repair approval workflow. The chat gateway cannot invoke them. All processes, result sizes, directory traversal and polling are bounded. Default compatibility remuxes preserve the source; subtitle replacement requires a fresh content fingerprint and retains the original backup.

Video probes and compatibility copies restrict FFmpeg to local binary media containers; playlist/concat demuxers and network protocols are excluded. Default-track changes preserve unrelated flags such as forced subtitles and hearing-impaired tracks. See the [FFmpeg format options](https://ffmpeg.org/ffmpeg-formats.html) for the input format whitelist and container behavior.

The live audit used read-only API calls and stored-log inspection. Production scans, downloads, stream changes, file rewrites and playback tests were not executed as part of the audit.
