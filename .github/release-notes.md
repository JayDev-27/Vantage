## Vantage 1.2 — stable, vertical-ready, 10× the library

**Website:** https://vantagewall.vercel.app

### Downloads
| Platform | File |
|:--|:--|
| macOS · Apple Silicon (M1–M5) | `Vantage-1.2.0-arm64.dmg` |
| macOS · Intel | `Vantage-1.2.0-x64.dmg` |
| Windows 10/11 · x64 | `Vantage-Setup-1.2.0-x64.exe` |
| Windows 11 · ARM | `Vantage-Setup-1.2.0-arm64.exe` |

### Fixed
- **Windows:** wallpapers now actually sit behind your desktop icons. In 1.1 the attach step failed and left a black full-screen window on top of everything.
- **Windows:** bundled and imported videos now load (local file URLs were broken on Windows drive paths).
- **macOS:** wallpapers no longer draw over full-screen apps, and never flash black or blank while loading. The gallery always appears, even on GPUs that never report "ready".
- Streaming wallpapers show their preview while downloading instead of a black screen.
- Battery Saver no longer plays videos in slow motion.
- **Anime in one place:** 274 wallpapers moved to their correct category using MotionBGS's own tags.

### New
- **13,000+ wallpapers** (up from 1,330), with thumbnails streamed so the installer doesn't grow.
- **Vertical monitors:** 3,300+ 9:16 wallpapers, a Vertical collection with tall tiles, a rotated display icon, a hint when your selected display is vertical, and Shuffle that picks wallpapers matching the display's orientation.
- **MoeWalls:** linked from My Imports and Credits. Download there, drop the file into the watched folder, and it appears automatically.
- Faster launches: the catalog is only re-synced when it changes.

### First launch
- **Mac:** Vantage isn't notarized by Apple yet. If macOS says it can't verify the app, open **System Settings → Privacy & Security** and click **Open Anyway**.
- **Windows:** the installer isn't code-signed yet; on SmartScreen choose **More info → Run anyway**.

Every build is launched as a fresh install on clean macOS and Windows machines in CI before release (gallery, catalog, every wallpaper window, desktop attach).
