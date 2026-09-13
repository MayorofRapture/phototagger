# PhotoTagger Functional Specification

**Document version:** 1.0  
**Product version:** Version 1  
**Status:** Functional baseline for technical design and implementation  
**Related document:** `PhotoTagger_Product_Specification_v1.md`  
**Target platform:** Windows x64 on an NTFS external HDD  
**Date:** 2026-09-13

## 1. Purpose and authority

This document translates the approved PhotoTagger product specification into testable functional behavior. It defines what the application must do, the state it must retain, how the user interacts with it, and how it must respond to success, interruption, conflict, and failure.

The documents have the following authority:

1. The Product Specification controls product intent, scope, and user-facing priorities.
2. This Functional Specification controls observable version-one behavior.
3. Subsequent architecture, schema, and state-machine documents control implementation detail but may not weaken these requirements.
4. If an implementation detail conflicts with either approved specification, the implementation detail must change or the conflict must be brought back for explicit product approval.

The terms **shall** and **must** identify mandatory behavior. **Should** identifies a preferred behavior that may be changed only with documented technical justification. **May** identifies optional behavior.

## 2. System overview

PhotoTagger is a portable Electron desktop application with these logical components:

| Component | Responsibility |
| --- | --- |
| Renderer | Local HTML/CSS/JavaScript interface; no unrestricted filesystem or Node.js access. |
| Preload bridge | Narrow, validated application API exposed to the renderer. |
| Main coordinator | Window lifecycle, IPC validation, collection lock, settings, filesystem orchestration, and worker coordination. |
| Catalog service | Single application-owned SQLite write connection, queries, transactions, migrations, and backup operations. |
| Image worker | Sharp-based validation, conversion, orientation, and thumbnail generation. |
| Metadata worker | One serialized ExifTool process for metadata reads and writes. |
| Job recovery service | Reconciles journaled database intent with observed filesystem state. |
| Integrity scanner | Performs lightweight background scans and requested full verification. |

### 2.1 Functional boundaries

- The renderer shall request operations through the preload bridge.
- The renderer shall never receive arbitrary filesystem access.
- The catalog shall be the authoritative source for Library queries, selection behavior, tags, flags, photo lifecycle state, and pending work.
- JPEG metadata shall be an interoperable projection of catalog tag state and a secondary source for recovery.
- Filesystem writes that cross database state boundaries shall be journaled.

## 3. Portable deployment and collection layout

### 3.1 Distribution model

**FR-PLAT-001:** PhotoTagger shall be distributed as a folder-based Windows x64 portable application rather than an installed application.

**FR-PLAT-002:** The packaged application shall include Electron runtime files, application assets, Sharp native components, SQLite access components, ExifTool, and all required licenses.

**FR-PLAT-003:** Application features shall not require network access after packaging.

**FR-PLAT-004:** The application shall not contain an enabled automatic updater, telemetry client, remote asset request, cloud login, or advertising integration.

### 3.2 Canonical layout

Application-owned persistent paths shall be located beneath the portable root:

```text
PhotoTagger/
  PhotoTagger.exe
  [packaged runtime files]
  Collection/
    Inbox/
    Storage/
    Thumbnails/
      [derived cache shards]/
    Trash/
      Photos/
      Thumbnails/
    Failed/
    Recovery/
    Working/
      Import/
      Metadata/
      Backups/
      Restore/
    Data/
      catalog.sqlite
      catalog.sqlite-wal
      catalog.sqlite-shm
      Backups/
        Automatic/
        Safety/
        Manual/
      Logs/
```

**FR-PLAT-005:** Catalog paths shall be stored relative to `Collection` whenever a persistent path is required.

**FR-PLAT-006:** A changed Windows drive letter shall not invalidate catalog records.

**FR-PLAT-007:** PhotoTagger shall not silently create or select a fallback collection elsewhere when the portable Collection directory is unavailable.

**FR-PLAT-008:** The user shall not be able to change the Collection root in version 1.

**FR-PLAT-009:** Storage shall contain all active JPEGs in one flat directory.

**FR-PLAT-010:** Thumbnail cache sharding shall not alter or subdivide the flat photo Storage directory.

## 4. Domain state

### 4.1 Photo identity

**FR-ID-001:** Each successfully reserved photo shall receive a positive integer `photo_id` that is never reused.

**FR-ID-002:** The canonical stored filename shall be the photo ID padded to ten decimal digits plus `.jpg`.

Example:

```text
photo_id: 427
filename: 0000000427.jpg
```

**FR-ID-003:** Canonical filenames shall not change after assignment.

**FR-ID-004:** The immediate Inbox filename shall be retained separately from the canonical filename.

### 4.2 Independent state dimensions

Lifecycle, integrity, and metadata synchronization shall be represented independently so that, for example, a trashed file may also be missing or unreadable.

#### Lifecycle state

| State | Meaning |
| --- | --- |
| `active` | Expected under Storage and eligible for normal Library results. |
| `trashed` | Expected under Trash and excluded from normal Library results. |
| `purged` | Photo bytes intentionally deleted; minimal tombstone retained. |

#### Integrity state

| State | Meaning |
| --- | --- |
| `clean` | Expected file exists and no unresolved discrepancy is known. |
| `missing` | Expected file is absent. |
| `unreadable` | File exists but cannot be fully decoded. |
| `metadata_conflict` | App-controlled file metadata differs from catalog state. |
| `content_conflict` | JPEG image data changed outside the application. |
| `recovery_required` | Ambiguous filesystem state requires recovery review. |

#### Metadata synchronization state

Metadata state is determined from desired revision, synchronized revision, job state, and warning state:

- `synchronized`
- `pending`
- `writing`
- `failed`
- `suspended_conflict`
- `synchronized_with_warning`

**FR-STATE-001:** A lifecycle transition shall not erase integrity or audit information unless permanent-deletion rules explicitly require it.

**FR-STATE-002:** A purged photo shall never return to active by reusing the same ID through ordinary import.

### 4.3 Required conceptual entities

The exact DDL is defined later, but the catalog shall represent at least:

- Photos.
- Tags with self-referencing parent identity.
- Explicit photo-tag assignments.
- Tag aliases.
- Tag Pallet entries and order.
- Import jobs and phases.
- Metadata jobs and revisions.
- Filesystem operation journal entries.
- Trash and purge batches.
- External-change events.
- Content revision events.
- Backup records and manifests.
- Settings.
- Application/schema version.
- Audit and diagnostic events.

## 5. Application startup and shutdown

### 5.1 Startup

**FR-START-001:** The application shall acquire a single-instance lock before opening the catalog for writing.

**FR-START-002:** If another instance owns the collection, the new instance shall not write and shall bring the existing window forward when possible.

**FR-START-003:** Before the UI permits mutating actions, the main process shall:

1. Resolve the portable root.
2. Confirm the Collection directory is on the expected volume and is writable.
3. Create missing standard directories when safe.
4. Open SQLite and apply required connection settings.
5. Validate supported schema version.
6. Run migrations only after a verified pre-migration backup.
7. Reconcile incomplete journaled operations.
8. Resume or suspend persistent jobs according to observed state.
9. Start the metadata and background-integrity services.

**FR-START-004:** An unclean prior shutdown shall trigger catalog and journal checks before new writes are accepted.

**FR-START-005:** If catalog validation fails, the application shall enter Recovery mode instead of initializing a new empty catalog over the failed one.

**FR-START-006:** The primary window shall become usable without waiting for a full Storage hash scan.

### 5.2 Shutdown

**FR-SHUT-001:** Closing the application shall stop accepting new import, tag-management, Trash, backup, and restore commands.

**FR-SHUT-002:** The application shall allow the current critical file rename, replacement, or deletion phase to reach a recoverable boundary.

**FR-SHUT-003:** Pending noncritical metadata and import work may remain queued for the next launch.

