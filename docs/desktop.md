# Desktop app

The desktop app is the SevenAI runtime (the same local server and web frontend used in development) hosted by Electron. It adds only what a team member's laptop needs: a per-user data location, an OS-sealed login, a single instance, microphone permission and a clean exit.

The desktop client is **distributed internally to the company's authenticated team**. This repository is a showcase and does not distribute installers.

Related: [architecture.md](architecture.md) · [security.md](security.md) · [presentation-versioning.md](presentation-versioning.md)

## Platforms

| Platform | Package | Notes |
|---|---|---|
| Windows x64 | NSIS installer, per-user, no administrator rights | desktop and start-menu shortcuts |
| macOS arm64 (Apple Silicon) | DMG | hardened runtime; microphone usage description |
| macOS x64 (Intel) | DMG | built with the x64 wake-word native addon |

## Process model

```text
Electron main process
 ├─ per-user data root, OS-sealed auth key, rotating logs
 ├─ single-instance lock, permission policy
 ├─ BrowserWindow → http://127.0.0.1:<port>/   sandboxed, context-isolated, no Node
 └─ utilityProcess → local server              bound to loopback only
```

- The frontend is served over **loopback HTTP**, not `file://`, exactly as in a browser. There is no Electron-specific IPC the web app depends on, so "works in the browser" and "works in the app" mean the same thing.
- The app prefers a stable port (a stable origin keeps the microphone permission and local settings) and lets the OS pick a free port if another program holds it.
- The local server's environment is built in one tested function that sets data paths and strips secrets in packaged builds.
- The wake-word native addon and model files are unpacked from the app archive, because native code opens them with plain file I/O. If they cannot load, Space activation still works.

## Sign-in and catalogue

1. The member signs in with their SevenAI account. The login goes through the local server to the cloud, and the refresh token is stored encrypted and sealed to the OS account.
2. The local server obtains a provider lease. A cloud instance that is still waking delays the lease, not the app: renewal is retried on a short backoff, and activations show a "not ready yet" message until providers arrive.
3. The dashboard lists team presentations, newest first. Decks not on this laptop show **"Prenesi predstavitev"** (Download presentation). Decks with a newer published version show **"Posodobi"** (Update).
4. The login persists between launches. **"Odjava"** (Log out) erases it and keeps downloaded presentations and Sessions.

## Local downloads and offline playback

- A download fetches the version record and media, verifies every blob's SHA-256 and size, builds the version directory atomically, and only then activates it.
- Once downloaded, a presentation **plays with no internet**: slides, video, navigation and the assistant animation are all local. Answering questions still needs network access to the AI providers.
- A running Session is pinned to its version, and an update never replaces media during a meeting. See [presentation-versioning.md](presentation-versioning.md).
- Presenter edits (settings, scripted Q&A) are stored beside the immutable download.

## Settings

- **Per presentation:** assistant size, subtitles, speaking speed, greeting and scripted Q&A ("Vprašanja in odgovori").
- **Per laptop:** VAD calibration and the recording preference.
- **"Prenesene predstavitve"** (Downloaded presentations) shows what is on disk, and **"Odstrani prenesene predstavitve"** removes only downloaded decks. The action is refused while a Session is open or a download is running.
- **"Upravljanje predstavitev"** (Presentation management) is visible to admins, who can delete or archive a team presentation.

## Presentation cleanup

- A deck an admin removes disappears from the dashboard at the next catalogue refresh. Its local download is removed once no Session is using it.
- Cache garbage collection keeps recent versions and never removes the active or pinned one.

## Sessions

- Sessions are stored under the per-user data root, separate from the app installation and from downloaded presentations.
- A Session still open when the app quits is left active and offered for recovery on the next launch.
- On quit, the window closes first (stopping the microphone, STT and speech), then the local server flushes cloud sync within a bounded time and exits.
- **Uninstalling removes the application only.** Sessions, downloads, deck settings and the sealed login stay, so reinstalling or updating never loses a meeting.

## Data locations

| | Windows | macOS |
|---|---|---|
| User data root | `%APPDATA%\SevenAI\` | `~/Library/Application Support/SevenAI/` |
| Presentation cache | `<userData>\cache\presentations\` and `cache\blobs\` | same, under userData |
| Sessions | `<userData>\sessions\` | same |
| Presenter edits | `<userData>\deck-settings\` | same |
| Logs | `<userData>\logs\` (rotated) | same |

Development runs use a separate data root, so they never touch an installed app's data.

## CI builds

Installers are built by a manually triggered **GitHub Actions** workflow:

- **Windows job** on a Windows runner and a **macOS matrix** (arm64, optional x64) on Apple Silicon runners.
- Each job installs dependencies, fetches the wake-word model (checked against pinned SHA-256 hashes), runs the desktop test suite (skipped on the optional Intel macOS job), builds with electron-builder, verifies the macOS bundle (code signature, microphone usage string, architectures, native addon), **scans the output for secrets and user data**, and uploads the installer as a short-retention workflow artifact for internal distribution.
- Signing steps run only when signing credentials are configured. No production secrets are used.

There is no auto-updater. Desktop updates are new internal builds, while presentation content updates through the cloud without a reinstall.
