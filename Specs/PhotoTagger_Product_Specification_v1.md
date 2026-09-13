# PhotoTagger Product Specification

**Document version:** 1.0  
**Product version:** Version 1  
**Status:** Approved product baseline; ready for technical design  
**Target platform:** Windows x64 on an NTFS external HDD  
**Working product name:** PhotoTagger  
**Date:** 2026-09-13

## 1. Purpose

This document defines the product intent, boundaries, workflows, user experience, and success criteria for PhotoTagger version 1. It is the product-level source of truth for the subsequent functional specification, technical architecture, database design, implementation plan, and acceptance testing.

PhotoTagger is a portable, fully local Electron application for importing, normalizing, viewing, organizing, and hierarchically tagging a large personal photo collection. The application is deliberately narrow: it should make processing and tagging many photos fast without becoming a general-purpose photo editor or cloud photo service.

## 2. Product summary

The user places supported images into an Inbox folder located with the portable application. PhotoTagger validates each file, preserves existing JPEG image data whenever possible, converts supported non-JPEG images to JPEG, assigns a permanent numeric identity, moves the result into one flat Storage folder, creates thumbnails, imports existing tags, and indexes the collection in SQLite.

The user can then work in either Image View or Library View:

- **Image View** supports focused, sequential tagging of one image.
- **Library View** supports tag filtering, flag filtering, thumbnail browsing, selection, and batch tagging.
- **Edit mode** exposes tagging and photo-management controls.
- **View mode** hides and disables the Tagging Panel for an uncluttered browsing experience.

SQLite is authoritative for application state and search. Selected tags are also written into standards-compatible JPEG metadata so that the catalog remains portable and partially recoverable without the database. No internet connection, account, cloud service, or remote API is required.

## 3. Problem statement

Large folders of loosely organized images create several practical problems:

- Import formats and metadata are inconsistent.
- Original filenames do not provide stable or searchable identity.
- Manually tagging files one at a time is slow.
- Sidecar files are cumbersome to maintain and easy to separate from their images.
- Rewriting existing JPEG image data during import wastes time, causes unnecessary disk writes, and risks quality loss.
- A catalog that exists only in a database is difficult to recover or use in other software.
- A catalog that exists only in embedded metadata is inefficient to search at scale.
- Removable-drive operation increases the likelihood of interrupted writes and changing drive letters.

PhotoTagger addresses these problems by combining a searchable SQLite catalog with synchronized embedded metadata, a batch-oriented tagging interface, and journaled file operations designed for a removable NTFS drive.

## 4. Product vision

PhotoTagger should feel like a small purpose-built appliance rather than a complex digital-asset-management suite. The user should be able to copy the application folder to an external HDD, drop photos into Inbox, click Import, and begin tagging without installation or network access.

The product prioritizes:

1. Preservation of photo data.
2. Clear and predictable behavior.
3. Minimal drive writes.
4. Fast tagging of large collections.
5. Recoverability after interruption or catalog loss.
6. Interoperable metadata.
7. A restrained, lightweight interface.

## 5. Intended user and environment

### 5.1 Primary user

Version 1 is designed for one person managing one collection on one computer at a time.

The user:

- Maintains separate backups of the source photos.
- Manually places files into Inbox.
- Wants mostly flat tags with support for meaningful hierarchies such as `People/Family/Josh`.
- Expects the application to work without internet access.
- May move the external HDD between Windows drive letters.
- May occasionally inspect or edit JPEG metadata with another application.

### 5.2 Operating environment

- Windows x64.
- NTFS-formatted external HDD.
- Inbox, Storage, database, cache, logs, recovery data, and settings located beneath the portable application folder.
- Inbox and Storage on the same physical volume.
- One running PhotoTagger instance for a collection.

## 6. Product principles

### 6.1 Local first

All features must function offline. Version 1 will not contain telemetry, cloud synchronization, online accounts, remote assets, advertising, or an automatic updater.

### 6.2 Preserve before modifying

The application must verify files before deleting sources, never overwrite an unresolved external change, and never delete the only known valid copy during recovery.

### 6.3 Avoid unnecessary image writes

An existing JPEG is moved and renamed without re-encoding. Rapid tag edits are coalesced so that one image is not rewritten repeatedly. Directory moves are preferred for active-to-Trash and Trash-to-active transitions.

