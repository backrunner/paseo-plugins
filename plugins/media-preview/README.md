# Media Preview

Paseo file panel for audio and video. See [OVERVIEW.md](OVERVIEW.md) or [中文说明](OVERVIEW.zh-CN.md) for capabilities and limits.

From the workspace root:

```sh
pnpm install
pnpm --filter @paseo-plugins/media-preview typecheck
pnpm --filter @paseo-plugins/media-preview test
pnpm --filter @paseo-plugins/media-preview test:browser
paseo plugin install /absolute/path/to/paseo-plugins/plugins/media-preview --home /absolute/path/to/paseo-home
```

Plugins must already be enabled on the target daemon. Source changes require `paseo plugin reload media-preview --home /absolute/path/to/paseo-home`. A daemon restart is unnecessary.

The browser check requires FFmpeg on PATH and Google Chrome. It generates test media in a temporary directory, runs the actual panel with React Native Web and a fixture file handle, and prints the screenshot directory. Set `MEDIA_TEST_BROWSER=chromium` to use Playwright's installed Chromium instead. This test does not connect to or alter a Paseo daemon.

The plugin is client-only. Cross-platform layout and copy live in `client/panel.tsx` and `client/messages.ts`; browser media APIs are isolated in `client/web.ts`, which returns no content on native platforms. `client/load.ts` owns read/watch races and loading/error states. The host owns file URLs and access control.

The 1 GiB limit is a pre-read check against the latest host stat, not a hard memory guarantee during a concurrent file replacement. Paseo's public file URL API does not expose a byte limit or a cancel signal. Superseded reads cannot update the player, but an in-flight host read may still finish.

Changes received while a read is in flight are coalesced into one subsequent read. A single observer never starts multiple full-file reads concurrently.