**FR-SHUT-004:** The application shall persist job state, close the ExifTool process, checkpoint SQLite as appropriate, close the database connection, and mark a clean shutdown.

**FR-SHUT-005:** The application shall not keep the window open until an entire large metadata queue finishes.

## 6. Primary interface

### 6.1 Structural regions

**FR-UI-001:** The production window shall contain Primary Navigation, Photo Viewer, Tagging Panel, and a single-line Status Bar.

**FR-UI-002:** Prototype section watermarks shall not appear in the production build.

**FR-UI-003:** Primary Navigation shall not include a separate application header or Photo Queue sidebar.

### 6.2 Primary Navigation

**FR-UI-010:** Centered Image View and Library View icon buttons shall switch the Photo Viewer content.

**FR-UI-011:** Image View shall use a single-image icon and accessible name `Image View`.

**FR-UI-012:** Library View shall use a tile-grid icon and accessible name `Library View`.

**FR-UI-013:** From Library View, Image View shall be available when exactly one valid photo is selected and visibly disabled when multiple photos are selected.

**FR-UI-014:** With no Library selection, Image View shall not choose an arbitrary hidden item; the user must select one photo unless returning to an already active Image View session.

**FR-UI-015:** A disabled Image View control shall use both visual muting/strike treatment and the native accessible disabled state.

**FR-UI-016:** The right side of Primary Navigation shall contain, in order, the mode toggle, Import action, and settings gear.

**FR-UI-017:** Icon-only controls shall provide hover text and accessible names.

### 6.3 Edit and View modes

**FR-UI-020:** Edit mode shall expose and enable the Tagging Panel.

**FR-UI-021:** While Edit mode is active, the mode toggle shall display a magnifying-glass action labeled `View mode`.

**FR-UI-022:** View mode shall hide and disable the Tagging Panel while preserving Photo Viewer width and navigation usability.

**FR-UI-023:** While View mode is active, the toggle shall display a pencil action labeled `Edit mode`.

**FR-UI-024:** Switching modes shall not alter filters, selection, current image, tags, or pending jobs.

### 6.4 Image View

**FR-UI-030:** Image View shall display one orientation-correct photo fitted within the available viewer.

**FR-UI-031:** Previous and Next controls shall remain within viewer gutters or another reserved area that does not cover meaningful image content.

**FR-UI-032:** Image View shall display the canonical filename and position in the active sequence.

**FR-UI-033:** Previous shall be disabled at the first photo and Next shall be disabled at the last photo of the active sequence. Both controls shall be disabled when the sequence is empty or contains only one photo; navigation shall not wrap.

**FR-UI-034:** The Next action shall ensure the latest SQLite tag transaction is complete before changing images; it shall not wait for background JPEG metadata synchronization.

**FR-UI-035:** An unreadable or missing selected photo shall display an explanatory placeholder and disable tagging.

### 6.5 Library View

**FR-UI-040:** Library View shall contain a tag-filter control, flag filter, selection row, and scrollable responsive thumbnail grid.

**FR-UI-041:** Select All, Unselect All, result count, and selected count shall occupy one row beneath the filter controls, with counts aligned right.

**FR-UI-042:** Thumbnails shall be arranged in a grid and shall never be intentionally stacked on top of one another.

**FR-UI-043:** Only visible and near-visible thumbnails shall be mounted in the renderer for large result sets.

**FR-UI-044:** Selected thumbnails shall have an unambiguous visual and accessible selected state.

**FR-UI-045:** Flagged thumbnails shall have a visible flag marker.

**FR-UI-046:** Missing, unreadable, or conflicted active records shall use warning badges and appropriate placeholders without preventing normal browsing of unaffected photos.

### 6.6 Tagging Panel

**FR-UI-050:** The panel shall contain the `Add a tag...` field, Trash and flag controls, Tag Pallet, existing/applied tag area, and the batch-apply area when Library selection is active.

**FR-UI-051:** Trash shall appear to the left of Flag below and to the right of the tag-entry field.

**FR-UI-052:** The Tag Pallet shall scroll internally when its expanded hierarchy exceeds available height.

**FR-UI-053:** Existing explicit tags shall appear below the Pallet with visual separation and shall not consume the primary Pallet area.

**FR-UI-054:** The Pallet shall expose an edit action.

### 6.7 Status Bar

**FR-UI-060:** The Status Bar shall remain one physical line at all supported window widths.

**FR-UI-061:** The left area shall display the current number of top-level files waiting in Inbox.

**FR-UI-062:** The center shall display the current view or maintenance destination.

**FR-UI-063:** The right area shall contain one status light and concise operational text.

**FR-UI-064:** The light shall be green while the application is idle and its protected operations are in a safe state.

**FR-UI-065:** The light shall be orange only while application-owned physical writes are taking place.

**FR-UI-066:** Problems requiring review shall appear as concise text and badges; they shall not create a second light.

**FR-UI-067:** Status text shall truncate rather than wrap.

### 6.8 Dialog behavior and accessibility

**FR-UI-070:** Destructive dialogs shall trap focus, identify the affected count, default to the non-destructive action, support Escape to cancel, and restore focus to the invoking control.

**FR-UI-071:** All interactive controls shall be usable with keyboard navigation.

**FR-UI-072:** Dynamic results and completed actions shall be announced through an appropriate polite live region.

## 7. Inbox scan and import controls

### 7.1 Scan scope

**FR-IMP-001:** Clicking Import while idle shall snapshot regular files located directly inside Inbox.

**FR-IMP-002:** Version 1 shall ignore Inbox subdirectories.

**FR-IMP-003:** Files added after the snapshot shall wait for a subsequent Import command.

**FR-IMP-004:** The snapshot shall be processed in natural, case-insensitive filename order with a deterministic tie-breaker.

**FR-IMP-005:** Only one import worker shall mutate collection files at a time.

### 7.2 Stability and format detection

**FR-IMP-010:** Before validation, a source file shall produce matching size and modification observations across a stability interval and shall be openable for reading.

**FR-IMP-011:** An unstable or exclusively locked source shall remain in Inbox and be reported as waiting rather than failed.

**FR-IMP-012:** File type shall be detected from content signatures and decoder results, not extension alone.

**FR-IMP-013:** Supported types are JPEG, PNG, and still WebP.

**FR-IMP-014:** Animated WebP, GIF, unsupported types, and undecodable files shall not be reduced silently to a still JPEG.

### 7.3 Stop behavior

**FR-IMP-020:** While import is active, the Import action shall change to `Stop after current photo`.

**FR-IMP-021:** A stop request shall not interrupt a critical operation for the current source.

**FR-IMP-022:** Completed sources shall remain completed and unstarted sources shall remain in Inbox.

**FR-IMP-023:** A later Import command shall create a new snapshot and continue normal processing.

### 7.4 Import phases

Every source shall progress through durable phases equivalent to:

1. `discovered`
2. `waiting_stable`
3. `validating`
4. `hashing`
5. `duplicate_check`
6. `id_reserved`
7. `moving` or `converting`
8. `stored_verification`
9. `thumbnail_generation`
10. `catalog_commit`
11. `source_cleanup`
12. `completed`, `duplicate_completed`, `waiting`, or `failed`

**FR-IMP-030:** The current phase and all filesystem targets needed for recovery shall be persisted before each destructive or identity-changing step.

**FR-IMP-031:** An ID may remain unused after a failed reservation, but shall never be reassigned to a different photo.

### 7.5 Existing JPEG pipeline

**FR-IMP-040:** For an existing JPEG, PhotoTagger shall:

1. Fully decode and validate the source.
2. Read relevant existing metadata.
3. Calculate the source whole-file SHA-256 and JPEG image-data SHA-256.
4. Perform duplicate checks.
5. Reserve a photo ID and journal the source and destination.
6. Rename the file into Storage on the same volume using its canonical ID filename.
7. Generate and verify the external thumbnail.
8. Fully decode the stored canonical JPEG and verify expected dimensions.
9. Commit the photo, imported tags, hashes, metadata observations, and job completion to SQLite.

**FR-IMP-041:** This pipeline shall not re-encode image pixels.

**FR-IMP-042:** The source and current whole-file hashes shall initially be equal unless a required metadata repair occurred before commit.

**FR-IMP-043:** Existing JPEG orientation metadata shall be respected for display and thumbnails without rotating stored pixels.

**FR-IMP-044:** After the JPEG catalog commit, PhotoTagger shall queue one coalesced metadata job when the controlled metadata projection, preserved filename, or embedded-thumbnail policy differs from the desired state. The import may complete while this recoverable background job remains pending.

### 7.6 PNG and still WebP pipeline

**FR-IMP-050:** For PNG or still WebP, PhotoTagger shall:

1. Fully decode and validate the source.
2. Read safe descriptive metadata.
3. Calculate immutable source SHA-256.
4. Perform exact source duplicate checks.
5. Reserve a photo ID and journal all paths.
6. Convert into a temporary JPEG under Working on the same volume.
7. Apply the approved orientation, color, alpha, quality, and metadata rules.
8. Generate the external thumbnail and attempt the embedded thumbnail.
9. Fully decode the temporary JPEG and verify expected dimensions.
10. Rename the verified JPEG into canonical Storage.
11. Calculate current-file and JPEG image-data SHA-256 values.
12. Commit the catalog record.
13. Delete the converted source only after the catalog and stored result are verified.

**FR-IMP-051:** A failed conversion shall leave the source or a recoverable copy intact.

**FR-IMP-052:** The application shall not compare a converted JPEG image-data hash to the source PNG/WebP as an equality test.

### 7.7 Exact and possible duplicates

**FR-DUP-001:** Exact automatic duplicate determination shall require a whole-file SHA-256 match against a known immutable source hash or current stored-file hash.

**FR-DUP-002:** Before deleting an exact duplicate source, the corresponding stored photo shall exist and fully decode.

**FR-DUP-003:** A verified exact duplicate Inbox copy shall be deleted and logged in Import History without creating a second photo.

**FR-DUP-004:** If exact duplicate cleanup fails, the source shall remain and the job shall remain recoverable without importing it as a new photo on restart.

**FR-DUP-005:** An image-data-only match with differing whole-file bytes shall not cause automatic deletion.

**FR-DUP-006:** Version 1 may import an image-data-only match as a separate photo and mark it as a possible duplicate for history and later review.

### 7.8 Failed inputs

**FR-FAIL-001:** Permanently unsupported, animated, corrupt, or conversion-invalid source files shall move to Failed with a recorded reason.

**FR-FAIL-002:** Transient collection errors such as a disconnected drive, full disk, or broad permission failure shall pause import rather than classifying every remaining source as failed.

**FR-FAIL-003:** A Failed filename collision shall use a unique job suffix while preserving the original filename in SQLite.

**FR-FAIL-004:** Failed inputs shall not retry automatically.

**FR-FAIL-005:** Import Problems shall provide Retry, Retry Selected, Return to Inbox, Open Failed Folder, and confirmed permanent deletion.

## 8. Conversion requirements

### 8.1 Conversion profile

**FR-CONV-001:** Default JPEG quality shall be 92.

**FR-CONV-002:** Default chroma subsampling shall be 4:2:0.

**FR-CONV-003:** Stored dimensions shall match the source dimensions after required orientation; no upscale or storage resize shall occur.

**FR-CONV-004:** Converted pixels shall be normalized to sRGB and stored with a compatible sRGB profile.

**FR-CONV-005:** Transparent pixels shall be composited over a solid configurable background, default white.

**FR-CONV-006:** Conversion settings changes shall affect future imports only and shall never initiate automatic reconversion of stored images.

### 8.2 Metadata preservation during conversion

**FR-CONV-010:** The conversion path shall preserve technically safe descriptive fields, including supported capture time, camera/lens information, GPS, copyright, caption, creator, and recognized keyword metadata.

**FR-CONV-011:** The conversion path shall not copy stale source dimensions, source orientation, source thumbnails, format-structural fields, incompatible color profiles, or content-authenticity signatures invalidated by conversion.

**FR-CONV-012:** The exact allowlist and exclusions shall be documented and covered by fixture tests before release.

**FR-CONV-013:** Converted JPEG orientation shall be normal after pixel orientation is applied.

### 8.3 Capacity and safety

**FR-CONV-020:** Before starting a conversion, the application shall check that sufficient free space exists for the source, temporary output, thumbnails, and recovery overhead.

**FR-CONV-021:** Insufficient space shall pause the job before source deletion or canonical replacement.

**FR-CONV-022:** A conversion warning that does not affect stored image validity, required external thumbnail validity, or core tag metadata may be committed with a recorded warning.

## 9. Thumbnail requirements

### 9.1 External thumbnails

**FR-THM-001:** Every active or trashed photo shall have a deterministically addressable external UI thumbnail unless a recorded regeneration job is pending.

**FR-THM-002:** The thumbnail shall fit within a 512-pixel maximum bounding dimension, preserve aspect ratio, be upright, use no crop, and never upscale.

**FR-THM-003:** The application shall fully decode a generated thumbnail before considering thumbnail generation successful.

**FR-THM-004:** Thumbnail cache paths shall be derived from photo ID and a deterministic shard function; they need not be stored as absolute paths.

**FR-THM-005:** Missing or corrupt external thumbnails shall be regenerated without rewriting the stored JPEG.

### 9.2 Embedded thumbnails

**FR-THM-010:** The embedded thumbnail shall use an EXIF IFD1 JPEG thumbnail with a maximum 160-by-160 bounding box, upright orientation, preserved aspect ratio, and no crop.

**FR-THM-011:** Generation shall begin near quality 70 and adapt quality or dimensions to available metadata capacity.

**FR-THM-012:** An existing IFD1 thumbnail may be replaced, but unrelated EXIF data shall not be removed.

**FR-THM-013:** If safe embedding is impossible, the core operation shall succeed with `embedded_thumbnail_status = skipped_capacity` or another specific warning state.

**FR-THM-014:** A reported successful embedded thumbnail shall be extracted and decoded during verification.

## 10. Tag model and entry

### 10.1 Tag validation

**FR-TAG-001:** Each tag shall have an immutable internal ID, display name, normalized sibling key, and optional parent ID.

**FR-TAG-002:** Display names shall be trimmed and normalized to Unicode NFC before validation.

**FR-TAG-003:** Sibling names shall be unique by a deterministic case-insensitive normalized key.

**FR-TAG-004:** A segment shall not contain `/`, `|`, semicolon, or control characters.

**FR-TAG-005:** A segment shall not exceed 64 UTF-8 bytes.

**FR-TAG-006:** A hierarchy shall not exceed 12 segments.

**FR-TAG-007:** Parent changes shall be rejected if they create a cycle.

**FR-TAG-008:** Validation errors shall identify the invalid segment and reason without partially creating the path.

### 10.2 Path input

**FR-TAG-010:** The `Add a tag...` field shall split a user-entered path on `/`, trim each segment, and validate the entire path.

**FR-TAG-011:** Existing nodes shall be resolved case-insensitively among siblings; only missing nodes shall be created.

**FR-TAG-012:** Path creation and assignment shall occur transactionally.

**FR-TAG-013:** Entering `Pets/Cats` shall resolve or create `Pets` and its child `Cats`; it shall not create a root tag whose display name is `Pets/Cats`.

**FR-TAG-014:** Existing-tag suggestions shall show full paths when leaf names are ambiguous.