### 6.4 Database speed with file portability

SQLite is authoritative for application behavior. JPEG metadata provides interoperability and a secondary recovery source, but is not searched directly during normal operation.

### 6.5 Explicit actions for destructive outcomes

Normal deletion is reversible. Permanent deletion, bulk metadata rewrites, catalog rollback, and other consequential actions require explicit confirmation and provide scope information before execution.

### 6.6 Failure isolation

One corrupt, locked, or unsupported input must not stop the remainder of an import batch. One failed metadata write must not block navigation or unrelated work.

## 7. Goals

| ID | Goal |
| --- | --- |
| PS-01 | Operate completely offline with all application-owned data stored locally. |
| PS-02 | Run portably from an external NTFS HDD without installation or fixed drive-letter assumptions. |
| PS-03 | Import a large Inbox safely and sequentially with resumable operations. |
| PS-04 | Preserve existing JPEG image data by moving rather than re-encoding it. |
| PS-05 | Normalize supported PNG and still WebP inputs into verified JPEGs. |
| PS-06 | Assign every imported photo an immutable numeric identity and deterministic filename. |
| PS-07 | Provide fast SQLite-backed search and authoritative catalog state without per-photo sidecars. |
| PS-08 | Write hierarchical and broadly compatible flat tags into JPEG metadata. |
| PS-09 | Support nested tag hierarchies while keeping flat tagging efficient. |
| PS-10 | Provide focused Image View and scalable Library View workflows. |
| PS-11 | Support safe tagging and flagging of multiple selected photos. |
| PS-12 | Provide separate Edit and View modes without duplicating navigation. |
| PS-13 | Communicate Inbox count, current view, writes, and actionable problems in a compact interface. |
| PS-14 | Make ordinary photo deletion reversible through an internal Trash. |
| PS-15 | Detect and safely reconcile files changed outside PhotoTagger. |
| PS-16 | Back up, restore, and rebuild the catalog without requiring cloud services. |
| PS-17 | Remain responsive with a target collection of 100,000 photos and 10,000 tags. |
| PS-18 | Recover deterministically from application interruption, power loss, or removable-drive disruption. |
| PS-19 | Expose maintenance and diagnostics without cluttering the primary tagging workflow. |

## 8. Non-goals for version 1

PhotoTagger version 1 will not provide:

- Photo editing, cropping, color correction, retouching, or filters.
- RAW, HEIC, TIFF, AVIF, BMP, animated WebP, or GIF ingestion.
- Video or audio management.
- Facial recognition, object detection, automatic AI tagging, or geocoding.
- Cloud storage, cloud backup, remote access, synchronization, or multi-user collaboration.
- Multiple simultaneous computers managing the same catalog.
- Date-based Storage folders.
- Per-photo metadata sidecar files.
- Duplicate detection based on visual similarity or perceptual hashing.
- Automatic emptying of Trash.
- Restoration of permanently deleted photo bytes from catalog backups.
- Editing of arbitrary EXIF, XMP, IPTC, GPS, camera, copyright, or rating fields.
- Re-encoding existing JPEGs merely to standardize quality or orientation.
- Automatic processing triggered solely by placing a file in Inbox.

## 9. Version 1 scope

### 9.1 Supported inputs

- JPEG files identified by content, including `.jpg` and `.jpeg` filenames.
- PNG files identified by content.
- Still WebP files identified by content.

The application inspects file contents rather than trusting extensions. Animated WebP and GIF files are rejected rather than silently flattened to one frame.

### 9.2 Stored photo format

All active photos are stored as JPEG files in one flat Storage directory. Each filename is the zero-padded immutable SQLite photo ID:

```text
0000000427.jpg
```

The filename never changes after assignment, even if tags, flags, metadata, or the original filename change.

### 9.3 Catalog model

The SQLite catalog contains photos, hierarchical tags, explicit photo-tag assignments, Tag Pallet entries, settings, flags, hashes, revisions, job state, recovery state, backups, and audit information.

Tag assignments stored in SQLite are explicit. Ancestors are inferred for navigation, filtering, and metadata compatibility. For example, assigning `People/Family/Josh` stores the `Josh` node as explicit while allowing searches for `People` or `Family` to match the photo.

