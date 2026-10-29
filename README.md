# NexShare

**English** · [ภาษาไทย](README.th.md)

Turn your Android phone into a tiny NAS. NexShare runs a web server on the phone
and serves a Synology-DSM-style desktop you open from any device on the same
Wi-Fi at **http://nexshare.local:8080** (or the phone's IP). Browse, upload,
download, stream and manage the phone's files from a browser.

Built with plain Java and a hand-written HTTP server — no Gradle, no AndroidX.

## Screenshots

The web desktop, open in a browser on another device:

![NexShare web desktop](docs/screenshots/web-desktop.png)

The Android app (Root edition):

<img src="docs/screenshots/app.png" alt="NexShare Android app" width="320">

*(running on real hardware; the access PIN is redacted)*

## Two editions

| | **NexShare** (normal) | **NexShare Root** |
|---|---|---|
| Package id | `com.nexshare` | `com.nexshare.root` |
| File Station, Media Player, Download Station, Wallpaper | ✓ | ✓ |
| Install APKs from the web UI | prompts on the phone | **silent** (`pm install`) |
| Terminal (root shell, bundled BusyBox ~300 tools, uses Termux packages too) | — | ✓ |
| Live screen mirror + remote tap/swipe/keys | — | ✓ |
| Keep screen on across the whole device | foreground only | `svc power stayon` |
| App manager (disable/uninstall/force-stop/clear) | open only | full |

Both are signed with the same key and have different package ids, so you can
install them side by side. The Root edition needs Magisk/SuperSU and a granted
root prompt.

## Features

- **File Station** — DSM-style windowed file browser: list/grid views, drag-and-drop
  upload (files and whole folders), multi-select, download (multiple files zip on the
  fly), copy/move/rename/delete, search, image/video thumbnails, breadcrumb nav.
- **Media Player** — playlists, resume where you left off, auto-loads matching
  `.srt`/`.vtt` subtitles, playback speed, loop/shuffle, PiP, YouTube-style
  keyboard shortcuts, and a "open in VLC" fallback for codecs the browser can't play.
- **Download Station** — download from http/https links or BitTorrent
  (magnet links and `.torrent` files, via libtorrent4j) straight to the phone,
  with pause/resume, progress, speed and peers.
- **Remote Access (Cloudflare Tunnel)** — expose the server on the internet with one
  tap. Get a throwaway `https://<name>.trycloudflare.com` URL, or paste a named-tunnel
  token to bind your own domain. `cloudflared` is bundled (arm64 + arm), so no Termux
  needed. Enabling a tunnel force-enables the PIN.
- **Wallpaper** — generate NexOS-branded wallpapers and set them on the phone,
  or set any image in File Station as wallpaper.
- **System widgets** — System Health, Resource Monitor (CPU/RAM/network),
  Storage, battery.
- Reachable at `nexshare.local` via a built-in mDNS responder, with IP fallback.
  Choose your login mode: none, a random 6-digit PIN, or username + password.

## Download

Grab the APK for your edition from the [Releases](../../releases) page:

- `NexShare-vX.Y.Z.apk` — normal edition
- `NexShare-Root-vX.Y.Z.apk` — root edition

Enable "install from unknown sources", install, open the app, grant
**All files access**, and the server starts. Open the shown URL from another
device on the same Wi-Fi.

## Build from source (Windows)

No Android Studio needed — the scripts fetch a private JDK + Android SDK into
`.tools/` and the libtorrent4j jars into `libs/`.

```powershell
./setup.ps1          # one-time: downloads JDK 17 + Android SDK + libtorrent4j + cloudflared (~620 MB)
./build.ps1          # builds both editions into dist/
./build.ps1 -Flavor root     # or just one edition: normal | root
```

Output: `dist/NexShare-v<version>.apk` and `dist/NexShare-Root-v<version>.apk`.

The build runs `aapt2 → javac → d8 → zipalign → apksigner` directly. A signing
keystore is generated on first build and kept in `.tools/` (git-ignored).

## Project layout

```
app/AndroidManifest.xml      app manifest (package/label rewritten per edition at build time)
app/src/com/nexshare/*.java  HTTP server, mDNS, file/download/root APIs, Android glue
app/assets/web/              the web desktop (index.html, style.css, app.js)
app/res/                     launcher icon
build.ps1 / setup.ps1        Gradle-less build + toolchain bootstrap
libs/                        libtorrent4j jars + cloudflared + busybox (fetched by setup.ps1)
```

## Notes & safety

- `usesCleartextTraffic` is on because the server is plain HTTP on the LAN; keep the
  PIN enabled on untrusted networks. Routers with AP/client isolation block
  device-to-device access.
- The Root edition executes shell commands as uid 0 at your request. The terminal,
  app manager and installer act on the device with full privileges — use them as
  carefully as any root tool.