**FR-TAG-015:** Suggestions shall be sourced locally from the catalog and shall not require network access.

### 10.3 Explicit and inferred tags

**FR-TAG-020:** `photo_tags` shall store only explicit assignments.

**FR-TAG-021:** Ancestor applicability shall be derived recursively from explicit descendants.

**FR-TAG-022:** Assigning a complete path through the entry field shall explicitly assign its final node, not every ancestor.

**FR-TAG-023:** A user may separately assign a parent explicitly by activating the parent tag itself.

**FR-TAG-024:** Existing/applied tag pills beneath the Pallet shall represent explicit assignments using full paths when required.

### 10.4 Pallet tree interaction

**FR-TAG-030:** Tags pinned to the Tag Pallet shall be displayed as elongated pills.

**FR-TAG-031:** An explicitly assigned pill shall use the depressed, glowing selected appearance.

**FR-TAG-032:** A parent with an applied descendant but no explicit parent assignment shall use a distinguishable inherited/contains-selection indicator rather than falsely representing an explicit assignment.

**FR-TAG-033:** A tag with children shall display an expansion marker.

**FR-TAG-034:** Expanding a tag shall display its children immediately beneath that tag.

**FR-TAG-035:** Arbitrary nesting up to the approved depth shall render recursively.

**FR-TAG-036:** Activating the disclosure region shall expand or collapse without changing assignment; activating the tag region shall toggle the exact tag and expand it when necessary to reveal children.

**FR-TAG-037:** Pallet scroll position shall remain stable when a nearby branch expands whenever layout constraints permit.

### 10.5 Single-photo edits

**FR-TAG-040:** In Image View Edit mode, toggling a tag shall commit the explicit assignment change to SQLite immediately.

**FR-TAG-041:** Removing an explicit parent shall not remove explicit descendants.

**FR-TAG-042:** Removing a descendant shall not remove a separately explicit parent.

**FR-TAG-043:** The latest desired metadata revision shall advance within the same database transaction as the assignment change.

**FR-TAG-044:** The UI shall update from committed catalog state without waiting for the JPEG write.

## 11. Tag administration

### 11.1 Pallet editing

**FR-TADM-001:** The user shall be able to pin any tag, remove a pinned tag, and reorder pinned entries.

**FR-TADM-002:** Pallet entries shall reference tag IDs so that rename and move operations update displayed paths without recreating entries.

**FR-TADM-003:** Merging tags shall replace source Pallet references with the surviving tag and remove duplicates.

**FR-TADM-004:** Deleting a tag shall remove its Pallet entry.

### 11.2 Rename

**FR-TADM-010:** Rename shall change one tag segment while retaining the tag ID and descendants.

**FR-TADM-011:** Case-only rename shall be supported without violating normalized uniqueness.

**FR-TADM-012:** Rename shall be rejected if the resulting sibling key already exists, unless the user selects Merge.

**FR-TADM-013:** A rename shall show the number of affected photos before a large resulting metadata rewrite.

**FR-TADM-014:** All affected desired metadata revisions shall update in one catalog transaction.

### 11.3 Move

**FR-TADM-020:** A tag and its descendants may move to another parent or to the root.

**FR-TADM-021:** Move shall validate uniqueness, depth, and cycle constraints before changing data.

**FR-TADM-022:** Descendant IDs and photo assignments shall remain unchanged.

**FR-TADM-023:** All photos whose exported path changes shall receive updated desired metadata revisions.

### 11.4 Merge

**FR-TADM-030:** Merge shall present the source, destination, hierarchy effects, and affected photo count before confirmation.

**FR-TADM-031:** Explicit source assignments shall transfer to the destination and duplicate assignments shall collapse.

**FR-TADM-032:** Source children shall move beneath the destination.

**FR-TADM-033:** Same-key child collisions shall merge recursively after inclusion in the preview.

**FR-TADM-034:** Previous full source paths shall be retained as aliases to the surviving tag for subsequent metadata import resolution.

**FR-TADM-035:** The source tag shall cease to exist only after the transaction succeeds.

### 11.5 Delete

**FR-TADM-040:** An unassigned leaf may be deleted after confirmation.

**FR-TADM-041:** An assigned leaf shall display its photo count and require explicit confirmation to remove those assignments before deletion.

**FR-TADM-042:** A tag with children shall not be deletable until its children are moved, merged, or deleted.

**FR-TADM-043:** Deleting a tag shall never delete photos.

**FR-TADM-044:** Destructive bulk tag administration shall create a catalog safety snapshot first.

## 12. Metadata projection and synchronization

### 12.1 Ownership and mapping

**FR-META-001:** SQLite shall be authoritative for controlled tag state.

**FR-META-002:** The application shall write each explicit tag's complete hierarchy path to `XMP-lr:HierarchicalSubject` using `|` between segments.

**FR-META-003:** Flat compatibility keywords shall contain the deduplicated closure of explicit tags and their ancestors.

**FR-META-004:** Flat keywords shall be written through `MWG:Keywords`, thereby synchronizing `XMP-dc:Subject` and IPTC Keywords when IPTC already exists.

**FR-META-005:** The same flat compatibility set shall be written to `EXIF:XPKeywords` using Windows-compatible encoding and delimiter behavior.

**FR-META-006:** Existing IPTC shall not be created on a file that did not already contain it.

**FR-META-007:** If existing IPTC encoding cannot be changed safely, XMP and XP tag synchronization may succeed while IPTC produces a recorded warning.

**FR-META-008:** `XMP-xmpMM:PreservedFileName` shall receive the immediate Inbox filename only when the field is absent or empty.

**FR-META-009:** The application shall update `XMP-xmp:MetadataDate` for its metadata writes.

**FR-META-010:** The application shall not change capture dates, EXIF ModifyDate, XMP ModifyDate, rating, label, GPS, camera data, ICC profile, or other uncontrolled metadata during an existing-JPEG tag write.

**FR-META-011:** Flags shall remain SQLite-only.

**FR-META-012:** Controlled list comparison shall be order-insensitive; output ordering shall nevertheless be deterministic.

### 12.2 Existing metadata import

**FR-META-020:** On first import, Lightroom hierarchy paths shall be processed before flat keywords.

**FR-META-021:** Flat terms already represented by imported hierarchy paths shall be treated as compatibility copies rather than duplicate roots.

**FR-META-022:** Unmatched flat keywords shall become root tags.

**FR-META-023:** A slash in a pre-existing flat keyword shall not automatically create hierarchy.

**FR-META-024:** Alternate hierarchy namespaces not controlled by PhotoTagger shall be preserved and may generate a compatibility warning.

**FR-META-025:** When a file's hierarchical and flat controlled fields disagree, hierarchy shall take precedence and unmatched flat terms shall remain recoverable roots.

### 12.3 Job coalescing

**FR-META-030:** Each photo shall have at most one active desired metadata job record.

**FR-META-031:** A tag-changing transaction shall increment `desired_metadata_revision` and upsert the job's requested revision.

**FR-META-032:** A short inactivity debounce, nominally one second, shall postpone the physical write so rapid edits can coalesce.

**FR-META-033:** The worker shall read the newest committed desired state immediately before constructing output.

**FR-META-034:** If the desired revision advances during a write, successful completion shall acknowledge only the written revision and leave the newer revision pending.

**FR-META-035:** Pending jobs shall survive application restart.

**FR-META-036:** Trashed, missing, unreadable, or externally conflicted photos shall suspend metadata jobs until eligible again.

### 12.4 Safe metadata write

**FR-META-040:** Metadata operations shall be serialized through one persistent ExifTool process or an equivalently serialized mechanism.

**FR-META-041:** Metadata values and paths shall be passed without shell interpolation.

**FR-META-042:** Before writing, the worker shall record the canonical whole-file hash, image-data hash, desired revision, and all temporary paths in the operation journal.

