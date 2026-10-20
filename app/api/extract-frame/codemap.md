# /api/extract-frame — ffmpeg frame grabber

## Responsibility
Extracts a single JPEG frame from a video URL with ffmpeg and uploads it to
storage (used for video thumbnails / "use this frame" reference selection).

## Design
- `POST` body `{ videoUrl, timeSeconds? (0), lastFrame? (false) }`.
- `maxDuration = 60`.
- Downloads the whole video into a temp dir (`mkdtemp(os.tmpdir()/frame-*)`),
  probes duration with `ffprobe -show_entries format=duration`.
- Seek strategy:
  - `lastFrame: true` → seek to `duration - 0.1` s.
  - otherwise → clamp `timeSeconds` to `[0, duration - 0.1]` so ffmpeg always
    finds an encodable frame (guards NaN duration → raw `max(0, timeSeconds)`).
- ffmpeg args: `-ss <t> -i in -frames:v 1 -q:v 2 -y out.jpg` (single frame, q2 JPEG).
- Temp files always unlinked in `finally`.

## Flow
1. Validate `videoUrl` → download (400 on upstream failure).
2. ffprobe duration → compute clamped seek time → ffmpeg extract.
3. `uploadBuffer(frameBuffer, "image/jpeg", "references")`.
4. Return `{ cdnUrl }`; errors → 500 with logged `[extract-frame]` prefix.

## Integration
- **Tools**: `ffmpeg`, `ffprobe` (spawned via `execFile`, must be on PATH).
- **Upstream**: arbitrary `http(s)` video URL.
- **Storage**: `uploadBuffer` (`lib/storage.ts`, local `MEDIA_DIR`).
- **Response**: `{ cdnUrl: string }`.