### 9.4 Metadata model

The application owns only its designated tag, preserved-name, metadata-date, and embedded-thumbnail fields. It preserves unrelated metadata whenever technically safe.

| Purpose | JPEG metadata target |
| --- | --- |
| Full hierarchy | `XMP-lr:HierarchicalSubject` |
| Flat compatibility keywords | `MWG:Keywords`, synchronizing `XMP-dc:Subject` and existing IPTC keywords |
| Windows compatibility | `EXIF:XPKeywords` |
| Original filename | `XMP-xmpMM:PreservedFileName`, only when previously empty |
| Application metadata edit time | `XMP-xmp:MetadataDate` |
| Embedded thumbnail | EXIF IFD1 thumbnail, when capacity permits |

Flags remain SQLite-only and are not mapped to rating or label fields.

## 10. Primary workflows

### 10.1 First run

1. The user launches PhotoTagger from its external-drive folder.
2. The application resolves the Collection directory relative to its portable location.
3. Required directories and a new catalog are created if absent.
4. The application verifies that the Collection volume is writable.
5. Startup recovery and catalog checks run as required.
6. Image View opens if photos exist; otherwise the application presents an empty-state explanation directing the user to Inbox.

The application must not silently create a fallback collection on another drive if the intended Collection directory is unavailable.

### 10.2 Importing photos

1. The user copies files into `Collection/Inbox` using Windows Explorer.
2. The status bar reports the number of top-level files waiting in Inbox.
3. The user clicks the Import icon.
4. PhotoTagger snapshots the current top-level Inbox file list and processes it in natural filename order.
5. Supported files are stabilized, validated, hashed, journaled, assigned IDs, moved or converted, verified, thumbnailed, indexed, and cleaned up.
6. Unsupported or corrupt inputs move to Failed with a recorded reason.
7. Files added after the import began wait for the next run.
8. The user may request **Stop After Current Photo**; the current file reaches a safe boundary and remaining files stay in Inbox.

Import is never initiated automatically by filesystem arrival alone.

### 10.3 Tagging one photo

1. The user opens a photo in Image View while Edit mode is active.
2. Existing explicit tags appear below the Tag Pallet.
3. Previously created tags are suggested in the `Add a tag...` field.
4. Clicking or entering a tag changes the SQLite assignment immediately.
5. Nested tag branches expand directly beneath their parent.
6. The application coalesces rapid changes and writes the newest complete tag set to JPEG metadata in the background.
7. Next and Previous navigate within the active Library result sequence.

The user does not need to wait for metadata synchronization before continuing.

### 10.4 Browsing and filtering

1. The user switches to Library View.
2. A virtualized, scrollable thumbnail grid shows the current result set.
3. The user adds one or more tag-filter pills through autocomplete.
4. Multiple tag filters use AND logic.
5. A parent filter includes its descendants.
6. The flag filter optionally restricts the results to flagged photos.
7. Results default to newest import first.

Changing a filter clears selection so hidden photos cannot remain selected accidentally.

### 10.5 Opening a filtered photo sequence

1. The user selects one Library thumbnail.
2. The Image View button becomes available.
3. Clicking it opens the selected photo.
4. The ordered IDs from the current filtered Library are frozen for that viewing session.
5. Next and Previous remain limited to that sequence, even if edits change whether the current photo would still match the filter.
6. Returning to Library preserves the filter controls and refreshes the result query.

When multiple thumbnails are selected, Image View is visibly disabled and unavailable.

### 10.6 Batch tagging

1. The user selects one or more Library thumbnails or selects all filtered results.
2. Tag Pallet pills show Off, Mixed, or On assignment states.
3. Tag interactions stage apply or remove operations for the current selection.
4. The user clicks **Apply tags to selected**.
5. PhotoTagger commits the batch in one SQLite transaction.
6. One coalesced metadata job is queued for each affected photo.
7. The user may continue working while writes complete sequentially.

Library View tag changes are staged even when only one thumbnail is selected; Image View remains the immediate single-photo tagging workflow. Large batches show the affected photo count before confirmation.

### 10.7 View mode