**FR-META-043:** ExifTool output shall be written to a unique temporary file on the same volume rather than overwriting the canonical file directly.

**FR-META-044:** The temporary output shall fully decode, retain expected dimensions, preserve image-data hash, contain the desired normalized tag sets, and contain a decodable embedded thumbnail when reported successful.

**FR-META-045:** Replacement shall use this recoverable sequence:

1. Rename canonical JPEG to a unique Working backup.
2. Rename verified temporary JPEG to the canonical filename.
3. Verify the canonical file.
4. Delete the Working backup.
5. Commit the current hash, observed size/time, synchronized revision, and warning state.

**FR-META-046:** The only valid copy shall never be deleted during recovery.

**FR-META-047:** Metadata removal shall rewrite the complete desired controlled tag set; it shall not depend on subtracting one value from an unknown file state.

### 12.5 Failure and retry

**FR-META-050:** A failed pre-swap validation shall leave the canonical file untouched and retain the job.

**FR-META-051:** Transient failures may retry with bounded backoff; persistent failure shall remain visible and manually retryable.

**FR-META-052:** A core tag write may complete as synchronized-with-warning when only best-effort embedded-thumbnail or legacy-IPTC behavior failed.

**FR-META-053:** A metadata failure shall not block navigation, SQLite tagging, or unrelated photo jobs.

## 13. Library filtering, ordering, and selection

### 13.1 Tag filters

**FR-LIB-001:** Library tag search shall resolve selected suggestions to tag IDs rather than relying on display strings.

**FR-LIB-002:** Multiple selected tag filters shall use AND logic.

**FR-LIB-003:** Filtering by a parent shall match explicit assignment of that parent and explicit assignment of any descendant.

**FR-LIB-004:** Full paths shall disambiguate equal leaf names in suggestions and active filter pills.

**FR-LIB-005:** The flag control shall toggle between all photos and flagged-only results.

**FR-LIB-006:** The default result order shall be `photo_id DESC`.

**FR-LIB-007:** Equal primary sort values shall use photo ID as a deterministic tie-breaker.

### 13.2 Query and selection lifecycle

**FR-LIB-010:** Changing a tag filter, flag filter, or ordering option shall clear Library selection after resolving any staged batch-tag changes.

**FR-LIB-011:** Select All shall select the entire current filtered result set, not the entire unfiltered catalog.

**FR-LIB-012:** Select All may be represented as query identity plus explicit exceptions rather than materializing every selected ID in the renderer.

**FR-LIB-013:** Unselect All shall clear the complete logical selection, including offscreen rows.

**FR-LIB-014:** Result and selection counts shall reflect the complete logical query, not only rendered thumbnails.

**FR-LIB-015:** Active lifecycle photos with integrity warnings may remain represented in Library with warning state; purged and trashed photos shall not appear in normal Library results.

**FR-LIB-016:** Selection membership shall be a logical snapshot of the matching photo IDs at the time each selection action occurs; later imports or tag changes shall not silently add photos to that selection.

**FR-LIB-017:** A query-backed Select All implementation shall preserve the exact captured membership even if it avoids materializing every selected ID in the renderer.

### 13.3 Image View session

**FR-LIB-020:** Opening Image View from one selected Library photo shall capture the ordered IDs of the current filtered result as the active sequence.

**FR-LIB-021:** New imports and subsequent filter membership changes shall not mutate the active sequence until Library is revisited and the query is refreshed.

**FR-LIB-022:** Trashing or purging an ID in the active sequence shall remove it and move navigation to the nearest remaining item.

**FR-LIB-023:** Missing or unreadable sequence members may display a placeholder but shall not prevent navigation to the next valid member.

**FR-LIB-024:** Returning to Library shall restore the same filter controls and refresh result membership from current catalog state.

## 14. Multi-photo tagging

### 14.1 Assignment states

**FR-BATCH-001:** For a Library selection, each exact tag shall calculate one of these base states from explicit assignments:

- Off: assigned to none.
- Mixed: assigned to some but not all.
- On: assigned to all.

**FR-BATCH-002:** Inherited descendant presence shall be indicated separately from exact explicit state.

**FR-BATCH-003:** Existing/applied batch information shall show common tags and mixed counts such as `Family 8/12`.

### 14.2 Staging and application

**FR-BATCH-009:** The Library Tagging Panel shall be disabled when no photos are selected. Any Library selection, including exactly one photo, shall use the staged apply workflow; immediate tag mutation is reserved for Image View.

**FR-BATCH-010:** Pallet interaction for one or more selected Library photos shall stage a batch edit plan before database mutation.

**FR-BATCH-011:** Clicking Off shall stage Apply-to-all.

**FR-BATCH-012:** Clicking Mixed shall stage Apply-to-all.

**FR-BATCH-013:** Clicking projected On shall stage Remove-from-all for that exact tag.

**FR-BATCH-014:** Removing a parent shall not stage removal of descendants.

**FR-BATCH-015:** The pills shall display the projected post-apply state while changes are staged.

**FR-BATCH-016:** `Apply tags to selected` shall be enabled only when a valid selection and at least one staged change exist.

**FR-BATCH-017:** Changing selection, filters, mode, or destination with staged edits shall offer Apply, Discard, or Cancel.

**FR-BATCH-018:** Applying shall evaluate the logical selection at the captured query revision, exclude ineligible conflicted/missing/unreadable photos, and report skipped records.

**FR-BATCH-019:** Eligible assignment changes and desired revision increments shall commit in one SQLite transaction.

**FR-BATCH-020:** One coalesced metadata job shall be queued per materially affected eligible photo.

**FR-BATCH-021:** A batch affecting more than the configured threshold, default 500 photos, shall show the affected count and require confirmation.

**FR-BATCH-022:** No hard selection or batch-assignment limit shall be imposed below the supported collection target.

## 15. Flags

**FR-FLAG-001:** A photo flag shall be a SQLite boolean and shall not be written to JPEG rating or label metadata.

**FR-FLAG-002:** Image View Flag shall toggle the current photo immediately.

**FR-FLAG-003:** For multiple selected photos, Flag shall set all selected eligible photos when at least one is unflagged, and clear all when every selected eligible photo is flagged.

**FR-FLAG-004:** Flag changes shall not create JPEG metadata jobs.

**FR-FLAG-005:** Flagged-only Library filtering shall combine with tag filters using AND logic.

## 16. Internal Trash and permanent deletion

### 16.1 Move to Trash

**FR-TRASH-001:** Clicking Trash for the current or selected photos shall open a Yes/No confirmation defaulting to No.

**FR-TRASH-002:** Confirmation shall identify one photo by canonical filename or identify the selected count for a batch.

**FR-TRASH-003:** Each eligible photo shall receive a journaled Trash operation before filesystem mutation.

**FR-TRASH-004:** The active JPEG shall move from Storage to `Trash/Photos` through a same-volume rename without metadata or pixel rewriting.

**FR-TRASH-005:** The cached thumbnail shall move when available; thumbnail failure shall not undo a successful photo move.

**FR-TRASH-006:** Lifecycle state shall become trashed only after observed file state is consistent or recoverably journaled.

**FR-TRASH-007:** A batch shall process photos independently; one failure shall not roll back successfully trashed photos.

**FR-TRASH-008:** Metadata jobs for a trashed photo shall remain suspended rather than discarded.

### 16.2 Trash view and restore

**FR-TRASH-010:** Trash shall be accessible from the gear menu and shall display a grid, count, total size, selection controls, Restore Selected, Delete Selected Permanently, and Empty Trash.

**FR-TRASH-011:** Trashed photos may be viewed read-only but not tagged.

**FR-TRASH-012:** Trash shall be retained indefinitely and shall have no automatic purge timer in version 1.

