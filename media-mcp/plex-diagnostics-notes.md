# Plex evidence and diagnostics

The November 2026 production failure was a projection error: `/library/recentlyAdded` returned a `season` record for the requested show's fifth season with ten episodes. The public mapper accepted only `movie`, `show`, and `episode`, so it discarded the evidence. Season results now retain their parent show title, season number/title, episode count, and added date. Mixed recent pages are read within a fixed five-page budget; incomplete filtered results are marked. Show/season children retain added/updated dates and expose bounded offset pagination and completeness.

Plex search limits apply to actual media rows across hubs, rather than merely limiting hub count. Internal media rating keys remain available for subsequent metadata reads; public recent-addition responses do not expose them.

## Operator capabilities and limits

- `plex_scan_library_path` and alias `plex_scan_section_path` use `POST` for section refresh, with `GET` compatibility fallback only after a 404/405. `plex_scan_status` reads section flags and matching activities. Acceptance and idle state never claim the requested media was successfully imported; exact metadata must be verified afterward.
- `plex_playback_attempt_diagnostics` and `plex_issue_session_correlation` filter active sessions by exact item/session, with optional exact user/client identifiers. They retain selected media/streams and client model/version. They do not infer a successful playback or join people by display-name similarity.
- `plex_transcode_session_diagnostics` includes matching active transcode state and optional retained log evidence. `plex_transcoder_logs_for_session` downloads the server log ZIP in memory, enforces byte/member/decompression bounds, and returns only exact-session matches with optional time filtering. Plex timestamps without a zone use the supplied `timezoneOffsetMinutes` (default UTC). Unavailable or expired logs remain unavailable; these tools cannot reconstruct past client-displayed errors or client app logs.
- `plex_test_playback` is a dry-run-first **server decision test**, with explicit profile/settings. It reads the direct-play/transcode decision and rejection reasons. It never starts a real player or claims the affected physical client decoded the media successfully.
- `plex_set_stream_preferences` (compatibility alias `plex_set_default_stream_or_mkv_track_flags`) verifies exact item/part/stream membership before writing, defaults to dry run, and verifies the resulting selection. The change is the configured token user's Plex preference. It does not modify MKV flags or another user's settings.

Session/log tools and preference/decision operations are unavailable to public Slack research. They are operator tools; repairs retain the existing approval gate.

## Source references

- [Official Plex Media Server API](https://developer.plex.tv/pms/) documents show/season children and container paging, `POST /library/sections/{sectionId}/refresh`, `GET /activities`, the universal playback decision endpoint, and `PUT /library/parts/{partId}` stream selection.
- [Plex staff explanation of refresh compatibility](https://forums.plex.tv/t/api-library-refresh-clarification/932118) confirms legacy GET compatibility; [the earlier PUT regression explanation](https://forums.plex.tv/t/refresh-endpoint-put-post-requests-started-throwing-404s-in-version-1-32-7-7484/853588) explains why PUT is incorrect.
- [Plex server-log documentation](https://support.plex.tv/articles/200250417-plex-media-server-log-files/) describes the server-generated ZIP. [Python-PlexAPI's server implementation](https://github.com/pkkid/python-plexapi/blob/master/plexapi/server.py) uses `/diagnostics/logs` and `/transcode/sessions`.

Validation uses mock Plex endpoints and synthetic archives. Production diagnosis remains read-only; no real scan, stream-preference write, or playback test is run during validation.