1. While Edit mode is active, the mode control displays a magnifying-glass action for entering View mode.
2. Entering View mode hides and disables the Tagging Panel.
3. Photo viewing and Library navigation remain available.
4. The mode control changes to a pencil action for returning to Edit mode.

### 10.8 Deleting and restoring photos

1. The user clicks the Trash icon for the current or selected photos.
2. A Yes/No dialog confirms the number of affected photos.
3. Confirmed photos move into internal Trash through same-volume directory operations.
4. Trashed photos disappear from normal Library results but retain their catalog state.
5. The user can open Trash from the gear menu, view photos read-only, restore them, or permanently delete them through a separate confirmation.

Trash is retained indefinitely in version 1.

### 10.9 Reconciling external changes

1. PhotoTagger performs lightweight filename, size, and modification-time checks in the background.
2. Changed candidates receive full validation only when necessary.
3. Unrelated metadata changes are accepted automatically.
4. Differences in PhotoTagger-controlled fields create a metadata conflict.
5. Changed image data creates a content conflict.
6. The user chooses whether to retain catalog tags, import file tags, accept changed pixels, restore from backup, or resolve later.

PhotoTagger never silently overwrites externally changed pixels.

### 10.10 Catalog backup and recovery

1. PhotoTagger creates at most one automatic catalog snapshot per changed day when idle.
2. Additional safety snapshots are created before schema migration, restoration, and destructive bulk catalog operations.
3. A configured secondary local destination receives verified snapshots when available.
4. The user can back up now, export a portable recovery bundle, restore a snapshot, or rebuild the catalog from JPEG metadata.

Catalog restoration does not claim to restore missing photo bytes.

## 11. User experience specification

### 11.1 Production layout

The production interface contains four structural regions:

1. Primary Navigation.
2. Photo Viewer, which switches between Image View and Library View.
3. Tagging Panel, visible only in Edit mode and relevant maintenance contexts.
4. Status Bar.

Section-name watermarks used in the collaborative HTML prototype are design annotations only and must not appear in the production application.

### 11.2 Primary Navigation

- Image View and Library View are centered over the Photo Viewer as icon buttons.
- Image View uses a single-photo icon.
- Library View uses a tile-grid icon.
- Multiple Library selections disable and visibly strike or mute Image View.
- The right side contains the mode toggle, Import icon, and settings gear.
- Import exposes hover text `Import` while idle and `Stop after current photo` while processing.
- The settings gear opens a dropdown with direct routes to settings and maintenance destinations.

### 11.3 Photo Viewer

- Image View displays one photo without navigation buttons obscuring the image.
- Previous and Next controls occupy viewer gutters or otherwise remain outside meaningful image content.
- The current ID filename and position in the active sequence are visible.
- Library View displays a scrollable, responsive thumbnail grid.
- Library controls include tag filtering, flag filtering, Select All, Unselect All, result count, and selection count.
- The result and selection counters share the row beneath the filter controls.

### 11.4 Tagging Panel

- The `Add a tag...` field suggests existing tags.
- Entering a path such as `Pets/Cats` creates or resolves `Pets` and its nested `Cats` node rather than creating a flat label containing a slash.
- The Tag Pallet uses elongated pill controls.
- An explicit applied tag appears depressed with a glowing outline.
- A parent with children displays a `+` or expanded-state marker.
- Children appear directly beneath their parent and may contain further nested children.
- Tag Pallet overflow scrolls within the panel.
- Existing explicit tags appear below the Tag Pallet with visual separation.
- If an existing explicit tag is also present in the Tag Pallet, the Pallet pill reflects the applied state.
- The Pallet provides an editing action for pinning, removing, and reordering quick-access tags.
- Trash and flag controls sit below and to the right of the tag-entry area, with Trash to the left of Flag.

### 11.5 Status Bar

- The bar is always one line and never wraps.
- The left side displays the current number of files waiting in Inbox.
- The center displays the current view status, such as `Library View opened`.
- The right side displays one status light and concise operational text.
- Green means no application-owned physical write is active and protected operations are at a safe boundary; reviewable problems may still be identified by the adjacent text or badges.
- Orange means physical writes are taking place.
- Errors, conflicts, and items requiring review are represented through concise text and count badges rather than additional status lights.
- Overflowing text truncates rather than forcing a second line.

## 12. Core product rules

### 12.1 Identity and filenames