**FR-TRASH-013:** Restore shall journal and rename the JPEG back to its canonical Storage path, restore or regenerate the thumbnail, and return lifecycle state to active.

**FR-TRASH-014:** Restore shall resume metadata synchronization only after integrity is clean.

**FR-TRASH-015:** If the canonical Storage destination is occupied, neither file shall be overwritten; the operation shall enter recovery review.

### 16.3 Permanent deletion

**FR-TRASH-020:** Permanent deletion shall require a distinct confirmation displaying count, known total size, and irreversible wording; the default action shall be No/Cancel.

**FR-TRASH-021:** Before an authorized purge batch, the app shall create a verified catalog safety snapshot and a deletion manifest. If either cannot be verified, no JPEG in the purge batch shall be deleted.

**FR-TRASH-022:** The purge journal shall record explicit user authorization before any file unlink.

**FR-TRASH-023:** The external thumbnail shall be removed before or independently of the photo; failure to remove a cache file shall be recoverable.

**FR-TRASH-024:** The JPEG shall be deleted only from internal Trash, never directly from active Storage through the normal UI.

**FR-TRASH-025:** Database lifecycle state shall become purged only after the JPEG is verified absent or an authorized purge recovery record proves the deletion step completed.

**FR-TRASH-026:** Purge shall remove photo-tag assignments, flags, live paths, and thumbnail state while retaining a tombstone containing ID, hashes, original filename, timestamps, and deletion batch identity.

**FR-TRASH-027:** Catalog backups shall not be described as backups of purged image bytes.

## 17. External modification detection and resolution

### 17.1 Detection

**FR-EXT-001:** Normal startup shall enumerate expected filenames and perform background size/mtime comparison without hashing every file.

**FR-EXT-002:** Current and visible photos shall receive priority validation.

**FR-EXT-003:** Filesystem watcher events shall enqueue validation hints but shall not be treated as complete evidence.

**FR-EXT-004:** A changed quick fingerprint shall trigger whole-file hash, full decode, image-data hash, and controlled metadata reads as applicable.

**FR-EXT-005:** A changed timestamp with an unchanged whole-file hash shall update observations without creating a conflict.

**FR-EXT-006:** Changed whole-file bytes with unchanged image-data hash and unchanged controlled metadata shall be accepted as an uncontrolled metadata change.

**FR-EXT-007:** Changed controlled metadata with unchanged image data shall produce `metadata_conflict`.

**FR-EXT-008:** Changed valid image data shall produce `content_conflict`.

**FR-EXT-009:** Failed full decode shall produce `unreadable` without moving or deleting the file automatically.

**FR-EXT-010:** An absent expected active or trashed file shall produce `missing` without deleting its catalog record.

### 17.2 Unknown and renamed files

**FR-EXT-020:** An unknown JPEG in Storage shall be compared with missing records when a safe hash match is available.

**FR-EXT-021:** A uniquely matched externally renamed photo may be restored to its canonical ID filename and logged.

**FR-EXT-022:** An unmatched or ambiguous Storage orphan shall move to Recovery without deletion.

**FR-EXT-023:** If both canonical and alternate candidates exist, both shall be preserved pending review.

### 17.3 Metadata conflict actions

**FR-EXT-030:** Metadata-conflicted photos shall remain viewable but tagging and metadata writes shall be disabled for them.

**FR-EXT-031:** `Keep Catalog Tags` shall rewrite only controlled fields from SQLite while preserving unrelated external metadata.

**FR-EXT-032:** `Use File Tags` shall import hierarchy first, create unmatched flat roots, update SQLite, and normalize all controlled metadata fields afterward.

**FR-EXT-033:** `Resolve Later` shall make no change and retain the conflict.

**FR-EXT-034:** Batch review may apply one choice to multiple metadata-only conflicts after confirmation.

### 17.4 Content conflict actions

**FR-EXT-040:** `Accept Changed Image` shall retain photo ID and catalog tags, advance content revision, update dimensions and hashes, regenerate thumbnails, and queue controlled metadata synchronization.

**FR-EXT-041:** The immutable source hash shall not change when accepting a content revision.

**FR-EXT-042:** `Restore From Backup` shall retain the conflict until the user supplies or restores a valid file.

**FR-EXT-043:** `Resolve Later` shall preserve current state without pixel overwrite.

**FR-EXT-044:** PhotoTagger shall never automatically replace externally changed image data with a different copy.

## 18. Catalog backup

### 18.1 Snapshot creation

**FR-BACK-001:** Catalog snapshots shall be created through SQLite's supported live-backup mechanism rather than copying the open main database file.

**FR-BACK-002:** Automatic backup shall wait until no filesystem journal is in a critical swap or deletion phase.

**FR-BACK-003:** Output shall first use a unique `.partial` path.

**FR-BACK-004:** A completed candidate shall be opened separately and checked with `quick_check`, `foreign_key_check`, schema version, and key record counts.

**FR-BACK-005:** A SHA-256 and manifest shall identify the verified snapshot, application version, schema version, catalog revision, creation time, and counts.

**FR-BACK-006:** Only a verified candidate shall be renamed to its final backup filename.

**FR-BACK-007:** Interrupted partial backups shall never replace or invalidate older verified snapshots.

### 18.2 Triggers and retention

**FR-BACK-010:** At most one automatic snapshot shall be created per calendar day when the catalog changed and the application reaches an idle opportunity.

**FR-BACK-011:** Verified safety snapshots shall be created before schema migration, catalog restore, permanent Trash purge, and destructive bulk tag administration.

**FR-BACK-012:** The user shall be able to request an immediate backup.

**FR-BACK-013:** Retention shall preserve seven daily, four weekly, six monthly, and three recent safety snapshots.

**FR-BACK-014:** Weekly and monthly retention shall select existing snapshots rather than require duplicate snapshot creation.

**FR-BACK-015:** Manual exports shall not be automatically removed.

### 18.3 Secondary destination and export

**FR-BACK-020:** The user may configure one secondary local filesystem destination.

**FR-BACK-021:** An unavailable secondary destination shall not block normal operation and shall be retried later.

**FR-BACK-022:** A secondary destination on the same physical volume shall generate a warning.

**FR-BACK-023:** Only verified snapshots and manifests shall be copied to the secondary destination.

**FR-BACK-024:** Export Recovery Bundle shall include a verified snapshot, manifest/checksum, human-readable hierarchy JSON, photo-to-tag CSV, and settings export.

**FR-BACK-025:** The recovery bundle shall not claim to contain photo bytes.

## 19. Catalog restoration and rebuild

### 19.1 Staged restoration

**FR-REST-001:** Restore shall stop mutating workers and enter maintenance mode.

**FR-REST-002:** The selected backup shall be copied into Working and validated before use.

**FR-REST-003:** A backup with a newer unsupported schema shall be rejected without changing the live catalog.

**FR-REST-004:** The current readable catalog shall receive an emergency safety snapshot before replacement.

**FR-REST-005:** Supported migrations shall apply only to the staged restore copy.

**FR-REST-006:** The staged result shall pass full `integrity_check` and `foreign_key_check` before activation.

**FR-REST-007:** Activation shall use a journaled swap that preserves the previous catalog until the replacement opens successfully.

**FR-REST-008:** Open jobs from an old snapshot shall enter recovery evaluation and shall not replay destructive phases blindly.

### 19.2 Restore modes

**FR-REST-010:** Recover Current Collection shall use the snapshot for catalog structure and SQLite-only information, then reconcile present Storage/Trash locations and current embedded tags as potentially newer evidence.

**FR-REST-011:** Roll Back Catalog State shall preview differing controlled tags and the estimated number of JPEG rewrites before confirmation.

**FR-REST-012:** Neither mode shall imply recovery of permanently deleted photo bytes.

### 19.3 Rebuild from photos

**FR-REST-020:** If no valid backup is available, the user may rebuild into a new temporary catalog without overwriting the failed database first.

