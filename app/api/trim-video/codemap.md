# /api/trim-video — ffmpeg stream-copy trimmer

## Responsibility
Trims a video between two timestamps and stores the result, without re-encoding.

## Design
- `POST` body `{ videoUrl, startTime, endTime }`; requires both times and
  `endTime > startTime` (400 otherwise).
- `maxDuration = 120` (longest of the media routes — downloading + encoding headroom).
- Downloads the source into a temp dir (`mkdtemp(os.tmpdir()/trim-*)`).
- ffmpeg: `-ss <start> -i in -t <duration> -c copy -avoid_negative_ts 1 -y out`
  — fast seek before `-i`, **stream copy** (no re-encode, keyframe-aligned cuts).
- Temp input/output always unlinked in `finally`.

## Flow
1. Validate body → fetch video (400 on failure), keep upstream `content-type`
   (fallback `video/mp4`).
2. Write temp files → run ffmpeg trim.
3. `uploadBuffer(outputBuffer, mime, "references")`.
4. Return `{ cdnUrl }`; errors → 500 with logged `[trim-video]` prefix.

## Integration
- **Tools**: `ffmpeg` on PATH (`execFile`).
- **Upstream**: arbitrary `http(s)` video URL.
- **Storage**: `uploadBuffer` (`lib/storage.ts`, local disk, `references/` folder).
- **Response**: `{ cdnUrl: string }`.