- Photo IDs are never reused.
- Canonical filenames are ten-digit zero-padded IDs followed by `.jpg`.
- Original filenames are always stored in SQLite.
- `PreservedFileName` is written only if the field was previously empty.

### 12.2 Tag hierarchy

- Tag segments are trimmed and Unicode-normalized.
- Sibling uniqueness is case-insensitive using a stored normalization key.
- `/`, `|`, semicolon, and control characters are not allowed in a tag segment.
- A segment is limited to 64 UTF-8 bytes.
- Hierarchy depth is limited to 12.
- Cycles are prohibited.
- Complete paths are shown when needed to disambiguate equal leaf names.

### 12.3 Hashes

Each photo tracks:

- Immutable source SHA-256.
- Current whole-file SHA-256.
- Image-data-only SHA-256 for JPEG integrity checks.

A source is automatically deleted as an exact duplicate only when its whole-file hash matches a known source or current hash and the stored photo remains readable. Image-data-only matches are not sufficient for automatic deletion.

### 12.4 Write coalescing

- SQLite changes are committed before corresponding JPEG metadata writes.
- A photo has at most one pending desired metadata job.
- Each edit advances a desired revision and updates the pending job.
- A short debounce permits rapid edits to collapse into one JPEG rewrite.
- Pending jobs survive restart.

### 12.5 File replacement

Metadata writes use a verified temporary output and a journaled same-volume swap. The original file remains recoverable as a working backup until the new canonical file is verified. Recovery never deletes the sole valid candidate.

## 13. Conversion policy

### 13.1 Existing JPEGs

- Validate and hash.
- Move and rename on the same drive.
- Do not re-encode or auto-rotate stored pixels.
- Generate an orientation-correct external thumbnail.
- Delay creation or replacement of the embedded thumbnail until the first metadata rewrite, unless one is already required for another reason.
- Queue one coalesced metadata job after import when the controlled metadata projection, preserved filename, or embedded-thumbnail policy requires a write.

### 13.2 PNG and still WebP

- Fully decode before source deletion.
- Normalize pixel orientation and set stored orientation to normal.
- Preserve original pixel dimensions after orientation; do not upscale.
- Convert to sRGB and embed an appropriate sRGB profile.
- Composite transparency over a configurable solid background, default white.
- Encode JPEG at configurable quality, default 92, using 4:2:0 chroma subsampling.
- Preserve safe descriptive metadata while excluding obsolete structural, orientation, dimension, old-thumbnail, incompatible profile, and invalidated authenticity data.
- Create and verify the embedded thumbnail during conversion when capacity permits.

Settings changes affect future conversions only.

## 14. Thumbnail policy

### 14.1 External UI thumbnails

- Generated during every successful import.
- Maximum bounding dimension: 512 pixels.
- Preserve aspect ratio and orientation.
- No crop and no upscale.
- Stored as regenerable cache data outside the JPEG.
- Distributed across deterministic cache subdirectories for scale.

### 14.2 Embedded thumbnails

- Maximum bounding box: 160 by 160 pixels.
- Preserve aspect ratio, present upright, and do not crop.
- Begin near JPEG quality 70 and reduce quality or dimensions as necessary.
- Replace only the EXIF IFD1 thumbnail.
- Treat insufficient EXIF capacity as a warning, not an import or tag-sync failure.
- Record embedded-thumbnail status for maintenance and retry visibility.

## 15. Deletion and Trash policy

- Normal deletion moves the active JPEG and available thumbnail into internal Trash.
- The first dialog uses Yes/No and defaults to No.
- Trashed photos keep identity, tags, flags, hashes, and history.
- Trashed photos are excluded from normal counts, filters, and navigation.
- Metadata jobs are not executed while a photo is trashed.
- Restore returns the same ID filename to Storage.
- A destination collision never causes overwrite.
- Trash is not automatically purged.
- Permanent deletion requires a second explicit confirmation showing count and size.
- A pre-purge catalog safety snapshot and deletion manifest are created.
- If the required safety snapshot cannot be verified, permanent deletion does not begin.
- Permanent deletion leaves a minimal tombstone and never permits ID reuse.

Converted-source cleanup and verified exact-duplicate cleanup are import operations and do not use Library Trash.