**FR-REST-021:** The failed database, WAL, and SHM files shall be preserved in Recovery before activating a rebuild.

**FR-REST-022:** Rebuild shall enumerate canonical IDs from Storage and Trash, fully validate files, calculate hashes/dimensions, read preserved names, import hierarchy and flat keywords, and regenerate missing thumbnails.

**FR-REST-023:** Rebuild shall set the next ID above every recovered and tombstoned ID available from evidence.

**FR-REST-024:** The application shall disclose that SQLite-only flags, Pallet order, explicit/inferred distinctions not encoded in hierarchy, and unavailable history may be lost.

**FR-REST-025:** Rebuild shall not rewrite photo metadata unless separately required and authorized after catalog activation.

## 20. Operation recovery matrices

### 20.1 Import recovery

| Observed state | Required recovery |
| --- | --- |
| Source present, destination absent, no valid temp | Retry from the last safe validation phase. |
| Valid import temp present | Verify and continue; recreate if invalid while source exists. |
| Destination present, catalog incomplete | Verify destination and finish catalog commit. |
| Catalog complete, converted source remains | Verify stored photo again, then finish authorized source cleanup. |
| Exact-duplicate job complete, duplicate source remains | Reconfirm exact match and stored readability before cleanup. |
| Canonical Storage orphan with journal evidence | Reconcile to its reserved photo/job. |
| Canonical Storage orphan without safe evidence | Move to Recovery; never auto-delete. |

### 20.2 Metadata replacement recovery

| Canonical | Temp | Working backup | Required recovery |
| --- | --- | --- | --- |
| Valid | Any | Absent | Treat canonical as primary; validate/remove stale temp safely. |
| Absent | Valid | Valid | Promote valid temp, verify, then remove backup. |
| Absent | Invalid/absent | Valid | Restore backup to canonical. |
| Valid | Absent | Valid | Compare journal and hashes; retain valid canonical, then archive/delete backup only when proven redundant. |
| Multiple ambiguous valid candidates | Any | Any | Preserve all and require recovery review. |

### 20.3 Trash recovery

| Journal/observed state | Required recovery |
| --- | --- |
| Move pending; file remains in Storage | Retry move. |
| Move pending; file is in Trash | Finish lifecycle update. |
| Restore pending; file remains in Trash | Retry restore. |
| Restore pending; file is in Storage | Finish lifecycle update. |
| Authorized purge pending; file remains | Resume deletion. |
| Authorized purge pending; file absent | Finish tombstone transition. |
| Both Storage and Trash copies exist | Preserve both and require recovery review. |
| Trash file missing without authorized purge | Mark missing and retain catalog record. |

## 21. Settings and maintenance

### 21.1 Gear menu

**FR-SET-001:** The gear menu shall provide direct routes to Settings, Manage Tags, Edit Tag Pallet, Import Problems, External Changes, and Trash.

**FR-SET-002:** Import Problems, External Changes, Trash, and failed Metadata Activity may display count badges.

**FR-SET-003:** Maintenance destinations shall replace the central content region and hide the Tagging Panel.

### 21.2 General settings

**FR-SET-010:** General settings shall include JPEG quality, transparency background, default Library order, bulk confirmation threshold, and read-only Collection path.

**FR-SET-011:** Defaults shall be quality 92, white background, newest import first, and threshold 500.

**FR-SET-012:** A conversion-setting change shall state that it affects future imports only.

### 21.3 Maintenance areas

**FR-SET-020:** Backup and Recovery shall expose backup now, last success, secondary destination, export, restore, rebuild, and retained snapshot listing.

**FR-SET-021:** Library Maintenance shall expose Verify Library, regenerate missing thumbnails, rebuild all thumbnails, scan for external changes, and storage/count information.

**FR-SET-022:** Metadata Activity shall expose pending and failed jobs with Retry Selected and Retry All.

**FR-SET-023:** Diagnostics and About shall expose application/dependency versions, local logs, diagnostic export, and third-party licenses.

**FR-SET-024:** Dangerous maintenance actions shall identify scope, remain cancellable at safe boundaries, and use the approved confirmation rules.

## 22. Operational status, errors, and logging

### 22.1 User-visible status

**FR-OPS-001:** Import, conversion, thumbnail creation, metadata replacement, Trash movement, purge, backup, restore, and filesystem repair shall indicate active physical writes with the orange status light.

**FR-OPS-002:** Reading, filtering, selection, and ordinary navigation shall not activate the orange light.

**FR-OPS-003:** Long operations shall report completed count, total known count, and the currently safe stop behavior in concise text or the relevant maintenance page.

**FR-OPS-004:** A quarantined input or suspended conflict shall not prevent the application from returning to a safe usable state for unrelated photos.

### 22.2 Error classification

Errors shall be classified at least as:

- Validation or unsupported input.
- Transient source lock/instability.
- Insufficient space.
- Collection unavailable or removed.
- Permission denied.
- Catalog constraint or integrity failure.
- Metadata warning.
- Metadata synchronization failure.
- External metadata conflict.
- External content conflict.
- Recovery ambiguity.

**FR-OPS-010:** User messages shall identify the affected filename or photo ID, the failed operation, whether data remains safe, and the available next action.

**FR-OPS-011:** Raw stack traces and command lines shall not replace user-facing explanations.

### 22.3 Logs

**FR-OPS-020:** Logs shall remain under `Collection/Data/Logs`.

**FR-OPS-021:** Logs shall include timestamps, application version, operation/job IDs, photo IDs, relative paths, state transitions, tool exit status, warnings, and errors.

**FR-OPS-022:** Logs shall not include full image bytes, thumbnails, authentication secrets, or unrestricted metadata dumps.

**FR-OPS-023:** Logs shall rotate by bounded file count and size; exact values are set in technical design.

**FR-OPS-024:** Diagnostic export shall be explicit and shall disclose that filenames and paths may be included.

## 23. Offline and security behavior

**FR-SEC-001:** Production Content Security Policy shall prohibit network connections by default.

**FR-SEC-002:** Production renderer content shall load only packaged local assets and explicitly served local photo resources.

**FR-SEC-003:** `nodeIntegration` shall be disabled for renderer pages and context isolation shall be enabled.

**FR-SEC-004:** A sandboxed renderer shall be used unless a documented Electron limitation requires a narrower approved exception.

**FR-SEC-005:** The preload bridge shall expose named operations, not generic path, shell, SQL, or command execution.

**FR-SEC-006:** Every incoming IPC payload shall be schema-validated in the privileged process.

**FR-SEC-007:** Filesystem targets shall be canonicalized and checked against the allowed Collection directories before use.

**FR-SEC-008:** ExifTool and other child processes shall be spawned directly with argument arrays or a controlled UTF-8 argument protocol; the system shell shall not interpret filenames or tags.

**FR-SEC-009:** Renderer photo access shall use a constrained local protocol or equivalent mechanism that cannot read arbitrary local files.

**FR-SEC-010:** The application shall not require administrator privileges.

## 24. Performance behavior

**FR-PERF-001:** The supported reference catalog shall contain 100,000 photo records and 10,000 tags.

**FR-PERF-002:** The application shall become usable within five seconds under documented reference conditions without waiting for full integrity scanning.

**FR-PERF-003:** An indexed tag/flag filter shall return its first result page and complete count within 500 milliseconds under documented reference conditions.

**FR-PERF-004:** The Library shall use virtualization and paged/keyset queries so renderer work is not proportional to the entire result count.

**FR-PERF-005:** Select All shall support the entire filtered reference catalog without creating one DOM node per photo.

**FR-PERF-006:** Import shall support a 10,000-file Inbox snapshot without loading decoded image contents for multiple files concurrently.

**FR-PERF-007:** Physical photo mutations shall default to sequential execution to reduce HDD seek contention and simplify recovery.

