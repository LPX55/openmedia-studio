# app/gallery/codemap.md

Covers `app/gallery/page.tsx` (~1.1k lines, single client module).

## Responsibility
Media gallery + generation console at `/gallery?tab=images|videos&source=generated|uploaded`. Masonry grid of `GalleryItem`s with infinite scroll, marquee multi-select, folders, lightbox, and a full generation composer (model/aspect/quality/duration, reference images/videos/audio, `@mention` prompt resolution, pending-generation polling).

## Design
- Client component; `GalleryInner` is the workhorse, wrapped in `Suspense` for `useSearchParams`. Tab and source are URL params (`tab` defaults `images`, `source` defaults `generated`).
- Auth is stubbed: `user` set to `{id:"guest"}` on mount (local stand-in for removed Supabase type).
- **Module-level caches/cursors** (survive route remounts): `loadedImageUrls`, `naturalRatioCache`, `galleryCache` (from `galleryUtils`), plus sessionStorage persistence of ratios (`hg-ratios`) and loaded state (`hg-loaded`) for stable cold-load layout.
- **Image concurrency limiter**: `requestImageSlot`/`releaseImageSlot` cap gallery image loads at `IMG_CONCURRENCY = 4`.
- **Cross-component drag**: module-level `_galleryDragItem`, `_reorderDragItem`, `_reorderOverId`, `_reorderJustDropped` avoid `dataTransfer.getData()` quirks.
- **Per-folder settings**: `settingsKey(tab, folderId)` → localStorage `nf-gallery-{tab}[-folder-{id}]`; `loadSettings`/`saveSettings` with `SavedSettings` shape (prompt, modelId, ratios, ref URLs, video refs, Kling elements, taggedImages…).
- **Mention engine**: `resolveGalleryMentions` rewrites `@imageN` tags into `<<<image N>>>` (or `@imageN` for grok format) and returns `extraUrls`/`extraAssets`; `splitByMentions`/`renderGalleryMentions` render chip spans; `removeTagAndRenumber` and `reorderAndRenumberTags` keep label numbering coherent.
- `mergeByNewest` merges paginated fetches by `created_at` desc, dedup by `id`.
- Pending gens persisted in `localStorage["aiui-pending-gens"]` with `prePending` stripped on restore (skips the 3s cancel window after refresh).
- Components: `PendingGenTile` (spinner pill, pre-pending Cancel, prompt overlay), `EmptyFan`/`GalleryLoggedOut` (logged-out hero), `VideoFan`, `MediaPickerModal`, `QuickAssist`, `Kbd`, `DotCanvasBackground`.
- Thumb URLs built manually via `/_next/image?url=…&w=…&q=75` with `snapWidth` snapping to `NEXT_IMG_WIDTHS`; `thumbSrc` bypasses optimizer for blob/data/`/_next/` URLs.

## Flow
**Item loading:** `loadItems(tab, page, replace)` → cache-first sync apply (replace mode) or `loadingMoreRef` lock → `getToken()` → `fetch("/api/gallery?type={image|video}&page=&source={generation|upload}")` → merge + `galleryCache.set` → update `hasMore`, `pageRef` → `useFolderStore.setGalleryCount(total)` → `requestAnimationFrame` post-load check: if grid doesn't fill viewport and no folder active, `postLoadCheckRef.current()` triggers next page.
**Generation resume (mount):** for each stored `PendingGen` with `taskId` → immediate `GET /api/job-status?taskId=`; `not_found` → drop; still running → `pollTask(taskId)`; done → `fetchNewItems(tab)` (page 0, source=generation) → `mergeByNewest` into items/cache → `assignItemsToFolder(fresh, pending.folderId)` when folder-scoped → `onGenComplete(folderId, freshIds)` → `useFolderStore.addUnseenFolder` / `setUnseenAllAssets` for other-folder results → dispatch `Event("credits-refresh")`.
**Folder sync:** effect derives generating folder ids from `pendingGens` → `useFolderStore.setGeneratingFolderIds` / `setGeneratingAllAssets`.
**Marquee select:** document-level `mousemove`/`mouseup` with 5px threshold → intersect `[data-item-id]` rects against marquee → `setSelectedIds`; `click` capture + `wasDraggingRef` block accidental preview open; `dragstart` capture prevents native DnD stealing events.
**Tab switch:** clear selection, reset `pageRef`/`hasMore`, swap items from cache, reload models/settings for new tab (`skipNextModelEffect` avoids double-fires), restore per-folder saved settings into composer state.

## Integration
- Depends on: `@/lib/galleryUtils` (`GalleryItem`, `getToken`, `galleryCache`), `@/lib/modelConfig` (`IMAGE_MODELS`, `VIDEO_MODELS`, `AZURE_POPULAR_SIZES`, `validateAzureCustomSize`), `@/lib/providers` (`PROVIDERS`, `getModelProvider`, `setModelProvider`, `modelHasProviderChoice`), `@/lib/store` (`useWorkflowStore` — `debugMode`, `addToast`, `kieKeySet`, `setKieKeySet`), `@/lib/folderStore` (`useFolderStore` — folder CRUD, counts, unseen markers), `@/lib/browserNotify`, `@/components/MediaPickerModal`, `@/components/QuickAssist`, `@/components/ui/sidebar` (`useSidebar`), `@/components/ui/{kbd,button,DotCanvasBackground}`, `lucide-react`, `next/navigation`, `createPortal`.
- Depends on APIs: `/api/gallery`, `/api/job-status`.
- Consumed by: `app/page.tsx` redirects here (`?tab=images`); sidebar "clean failed jobs" via `window` `CustomEvent("clean-failed-jobs", {detail:{folderId}})`; emits `Event("credits-refresh")` for credit UI; drag payloads read by workflow canvas drop handlers (module-level `_galleryDragItem` contract).