## 16. External-change policy

- A lightweight background scan uses names, sizes, and modification times as change indicators.
- A filesystem watcher accelerates detection while the app runs but is not the sole source of truth.
- Whole-file and image-data hashes determine whether a candidate changed only in metadata or in pixels.
- Uncontrolled metadata changes are accepted and re-indexed without prompting.
- Controlled-tag differences suspend metadata writes for that photo until resolved.
- Valid changed pixels suspend metadata writes until the user accepts the new content or restores a backup.
- Unreadable files are marked and preserved in place.
- Missing files retain their database records.
- Unknown Storage files move to Recovery unless they safely reconcile to a known missing photo.

## 17. Backup and recovery policy

### 17.1 Snapshot content

Catalog backups include the database, settings needed for restoration, a manifest, and integrity information. They exclude photos, external thumbnails, and temporary files.

### 17.2 Automatic retention

- One snapshot per changed day.
- Seven daily snapshots.
- Four weekly snapshots selected from daily snapshots.
- Six monthly snapshots selected from daily snapshots.
- Three recent pre-migration or pre-restore safety snapshots.
- Manual exports are not automatically deleted.

### 17.3 Secondary destination

An optional second local filesystem destination may receive verified catalog snapshots. An unavailable destination does not block work. A destination on the same physical volume produces a warning.

### 17.4 Restore modes

- **Recover Current Collection** restores SQLite-only state from a snapshot, then treats current file locations and newer embedded tags as recoverable current evidence.
- **Roll Back Catalog State** explicitly restores snapshot tags and SQLite-only state, explains the number of JPEG rewrites required, and requires confirmation.

### 17.5 Rebuild

If no valid catalog backup exists, PhotoTagger can rebuild photo IDs, hashes, dimensions, original filenames, hierarchical tags, flat tags, and Trash state from canonical files and metadata. SQLite-only flags, Pallet ordering, and unavailable history may be lost.

## 18. Performance and scale requirements

| Measure | Version 1 target |
| --- | --- |
| Active and trashed photo records | 100,000 |
| Tag records | 10,000 |
| One Inbox snapshot | 10,000 files |
| Select All scope | Entire filtered collection |
| Initial usability from external HDD | Within 5 seconds under reference conditions |
| Indexed tag-filter response | Within 500 milliseconds under reference conditions |
| Thumbnail DOM population | Visible and near-visible items only |
| Long-running work | Background, sequential, persistent, and resumable |

Reference conditions, hardware, warm/cold cache distinctions, and exact measurement methods will be defined in the acceptance-test plan.

## 19. Reliability requirements

- Filesystem operations that span database and disk state must be journaled.
- Critical operations must be idempotent or recoverable from observed files.
- SQLite uses one application-owned write connection and foreign-key enforcement.
- Import, metadata, Trash, restore, backup, and recovery workers are serialized where their writes may conflict.
- Existing JPEG image data must have the same image-data hash before and after a metadata-only rewrite.
- A successful conversion must fully decode and match expected dimensions before source deletion.
- The application must survive closure between any two journaled phases without deleting the only valid photo.
- Pending work resumes after restart without repeating completed destructive steps.
- Low disk space, permission loss, file locks, and drive removal pause affected work safely.

## 20. Privacy and security requirements

- No application feature requires internet access.
- No telemetry or automatic network request is permitted.
- All application assets and dependencies are bundled.
- The renderer has no unrestricted Node.js or filesystem access.
- Privileged operations cross a narrow, validated preload API.
- File operations validate that targets belong to approved Collection directories.
- External commands receive arguments without shell interpolation.
- Logs remain local and do not contain copies of image data.
- Only one application instance may write to a collection.

## 21. Maintenance experience

The settings gear provides direct access to:

- Settings.
- Manage Tags.
- Edit Tag Pallet.
- Import Problems.
- External Changes.
- Trash.

Settings contains:

- General conversion and Library defaults.
- Backup and Recovery.
- Library Maintenance.
- Metadata Activity.
- Diagnostics and About.

Maintenance operations reuse the central content region and hide the Tagging Panel. Actionable destinations display count badges.

## 22. Product success criteria

Version 1 is successful when all of the following are true:

1. A fresh portable folder can be opened on the target Windows system and used without installation or internet access.
2. Existing JPEGs are imported without changing their encoded image data.
3. Supported PNG and still WebP inputs become valid, verified JPEGs using the approved conversion profile.
4. A source is never deleted before its stored result and required external thumbnail are verified.
5. Hierarchical tags can be created, suggested, displayed, filtered, batch-applied, embedded, removed, renamed, moved, merged, and recovered.
6. Library filtering, selection, and Image View sequence preservation work at the target scale.
7. Rapid edits produce the correct final metadata while avoiding redundant JPEG rewrites.
8. Application interruption at any journaled phase has a deterministic recovery outcome.
9. Ordinary deletion is reversible and permanent deletion cannot occur through the first confirmation alone.
10. Catalog backups validate successfully, restore safely through staging, and support metadata-based rebuild.
11. External metadata and pixel changes are detected without silent loss.
12. The final interface conforms to the approved four-region layout without prototype watermarks.

## 23. Product risks and mitigations

| Risk | Mitigation |
| --- | --- |
| External HDD removed during a write | Journal every cross-system operation; use verified temporary files and recoverable swaps. |
| Metadata edit changes whole-file hash | Track source, current-file, and image-data hashes separately. |
| Rapid tagging causes large write amplification | Commit to SQLite promptly and coalesce one latest desired metadata job per photo. |
| Existing EXIF is too large for a thumbnail | Use adaptive thumbnail size and treat capacity failure as a warning. |
| Flat keyword formats lose hierarchy | Keep SQLite and `HierarchicalSubject` authoritative for structure; use flat fields only for compatibility. |
| An old catalog restore overwrites newer file tags | Default to Recover Current Collection and require explicit confirmation for rollback. |
| Catalog backup is stored on the failed drive | Support a secondary local destination and portable recovery export. |
| Selecting all results triggers many JPEG rewrites | Show affected count above the bulk threshold; persist and serialize the queue. |
| A tag-tree operation changes thousands of paths | Preview scope, snapshot the catalog, update SQLite transactionally, and coalesce affected jobs. |
| Database is lost entirely | Recover IDs from filenames and tags from embedded metadata; document SQLite-only losses. |

## 24. Release boundaries

### 24.1 Required for version 1 release

- All goals PS-01 through PS-19.
- Windows x64 portable package.
- Full import, tagging, Library, Trash, conflict, backup, and recovery workflows.
- Automated tests for pure business rules and database behavior.
- Integration tests for file-operation state machines.
- Fault-injection coverage around source deletion and canonical-file replacement.
- Performance verification against the agreed reference dataset.
- Bundled dependency licenses and local documentation.

### 24.2 May be deferred until after the first internal build

- Final product name.
- Final application icon and visual branding.
- Additional keyboard shortcuts beyond basic accessibility and navigation.
- Nonessential theme customization.

These deferred items must be resolved before the first externally distributed packaged release but do not block engineering work.

## 25. Glossary

| Term | Meaning |
| --- | --- |
| Active photo | A cataloged JPEG located in Storage and available in normal views. |
| Canonical file | The expected ID-named JPEG representing a photo in Storage or Trash. |
| Catalog | The SQLite database and its authoritative application state. |
| Controlled metadata | JPEG metadata fields that PhotoTagger is permitted to replace from SQLite. |
| Explicit tag | The exact tag node assigned to a photo in `photo_tags`. |
| Inferred ancestor | A parent tag considered applicable because an explicit descendant is assigned. |
| Image-data hash | SHA-256 calculated over encoded JPEG image data while excluding metadata. |
| Metadata job | Persistent work required to make controlled JPEG metadata match SQLite. |
| Photo ID | Immutable numeric database identity used to derive the canonical filename. |
| Tag Pallet | User-configured quick-access set of tag pills in the Tagging Panel. |
| Tombstone | Minimal database record retained after permanent deletion to prevent ID reuse and preserve deletion evidence. |
| Working backup | Temporary previous canonical JPEG retained during a journaled replacement. |

## 26. Decision status

All user-facing product policies in this document have been approved as the version-one baseline. The remaining decisions concern implementation details documented in the functional specification and subsequent technical designs, including dependency versions, exact SQLite DDL, IPC message schemas, packaging scripts, and test harness selection.