**FR-PERF-008:** SQLite queries and long CPU/file tasks shall not block renderer input.

**FR-PERF-009:** Thumbnail cache loading shall be lazy and shall tolerate cold external-HDD access without layout collapse.

## 25. Acceptance scenarios

The detailed test plan will expand these scenarios with fixtures and fault injection. Version 1 shall, at minimum, pass the following:

| ID | Scenario | Expected result |
| --- | --- | --- |
| AC-001 | Launch with the network disconnected | All normal features operate; no network error appears. |
| AC-002 | Move the portable folder to a different drive letter | Catalog and relative paths open correctly. |
| AC-003 | Import a valid JPEG | File is renamed/moved, not re-encoded; image-data hash is preserved. |
| AC-004 | Import a transparent PNG | Pixels are flattened over configured background, converted at configured quality, verified, and source is deleted only after success. |
| AC-005 | Import a still WebP | Verified JPEG, thumbnails, metadata, hashes, and catalog record are created. |
| AC-006 | Import an animated WebP or GIF | File moves to Failed with an explicit unsupported-animation reason. |
| AC-007 | Import an exact duplicate | Stored photo is verified; duplicate Inbox copy is removed and logged without a new photo. |
| AC-008 | Import same JPEG image data with different metadata | Source is not automatically deleted as an exact duplicate. |
| AC-009 | Interrupt every import phase | Restart reaches a deterministic safe state without losing the only valid source/result. |
| AC-010 | Enter `People/Family/Josh` | Hierarchy resolves/creates correctly and Josh is the explicit assignment. |
| AC-011 | Expand People, Family, and deeper descendants | Each child renders directly beneath its parent inside a scrollable Pallet. |
| AC-012 | Reopen a photo with a pinned explicit tag | Corresponding Pallet pill appears depressed and glowing. |
| AC-013 | Apply several tags rapidly | SQLite reflects every final choice; JPEG receives one coalesced final write when timing permits. |
| AC-014 | Remove a tag | All controlled file fields are rewritten to the complete desired set; unrelated metadata remains. |
| AC-015 | Embedded thumbnail cannot fit | Core tag sync succeeds, external thumbnail remains, and a capacity warning is recorded. |
| AC-016 | Filter by parent tag | Photos assigned to the parent or any descendant appear. |
| AC-017 | Filter by two tags and Flag | Only photos matching both tag conditions and flagged state appear. |
| AC-018 | Select multiple Library photos | Image View is visibly and accessibly disabled. |
| AC-019 | Select one filtered photo and open Image View | Next/Previous use the frozen filtered sequence. |
| AC-020 | Stage a Mixed batch tag and Apply | Exact assignments become consistent in one transaction and eligible photos receive jobs. |
| AC-021 | Change filters with staged batch edits | Apply/Discard/Cancel choice appears; no invisible accidental apply occurs. |
| AC-022 | Trash one or many photos | Yes/No dialog appears; files move without JPEG rewrite and disappear from normal Library. |
| AC-023 | Restore a photo | Same ID returns to Storage with tags/flag intact and thumbnail available. |
| AC-024 | Permanently delete from Trash | Strong second confirmation, safety snapshot, manifest, file removal, and tombstone occur. |
| AC-025 | Crash during Trash, restore, or purge | Journal recovery follows the approved matrix and preserves ambiguous copies. |
| AC-026 | Change only unrelated metadata externally | Change is accepted without overwriting or conflict. |
| AC-027 | Change app-controlled tags externally | Metadata conflict appears; file is not silently overwritten. |
| AC-028 | Replace image pixels externally | Content conflict appears and metadata writes suspend until resolution. |
| AC-029 | Create daily catalog backup | Verified snapshot and manifest are created without raw copying of the open WAL database. |
| AC-030 | Interrupt backup creation | Partial output is ignored; older verified backups remain usable. |
| AC-031 | Restore a valid older catalog | Restore occurs in staging, validates, activates through safe swap, and reconciles current files. |
| AC-032 | Rebuild with no catalog | IDs, readable files, metadata tags, Trash state, hashes, and thumbnails are recovered as specified. |
| AC-033 | Exercise reference-scale filtering | Response and UI targets are met under documented hardware/cache conditions. |
| AC-034 | Add files to Inbox during active import | New files remain for the next import snapshot. |
| AC-035 | Request import stop during conversion | Current source reaches a safe state and unstarted files remain in Inbox. |
| AC-036 | Remove the drive during a journaled write | No fallback collection is created; affected operation remains recoverable after restart. |
| AC-037 | Select All, then import or retag other photos before applying | The original logical selection remains fixed; no newly matching photo is changed by the pending batch. |

## 26. Product-to-functional traceability

| Product goal | Primary functional coverage |
| --- | --- |
| PS-01 Local/offline | FR-PLAT-003–004, FR-SEC-001–010 |
| PS-02 Portable external drive | FR-PLAT-001–010, FR-START-001–006 |
| PS-03 Safe Inbox import | FR-IMP-001–052, FR-FAIL-001–005 |
| PS-04 Preserve JPEG image data | FR-IMP-040–044, FR-META-042–046 |
| PS-05 Normalize PNG/WebP | FR-IMP-050–052, FR-CONV-001–022 |
| PS-06 Immutable identity | FR-ID-001–004 |
| PS-07 SQLite catalog/no sidecars | FR-STATE-001–002, FR-TAG-020–024, FR-META-001 |
| PS-08 Embedded interoperable tags | FR-META-001–025, FR-THM-010–014 |
| PS-09 Hierarchical tags | FR-TAG-001–044, FR-TADM-001–044 |
| PS-10 Image and Library views | FR-UI-010–046, FR-LIB-001–024 |
| PS-11 Batch operations | FR-BATCH-001–022, FR-FLAG-003 |
| PS-12 Edit/View modes | FR-UI-020–024 |
| PS-13 Compact status | FR-UI-060–067, FR-OPS-001–011 |
| PS-14 Reversible deletion | FR-TRASH-001–027, Section 20.3 |
| PS-15 External changes | FR-EXT-001–044 |
| PS-16 Backup/restore/rebuild | FR-BACK-001–025, FR-REST-001–025 |
| PS-17 Target scale | FR-PERF-001–009 |
| PS-18 Interruption recovery | FR-START-004–005, FR-SHUT-001–005, Section 20 |
| PS-19 Maintenance/diagnostics | FR-SET-001–024, FR-OPS-020–024 |

## 27. Deferred technical decisions

The following choices remain for the technical design and do not alter approved product behavior:

- Pinned Electron, Sharp, ExifTool, and SQLite-library versions.
- SQLite binding selection and worker placement.
- Packaging tool and build pipeline.
- Exact schema, indexes, triggers, migration file format, and application ID.
- Exact normalization-key implementation for Unicode case-insensitive sibling comparison.
- Metadata copy allowlist for PNG/WebP conversion fixtures.
- Thumbnail JPEG quality and cache-shard function.
- Stability interval, retry delays, and bounded metadata backoff values.
- Reference performance hardware and cold/warm cache test procedure.
- Log rotation limits and diagnostic bundle format.
- Working application name, icon, and final visual branding.

These decisions shall be documented before their affected implementation phase and shall remain subordinate to this functional contract.

## 28. Definition of functional readiness

The functional specification is ready to enter technical design when:

1. Every PS goal maps to functional requirements.
2. Import, metadata, Trash, external-change, backup, and restore outcomes are deterministic for known states.
3. No function depends on internet access.
4. No destructive operation lacks confirmation, journal state, or recovery behavior.
5. Target scale and query semantics are explicit.
6. UI behaviors agree with the approved layout.
7. Remaining decisions are implementation choices rather than missing user-facing policy.

This document satisfies those conditions subject to final review of the generated specifications.
