# PhotoTagger Technical Design Specification

**Document version:** 1.0  
**Product version:** Version 1  
**Status:** Technical baseline for implementation  
**Related documents:** <code>PhotoTagger_Product_Specification_v1.md</code>; <code>PhotoTagger_Functional_Specification_v1.md</code>  
**Target platform:** Windows x64 on an NTFS external HDD  
**Working product name:** PhotoTagger  
**Date:** 2026-09-13

## 1. Purpose and authority

This document defines how PhotoTagger version 1 will be implemented. It converts the approved product and functional behavior into a concrete software architecture, database schema, process model, filesystem protocol, IPC contract, recovery design, build configuration, and test strategy.

The documents have this order of authority:

1. The Product Specification controls product intent, scope, and priorities.
2. The Functional Specification controls observable behavior.
3. This Technical Design Specification controls implementation.
4. Source code, migrations, tests, and packaging must conform to all three.

If this design conflicts with an approved product or functional requirement, the higher-level requirement wins. The conflict must be corrected in the design or returned for explicit product approval; implementation convenience is not sufficient reason to weaken a requirement.

## 2. Design objectives

The implementation must optimize for these qualities, in order:

1. Preserve the only valid photo copy.
2. Recover deterministically after interruption or drive removal.
3. Avoid re-encoding existing JPEG pixels.
4. Keep the renderer responsive while work occurs on a mechanical external HDD.
5. Keep SQLite authoritative while projecting portable tags into JPEG metadata.
6. Keep all privileged operations outside the renderer.
7. Keep the distribution offline, portable, installation-free, and reproducible.
8. Make states and failures observable through durable records and concise UI status.

The design assumes one user, one collection, one computer, and one active PhotoTagger instance.

## 3. Locked technical decisions

| Area | Decision |
| --- | --- |
| Language | Strict TypeScript compiled to JavaScript; HTML and CSS for presentation |
| Desktop runtime | Electron 44.3.0 |
| Renderer | React 19.3.0 with ordinary CSS and TanStack Virtual |
| Build/package | Electron Forge 7.11.2, Webpack 5, ASAR plus native unpacking, ZIP distribution |
| Catalog binding | better-sqlite3 13.0.3, bundling SQLite 3.53.4 |
| Catalog placement | Dedicated Electron utility process owning one SQLite connection |
| Image engine | Sharp 0.35.4 in one dedicated utility process |
| Metadata engine | Bundled ExifTool 13.59 x64, one persistent serialized process |
| Validation | Zod 4.6.4 at IPC and worker boundaries |
| Logging | Pino 10.3.1 emitting bounded local NDJSON |
| Testing | Vitest 5.0.0 plus Playwright 1.63.0 and custom fault injection |
| Dependency policy | Exact direct versions and committed package-lock; no version ranges |
| Filesystem mutation | One serialized physical-write lane coordinated by the main process |
| Renderer file access | ID-only custom protocol; no renderer-supplied paths |
| Database paths | Derived or Collection-relative; never absolute in durable records |
| Time format | UTC ISO-8601 text for event time; signed 64-bit nanoseconds for observed filesystem mtime |
| Hash storage | Raw 32-byte SHA-256 BLOB values in SQLite; lowercase hex only at display/export boundaries |
| Thumbnail shard | Lower eight bits of photo ID as two lowercase hexadecimal characters |

The versions above are the implementation baseline as of this document date. A release may move to a later patch version only through a dependency-change record and a complete Windows package, recovery, and acceptance test run. Major-version changes require a design revision.

## 4. System context

PhotoTagger has no network-facing component and does not communicate with cloud services. Windows Explorer is used to place sources into Inbox and may be used to inspect application-owned folders. The application reads and writes only beneath its portable Collection root, except for a user-selected secondary catalog-backup destination and explicit folder-opening actions.

~~~mermaid
flowchart TD
    UI["Sandboxed renderer"] --> Bridge["Validated preload bridge"]
    Bridge --> Main["Main coordinator"]
    Main --> Catalog["Catalog utility process"]
    Main --> Image["Sharp utility process"]
    Main --> Metadata["Persistent ExifTool process"]
    Main --> Files["Collection filesystem"]
    Catalog --> DB["SQLite catalog"]
    Image --> Files
    Metadata --> Files
~~~

### 4.1 Trust boundaries

- The renderer is unprivileged and is treated as potentially compromised.
- The preload bridge exposes named, typed methods only.
- The main process validates renderer identity and every payload before acting.
- Utility processes accept requests only from the main process and validate them again.
- ExifTool receives UTF-8 argument-file input through a pipe, not shell-expanded command text.
- Files found in Inbox, Storage, Trash, Failed, or Recovery are untrusted data.
- No metadata text is interpreted as HTML, a path, a command, or an executable expression.

## 5. Runtime process architecture

### 5.1 Main coordinator

The Electron main process owns:

- Portable-root and Collection resolution.
- Application and collection single-instance enforcement.
- Browser-window lifecycle and security policy.
- IPC registration, sender validation, and request cancellation.
- The global physical-write scheduler.
- Filesystem path derivation and containment checks.
- Journal-before-mutation sequencing.
- Import orchestration.
- Metadata-worker orchestration.
- Trash, restore, purge, backup, and external-change orchestration.
- Custom application and photo protocols.
- User-visible status aggregation.
- Shutdown coordination.

The main process does not run large SQL queries, decode images, or transform pixels.

### 5.2 Catalog utility process

One Electron <code>utilityProcess</code> owns exactly one better-sqlite3 connection. All catalog reads and writes pass through its request/response port.

Responsibilities:

- Open, validate, migrate, checkpoint, back up, and close SQLite.
- Execute prepared queries and transactions.
- Maintain catalog revision and all derived tag structures.
- Create temporary selection and Image View session tables.
- Return renderer-safe DTOs without paths, BLOBs, or 64-bit integers.
- Reject unknown operations or invalid state transitions.

The catalog process is isolated so a large selection snapshot, tag-administration transaction, backup operation, or integrity query does not block the Electron main event loop.

If the catalog process exits unexpectedly, the main process:

1. Disables all mutations.
2. Marks status as catalog unavailable.
3. Stops image and metadata mutations at their next safe boundary.
4. Preserves journal and filesystem state.
5. Offers application restart rather than automatically creating a new catalog.

### 5.3 Image utility process

One dedicated utility process loads Sharp and performs:

- Signature-assisted format validation.
- Metadata probing needed for image processing.
- Full decode-to-sink validation.
- PNG and still-WebP conversion.
- External thumbnail generation.
- Embedded-thumbnail candidate generation.
- Dimension and orientation checks.

Only one mutating image job runs at a time. Read-only visible-image validation may run only when the mutation lane is idle and is capped at one concurrent decode on the reference HDD.

The image process receives absolute paths only from the trusted main process. It returns measurements, hashes of decoded test output when requested, and structured errors; it never changes catalog state.

### 5.4 Metadata service

The main process starts one bundled ExifTool x64 process with:

~~~text
exiftool.exe -stay_open True -@ -
~~~

Commands are written one argument per UTF-8 line. Every request ends with a unique numbered <code>-executeNNN</code>, and the response is complete only after the matching <code>{readyNNN}</code>. Startup common arguments set filename and metadata character sets to UTF-8. The service permits one in-flight command.

The service:

- Parses JSON output.
- Rejects a response whose request marker does not match.
- Applies a 120-second command timeout.
- Terminates and recreates ExifTool after a timeout or malformed response.
- Never retries a write unless the journal and observed files prove retry safety.
- Closes with <code>-stay_open False</code> during clean shutdown.

### 5.5 Global physical-write scheduler

One scheduler serializes operations that modify application-owned files:

1. Recovery repairs.
2. User-confirmed Trash restore or conflict resolution.
3. Current import photo.
4. Interactive single-photo metadata synchronization.
5. Batch metadata synchronization.
6. Thumbnail maintenance.
7. Automatic backup copying and retention pruning.

Priority may choose the next operation but may not interrupt a critical phase already in progress. Each operation declares its safe stop points. Read-only Library queries and thumbnail display continue independently.

The scheduler uses a per-photo mutex in addition to the global write lane. A photo cannot be metadata-written, trashed, restored, purged, or externally reconciled by two operations at once.

## 6. Repository structure

The implementation repository will use:

~~~text
PhotoTagger/
  package.json
  package-lock.json
  forge.config.ts
  tsconfig.json
  webpack.main.config.ts
  webpack.renderer.config.ts
  assets/
    icons/
  docs/
    PhotoTagger_Product_Specification_v1.md
    PhotoTagger_Functional_Specification_v1.md
    PhotoTagger_Technical_Design_Specification_v1.md
    decisions/
  migrations/
    001_initial.sql
  scripts/
    build-release.ts
    verify-package.ts
    seed-performance-catalog.ts
  src/
    main/
      bootstrap/
      ipc/
      protocol/
      scheduler/
      services/
      main.ts
    preload/
      api.ts
      preload.ts
    catalog/
      commands/
      queries/
      repositories/
      migrations/
      catalog-process.ts
    image/
      pipelines/
      validation/
      image-process.ts
    metadata/
      exiftool-client.ts
      projection.ts
      verification.ts
    renderer/
      app/
      components/
      features/
      styles/
      index.html
      index.tsx
    shared/
      contracts/
      errors/
      ids/
      validation/
  tests/
    unit/
    integration/
    recovery/
    e2e/
    performance/
    fixtures/
      images/
      metadata/
      corrupt/
  vendor/
    exiftool/
      win32-x64/
        exiftool.exe
        exiftool_files/
        LICENSE
~~~

Feature modules may depend on <code>shared</code>, but <code>shared</code> may not import Electron, Node filesystem APIs, better-sqlite3, Sharp, or ExifTool code.

No renderer module may import from <code>main</code>, <code>catalog</code>, <code>image</code>, or <code>metadata</code>.

## 7. Build and dependency management

### 7.1 Toolchain

| Dependency | Baseline |
| --- | ---: |
| Electron | 44.3.0 |
| Bundled Node.js | 24.20.0 |
| Bundled Chromium | 152.0.7977.78 |
| npm used for reproducible install | 11.19.0 |
| Electron Forge packages | 7.11.2 |
| Webpack | 5.110.3 |
| TypeScript | 5.4.5 |
| mini-css-extract-plugin | 2.9.4 |
| React / React DOM | 19.3.0 |
| TanStack React Virtual | 3.14.12 |
| better-sqlite3 | 13.0.3 |
| SQLite amalgamation in better-sqlite3 | 3.53.4 |
| Sharp | 0.35.4 |
| ExifTool x64 | 13.59 |
| Zod | 4.6.4 |
| Pino | 10.3.1 |
| yazl | 3.3.1 |
| Vitest | 5.0.0 |
| Playwright | 1.63.0 |
| ESLint | 10.10.0 |
| Prettier | 3.9.6 |

All direct dependencies use exact versions in <code>package.json</code>. <code>package-lock.json</code> version 3 is committed. CI and release builds use <code>npm ci</code>. Native packages are built or selected for Electron 44.3.0 and Windows x64 and are verified from the packaged output, not only from the development tree.

Webpack emits four privileged entry artifacts—<code>main.js</code>, <code>catalog-process.js</code>, <code>image-process.js</code>, and <code>preload.js</code>—plus the renderer assets. The first three target Electron's main/Node environment, preload targets the isolated preload environment, and renderer targets the web platform. Renderer CSS is emitted as an external CSS asset by <code>mini-css-extract-plugin</code> rather than injected by JavaScript, allowing packaged builds to retain <code>style-src 'self'</code>. better-sqlite3 and Sharp native binaries are externalized from JavaScript bundling and resolved from verified ASAR-unpacked package paths. Production source maps are not shipped, and no runtime entry point loads code from Collection.

### 7.2 Packaging

Electron Forge produces:

- An unpacked Windows x64 application directory for validation.
- A ZIP containing that directory for release.
- A SHA-256 checksum file.
- A dependency/version manifest.
- Third-party license notices.

ASAR is enabled for application JavaScript and renderer assets. Native modules, Sharp binaries, and ExifTool are unpacked. The Forge native-unpack plugin handles native Node modules; an explicit package verification test confirms the actual <code>.node</code>, libvips, ExifTool executable, and <code>exiftool_files</code> paths.

The release ZIP does not contain a populated Collection. First launch creates it. Updating runtime files must not remove or overwrite an existing Collection directory.

### 7.3 Electron fuses

The packaged application sets:

- <code>RunAsNode = false</code>
- <code>EnableNodeOptionsEnvironmentVariable = false</code>
- <code>EnableNodeCliInspectArguments = false</code>
- <code>OnlyLoadAppFromAsar = true</code>
- <code>EnableEmbeddedAsarIntegrityValidation = true</code>
- <code>LoadBrowserProcessSpecificV8Snapshot = false</code>

Package verification inspects the resulting fuses. Development builds may retain debugging support but must use a separate application identity and test Collection.

## 8. Portable directory and path design

### 8.1 Portable root

In a packaged build:

~~~text
portableRoot = dirname(process.execPath)
collectionRoot = join(portableRoot, "Collection")
~~~

Development uses an explicit test-root argument or environment value set by test harness code. Production ignores environment overrides.

Before Electron becomes ready, the app redirects application-owned persistent Electron paths beneath:

~~~text
Collection/Data/Electron/
  UserData/
  SessionData/
  Logs/
  CrashDumps/
~~~

Crash upload is disabled. Network caches and service workers are disabled because the application has no network use.

### 8.2 Canonical Collection layout

~~~text
Collection/
  Inbox/
  Storage/
  Thumbnails/
    00/ through ff/
  Trash/
    Photos/
    Thumbnails/
      00/ through ff/
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
    collection.lock.json
    restore-state.json
    Backups/
      Automatic/
      Safety/
      Manual/
    Logs/
    Electron/
~~~

Standard directories are created one at a time and verified. An existing non-directory at a required path is a startup error.

### 8.3 Relative-path format

Durable relative paths:

- Use forward slashes.
- Are relative to Collection.
- Never begin with a slash or drive prefix.
- May not contain empty, <code>.</code>, or <code>..</code> segments.
- Are converted to native separators only after validation.

The main process resolves a candidate with <code>path.resolve</code>, calls <code>realpath.native</code> on the closest existing ancestor, and proves containment within an allowed root before use. Renderer requests never supply these paths.

### 8.4 Same-volume verification

At startup the main process compares the filesystem device identifier returned by BigInt <code>stat</code> for Collection, Inbox, Storage, Trash, and Working. A mutation that depends on rename semantics rechecks the source and destination parents immediately before acting.

If they are no longer on the same volume, the app enters read-only Recovery mode. It does not replace rename with copy-and-delete.

### 8.5 Derived photo paths

For photo ID 427:

~~~text
canonical filename: 0000000427.jpg
active photo:       Storage/0000000427.jpg
active thumbnail:   Thumbnails/ab/0000000427.jpg
trashed photo:      Trash/Photos/0000000427.jpg
trashed thumbnail:  Trash/Thumbnails/ab/0000000427.jpg
~~~

The canonical filename expression is <code>String(photoId).padStart(10, "0") + ".jpg"</code>. Ten digits is the minimum width; IDs remain unambiguous if the collection ever exceeds that width.

The shard is <code>(photo_id & 255).toString(16).padStart(2, "0")</code>. Paths are derived, not persisted in the <code>photos</code> row.

### 8.6 Temporary names

Every temporary or backup filename includes the operation UUID:

~~~text
Working/Import/{operation_id}.source-or-output.tmp
Working/Metadata/{photo_id}.{operation_id}.jpg.tmp
Working/Backups/{photo_id}.{operation_id}.jpg.bak
Working/Restore/{operation_id}/
~~~

Temporary names are never exposed through Library View. No operation reuses another operation's temporary name.

## 9. Electron security configuration

### 9.1 Browser window

The production BrowserWindow uses:

~~~text
nodeIntegration: false
nodeIntegrationInWorker: false
contextIsolation: true
sandbox: true
webSecurity: true
allowRunningInsecureContent: false
experimentalFeatures: false
webviewTag: false
devTools: false
spellcheck: false
~~~

The application denies all permission requests, prevents all unapproved navigation, denies window creation, and does not expose <code>shell.openExternal</code>. Folder-opening commands call <code>shell.openPath</code> only with main-process-derived approved directories.

### 9.2 Custom protocols

Before app readiness, two standard secure schemes are registered:

- <code>pt-app://</code> serves packaged renderer assets.
- <code>pt-photo://</code> serves an image or thumbnail identified by numeric photo ID and revision.

The photo protocol accepts only these URL forms:

~~~text
pt-photo://full/{photo_id}?content={content_revision}
pt-photo://thumb/{photo_id}?thumb={thumbnail_revision}
~~~

The handler:

1. Parses and bounds the decimal ID.
2. Obtains lifecycle and integrity eligibility from the catalog service.
3. Derives the path internally.
4. Confirms containment and expected filename.
5. Returns only JPEG bytes with <code>Content-Type: image/jpeg</code>, <code>Cache-Control: no-store</code>, and <code>X-Content-Type-Options: nosniff</code>.
6. Returns a generic placeholder for unavailable files without disclosing a local path.

Directory listings, arbitrary extensions, encoded separators, ranges outside the one file, and query-provided paths are rejected.

### 9.3 Content Security Policy

Production uses:

~~~text
default-src 'none';
script-src 'self';
style-src 'self';
img-src 'self' pt-photo: data:;
font-src 'self';
connect-src 'none';
media-src 'none';
object-src 'none';
frame-src 'none';
worker-src 'self';
base-uri 'none';
form-action 'none';
~~~

No inline script, <code>eval</code>, remote font, remote image, source-map URL, or analytics endpoint is permitted in the packaged renderer.

Development uses a separate CSP that permits only the localhost HTTP/WebSocket connections and the <code>'unsafe-eval'</code>/<code>'unsafe-inline'</code> behavior required by the Electron Forge Webpack development server. Those development-only allowances are selected through <code>app.isPackaged</code> and must not appear in packaged builds. Renderer CSS is extracted to a stylesheet in both modes; production retains the strict <code>style-src 'self'</code> policy above.

### 9.4 IPC sender validation

Every invoke handler verifies:

- The sender is the active main window.
- The sender frame is the top frame.
- The frame URL uses the packaged <code>pt-app</code> origin.
- The request name exists in the versioned contract.
- The payload passes its Zod schema.
- The requested operation is enabled in the current application mode.

The preload exposes frozen wrapper functions. It does not expose <code>ipcRenderer</code>, Electron objects, event objects, SQL, filesystem paths, child-process access, or a generic invoke method.

## 10. Catalog architecture

### 10.1 Database file and connection

The catalog path is <code>Collection/Data/catalog.sqlite</code>. The catalog utility process opens it with better-sqlite3, enables BigInt-safe integer return values, and configures:

~~~sql
PRAGMA application_id = 0x50544147;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA temp_store = MEMORY;
PRAGMA wal_autocheckpoint = 1000;
PRAGMA journal_size_limit = 67108864;
PRAGMA trusted_schema = OFF;
PRAGMA recursive_triggers = ON;
~~~

<code>0x50544147</code> represents <code>PTAG</code>. The initial <code>user_version</code> is 1. Page size remains SQLite's 4096-byte default. Auto-vacuum is disabled; normal operation does not perform automatic VACUUM because that would rewrite the catalog.

At startup the service verifies every effective pragma and queries <code>sqlite_version()</code>. A package whose SQLite version differs from the release manifest fails package verification.

### 10.2 Transaction rules

- Prepared statements are used for runtime values.
- SQL identifiers are never constructed from renderer input.
- Every mutation executes in an explicit immediate transaction.
- One transaction increments <code>app_state.catalog_revision</code> once, regardless of its row count.
- Filesystem mutation is never performed inside an open SQLite transaction.
- Intent is committed before filesystem mutation; observed completion is committed afterward.
- Long read results are paged or iterated and converted to DTOs in the catalog process.
- A transaction is retried only for a classified transient busy condition and never after an unknown commit outcome.

### 10.3 Schema migrations

Migration files are named with a strictly increasing three-digit version. Each is immutable after release. <code>schema_migrations</code> stores its SHA-256.

Migration procedure:

1. Reject a catalog with an application ID other than PTAG.
2. Reject a schema newer than the running application.
3. Create and verify the required pre-migration backup.
4. Apply each pending migration in its own immediate transaction.
5. Insert the migration record and update <code>user_version</code> in that same transaction.
6. Run <code>quick_check</code> and <code>foreign_key_check</code>.
7. Enter Recovery mode if any step fails.

Migration code never silently edits the checksum of an applied migration.

### 10.4 Startup order

Startup executes in this order:

1. Derive the packaged portable root from <code>process.execPath</code>.
2. Redirect Electron persistent paths beneath Collection.
3. Register privileged custom schemes.
4. Acquire Electron's single-instance lock for that portable user-data path.
5. Resolve, create, and validate the standard Collection directories.
6. Confirm the required directories are writable and on one filesystem device.
7. Write a session nonce and process information to <code>Data/collection.lock.json</code>.
8. Start the catalog utility process and open the existing database, or create a database only when no database, WAL, SHM, restore marker, or recovery candidate exists.
9. Validate application ID, schema version, migration checksums, and lightweight catalog invariants.
10. Perform any required candidate-based migration.
11. Set <code>clean_shutdown = 0</code> and commit the new session time.
12. Reconcile an incomplete restore marker and all open operation-journal rows.
13. Start the image and metadata services.
14. Resume eligible jobs and background maintenance.
15. Register IPC and create the BrowserWindow.
16. Return the bootstrap DTO and enable only operations permitted by the current recovery state.

The BrowserWindow may show a packaged loading surface while privileged startup is running, but mutating controls remain disabled until step 16.

A new catalog may be initialized only when <code>catalog.sqlite</code>, its WAL/SHM files, all restore markers, and every catalog recovery candidate are absent. Otherwise an open failure enters Recovery mode.

### 10.5 Candidate-based migration

For an existing catalog requiring migration:

1. Create and verify a pre-migration safety snapshot.
2. Use SQLite's online backup mechanism to create a Working migration candidate.
3. Apply all pending migrations to the candidate.
4. Run full integrity, foreign-key, schema, and application-invariant checks.
5. Activate it through the journaled catalog-restore swap.

The only live catalog is not migrated in place. A brand-new empty catalog is initialized directly because it has no prior state to preserve.

### 10.6 Clean shutdown

Shutdown:

1. Rejects new mutating commands.
2. Requests Stop After Current Item for long operations.
3. Allows a critical filesystem phase to reach a journaled recoverable boundary.
4. Flushes log buffers and closes ExifTool.
5. Runs <code>PRAGMA optimize</code>.
6. Attempts <code>PRAGMA wal_checkpoint(TRUNCATE)</code>; failure leaves a valid WAL in place and is logged.
7. Sets <code>clean_shutdown = 1</code> and records the shutdown time in the final transaction.
8. Closes SQLite and the catalog utility process.
9. Removes the session lock marker only after database closure.

The application does not wait for an entire metadata or import queue. Sudden Windows termination or drive removal may prevent these steps, so startup recovery remains authoritative.

## 11. SQLite schema

### 11.1 Schema conventions

- Durable primary keys use positive SQLite INTEGER values for photos/tags or lowercase UUID text for operations and batches.
- UUIDs are version 7 where runtime support is available; otherwise cryptographically random version 4 UUIDs are used. Code treats them as opaque.
- Booleans are INTEGER constrained to 0 or 1.
- Event timestamps are UTC ISO-8601 strings with millisecond precision.
- Filesystem mtimes are signed 64-bit nanoseconds and remain BigInt inside privileged processes.
- JSON columns contain canonical UTF-8 JSON and have <code>json_valid</code> checks.
- Hash columns contain exactly 32 raw bytes.
- Tables are STRICT.
- Durable lifecycle records are not physically deleted unless this schema explicitly allows it.

### 11.2 Initial DDL

Migration <code>001_initial.sql</code> is defined by the following schema. Formatting changes are permitted in the migration file, but its semantics must match this baseline.

~~~sql
PRAGMA foreign_keys = ON;

CREATE TABLE app_state (
  singleton                         INTEGER PRIMARY KEY CHECK (singleton = 1),
  catalog_uuid                     TEXT NOT NULL UNIQUE,
  catalog_revision                 INTEGER NOT NULL DEFAULT 0 CHECK (catalog_revision >= 0),
  clean_shutdown                   INTEGER NOT NULL DEFAULT 1 CHECK (clean_shutdown IN (0, 1)),
  last_app_version                 TEXT NOT NULL,
  last_started_at                  TEXT,
  last_clean_shutdown_at           TEXT,
  last_automatic_backup_local_date TEXT,
  last_backup_catalog_revision     INTEGER NOT NULL DEFAULT 0
                                      CHECK (last_backup_catalog_revision >= 0)
) STRICT;

CREATE TABLE schema_migrations (
  version       INTEGER PRIMARY KEY CHECK (version > 0),
  name          TEXT NOT NULL UNIQUE,
  sha256        BLOB NOT NULL CHECK (typeof(sha256) = 'blob' AND length(sha256) = 32),
  applied_at    TEXT NOT NULL,
  app_version   TEXT NOT NULL
) STRICT;

CREATE TABLE settings (
  key           TEXT PRIMARY KEY,
  value_json    TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at    TEXT NOT NULL
) STRICT;

CREATE TABLE import_batches (
  batch_id          TEXT PRIMARY KEY,
  snapshot_at       TEXT NOT NULL,
  requested_stop_at TEXT,
  state             TEXT NOT NULL CHECK (
                      state IN ('queued', 'running', 'stopping', 'completed', 'paused_error')
                    ),
  total_count       INTEGER NOT NULL CHECK (total_count >= 0),
  completed_count   INTEGER NOT NULL DEFAULT 0 CHECK (completed_count >= 0),
  failed_count      INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  waiting_count     INTEGER NOT NULL DEFAULT 0 CHECK (waiting_count >= 0),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  CHECK (completed_count + failed_count + waiting_count <= total_count)
) STRICT;

CREATE TABLE import_jobs (
  job_id                   TEXT PRIMARY KEY,
  batch_id                 TEXT NOT NULL REFERENCES import_batches(batch_id) ON DELETE RESTRICT,
  ordinal                  INTEGER NOT NULL CHECK (ordinal >= 0),
  original_filename        TEXT NOT NULL CHECK (length(original_filename) > 0),
  source_relative_path     TEXT NOT NULL,
  current_relative_path    TEXT NOT NULL,
  detected_format          TEXT CHECK (
                              detected_format IS NULL OR
                              detected_format IN ('jpeg', 'png', 'webp', 'gif', 'unsupported')
                            ),
  state                    TEXT NOT NULL CHECK (
                              state IN (
                                'queued', 'running', 'waiting', 'failed',
                                'completed', 'duplicate_completed', 'stopped'
                              )
                            ),
  phase                    TEXT NOT NULL CHECK (
                              phase IN (
                                'discovered', 'waiting_stable', 'validating', 'hashing',
                                'duplicate_check', 'id_reserved', 'moving', 'converting',
                                'stored_verification', 'thumbnail_generation',
                                'catalog_commit', 'source_cleanup', 'terminal'
                              )
                            ),
  source_size_bytes        INTEGER CHECK (source_size_bytes IS NULL OR source_size_bytes >= 0),
  source_mtime_ns          INTEGER,
  source_sha256            BLOB CHECK (
                              source_sha256 IS NULL OR
                              (typeof(source_sha256) = 'blob' AND length(source_sha256) = 32)
                            ),
  candidate_width          INTEGER CHECK (candidate_width IS NULL OR candidate_width > 0),
  candidate_height         INTEGER CHECK (candidate_height IS NULL OR candidate_height > 0),
  candidate_orientation    INTEGER CHECK (
                              candidate_orientation IS NULL OR
                              candidate_orientation BETWEEN 1 AND 8
                            ),
  possible_duplicate_id    INTEGER REFERENCES photos(photo_id) ON DELETE SET NULL,
  staged_metadata_json     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(staged_metadata_json)),
  retry_count              INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  error_class              TEXT,
  error_code               TEXT,
  error_detail_json        TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(error_detail_json)),
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL,
  completed_at             TEXT,
  UNIQUE (batch_id, ordinal),
  UNIQUE (batch_id, source_relative_path)
) STRICT;

CREATE TABLE id_reservations (
  photo_id       INTEGER PRIMARY KEY AUTOINCREMENT
                   CHECK (photo_id > 0 AND photo_id <= 9007199254740991),
  import_job_id  TEXT UNIQUE REFERENCES import_jobs(job_id) ON DELETE RESTRICT,
  origin         TEXT NOT NULL CHECK (origin IN ('import', 'rebuild', 'legacy')),
  state          TEXT NOT NULL CHECK (state IN ('reserved', 'committed', 'abandoned')),
  reserved_at    TEXT NOT NULL,
  committed_at   TEXT,
  abandoned_at   TEXT,
  CHECK (
    (state = 'reserved'  AND committed_at IS NULL AND abandoned_at IS NULL) OR
    (state = 'committed' AND committed_at IS NOT NULL AND abandoned_at IS NULL) OR
    (state = 'abandoned' AND committed_at IS NULL AND abandoned_at IS NOT NULL)
  )
) STRICT;

CREATE TABLE photos (
  photo_id                       INTEGER PRIMARY KEY
                                   REFERENCES id_reservations(photo_id) ON DELETE RESTRICT,
  original_filename              TEXT NOT NULL CHECK (length(original_filename) > 0),
  source_format                  TEXT CHECK (
                                   source_format IS NULL OR
                                   source_format IN ('jpeg', 'png', 'webp')
                                 ),
  lifecycle_state                TEXT NOT NULL CHECK (
                                   lifecycle_state IN ('active', 'trashed', 'purged')
                                 ),
  integrity_state                TEXT CHECK (
                                   integrity_state IS NULL OR integrity_state IN (
                                     'clean', 'missing', 'unreadable', 'metadata_conflict',
                                     'content_conflict', 'recovery_required'
                                   )
                                 ),
  flagged                        INTEGER DEFAULT 0 CHECK (flagged IS NULL OR flagged IN (0, 1)),
  row_revision                   INTEGER NOT NULL DEFAULT 1 CHECK (row_revision >= 1),
  width                          INTEGER CHECK (width IS NULL OR width > 0),
  height                         INTEGER CHECK (height IS NULL OR height > 0),
  display_orientation            INTEGER CHECK (
                                   display_orientation IS NULL OR
                                   display_orientation BETWEEN 1 AND 8
                                 ),
  source_sha256                  BLOB NOT NULL
                                   CHECK (typeof(source_sha256) = 'blob' AND length(source_sha256) = 32),
  current_file_sha256            BLOB
                                   CHECK (
                                     current_file_sha256 IS NULL OR
                                     (typeof(current_file_sha256) = 'blob' AND
                                      length(current_file_sha256) = 32)
                                   ),
  image_data_sha256              BLOB NOT NULL
                                   CHECK (
                                     typeof(image_data_sha256) = 'blob' AND
                                     length(image_data_sha256) = 32
                                   ),
  observed_size_bytes            INTEGER CHECK (
                                   observed_size_bytes IS NULL OR observed_size_bytes >= 0
                                 ),
  observed_mtime_ns              INTEGER,
  content_revision               INTEGER DEFAULT 1
                                   CHECK (content_revision IS NULL OR content_revision >= 1),
  desired_metadata_revision      INTEGER DEFAULT 0
                                   CHECK (
                                     desired_metadata_revision IS NULL OR
                                     desired_metadata_revision >= 0
                                   ),
  synced_metadata_revision       INTEGER DEFAULT 0
                                   CHECK (
                                     synced_metadata_revision IS NULL OR
                                     (synced_metadata_revision >= 0 AND
                                      synced_metadata_revision <= desired_metadata_revision)
                                   ),
  metadata_warning_code          TEXT,
  embedded_thumbnail_status      TEXT CHECK (
                                   embedded_thumbnail_status IS NULL OR
                                   embedded_thumbnail_status IN (
                                     'not_attempted', 'pending', 'written',
                                     'skipped_capacity', 'failed_warning'
                                   )
                                 ),
  thumbnail_state                TEXT CHECK (
                                   thumbnail_state IS NULL OR
                                   thumbnail_state IN ('ready', 'pending', 'missing', 'failed')
                                 ),
  thumbnail_revision             INTEGER DEFAULT 1
                                   CHECK (
                                     thumbnail_revision IS NULL OR thumbnail_revision >= 1
                                   ),
  imported_at                    TEXT NOT NULL,
  trashed_at                     TEXT,
  purged_at                      TEXT,
  purge_batch_id                 TEXT REFERENCES trash_batches(trash_batch_id) ON DELETE RESTRICT,
  last_verified_at               TEXT,
  updated_at                     TEXT NOT NULL,
  CHECK (
    (lifecycle_state = 'active'  AND trashed_at IS NULL AND purged_at IS NULL) OR
    (lifecycle_state = 'trashed' AND trashed_at IS NOT NULL AND purged_at IS NULL) OR
    (lifecycle_state = 'purged'  AND trashed_at IS NOT NULL AND purged_at IS NOT NULL)
  ),
  CHECK (
    (
      lifecycle_state IN ('active', 'trashed') AND
      source_format IS NOT NULL AND integrity_state IS NOT NULL AND flagged IS NOT NULL AND
      width IS NOT NULL AND height IS NOT NULL AND display_orientation IS NOT NULL AND
      current_file_sha256 IS NOT NULL AND content_revision IS NOT NULL AND
      desired_metadata_revision IS NOT NULL AND synced_metadata_revision IS NOT NULL AND
      embedded_thumbnail_status IS NOT NULL AND thumbnail_state IS NOT NULL AND
      thumbnail_revision IS NOT NULL AND purge_batch_id IS NULL
    ) OR (
      lifecycle_state = 'purged' AND
      source_format IS NULL AND integrity_state IS NULL AND flagged IS NULL AND
      width IS NULL AND height IS NULL AND display_orientation IS NULL AND
      current_file_sha256 IS NULL AND observed_size_bytes IS NULL AND
      observed_mtime_ns IS NULL AND content_revision IS NULL AND
      desired_metadata_revision IS NULL AND synced_metadata_revision IS NULL AND
      metadata_warning_code IS NULL AND embedded_thumbnail_status IS NULL AND
      thumbnail_state IS NULL AND thumbnail_revision IS NULL AND
      last_verified_at IS NULL AND purge_batch_id IS NOT NULL
    )
  )
) STRICT;

CREATE TABLE tags (
  tag_id          INTEGER PRIMARY KEY AUTOINCREMENT
                    CHECK (tag_id > 0 AND tag_id <= 9007199254740991),
  parent_tag_id   INTEGER REFERENCES tags(tag_id) ON DELETE RESTRICT,
  display_name    TEXT NOT NULL CHECK (length(display_name) > 0),
  normalized_key  TEXT NOT NULL CHECK (length(normalized_key) > 0),
  legacy_flat_only INTEGER NOT NULL DEFAULT 0 CHECK (legacy_flat_only IN (0, 1)),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  CHECK (parent_tag_id IS NULL OR parent_tag_id <> tag_id),
  CHECK (legacy_flat_only = 0 OR parent_tag_id IS NULL)
) STRICT;

CREATE TABLE tag_closure (
  ancestor_tag_id    INTEGER NOT NULL REFERENCES tags(tag_id) ON DELETE CASCADE,
  descendant_tag_id  INTEGER NOT NULL REFERENCES tags(tag_id) ON DELETE CASCADE,
  depth              INTEGER NOT NULL CHECK (depth BETWEEN 0 AND 11),
  PRIMARY KEY (ancestor_tag_id, descendant_tag_id),
  CHECK (
    (ancestor_tag_id = descendant_tag_id AND depth = 0) OR
    (ancestor_tag_id <> descendant_tag_id AND depth > 0)
  )
) STRICT, WITHOUT ROWID;

CREATE TABLE tag_paths (
  tag_id         INTEGER PRIMARY KEY REFERENCES tags(tag_id) ON DELETE CASCADE,
  path_display   TEXT NOT NULL,
  path_key       TEXT NOT NULL UNIQUE,
  leaf_key       TEXT NOT NULL,
  depth          INTEGER NOT NULL CHECK (depth BETWEEN 1 AND 12),
  updated_at     TEXT NOT NULL
) STRICT;

CREATE TABLE tag_aliases (
  alias_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  tag_id         INTEGER NOT NULL REFERENCES tags(tag_id) ON DELETE CASCADE,
  path_display   TEXT NOT NULL,
  path_key       TEXT NOT NULL UNIQUE,
  created_at     TEXT NOT NULL
) STRICT;

CREATE TABLE photo_tags (
  photo_id       INTEGER NOT NULL REFERENCES photos(photo_id) ON DELETE CASCADE,
  tag_id         INTEGER NOT NULL REFERENCES tags(tag_id) ON DELETE RESTRICT,
  assigned_at    TEXT NOT NULL,
  PRIMARY KEY (photo_id, tag_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE palette_entries (
  tag_id         INTEGER PRIMARY KEY REFERENCES tags(tag_id) ON DELETE CASCADE,
  position       INTEGER NOT NULL UNIQUE CHECK (position >= 0),
  pinned_at      TEXT NOT NULL
) STRICT;

CREATE TABLE metadata_jobs (
  photo_id             INTEGER PRIMARY KEY REFERENCES photos(photo_id) ON DELETE CASCADE,
  requested_revision   INTEGER NOT NULL CHECK (requested_revision >= 0),
  writing_revision     INTEGER CHECK (writing_revision IS NULL OR writing_revision >= 0),
  state                TEXT NOT NULL CHECK (
                         state IN (
                           'pending', 'debouncing', 'writing', 'failed',
                           'suspended', 'completed_warning'
                         )
                       ),
  not_before           TEXT NOT NULL,
  attempt_count        INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_id             TEXT,
  last_error_class     TEXT,
  last_error_code      TEXT,
  last_error_at        TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
) STRICT;

CREATE TABLE backup_records (
  backup_id                    TEXT PRIMARY KEY,
  kind                         TEXT NOT NULL CHECK (
                                 kind IN ('automatic', 'safety', 'manual', 'emergency')
                               ),
  state                        TEXT NOT NULL CHECK (
                                 state IN ('creating', 'verified', 'copy_pending', 'complete', 'failed', 'pruned')
                               ),
  catalog_revision             INTEGER NOT NULL CHECK (catalog_revision >= 0),
  schema_version               INTEGER NOT NULL CHECK (schema_version > 0),
  relative_path                TEXT NOT NULL,
  manifest_relative_path       TEXT NOT NULL,
  sqlite_sha256                BLOB CHECK (
                                 sqlite_sha256 IS NULL OR
                                 (typeof(sqlite_sha256) = 'blob' AND length(sqlite_sha256) = 32)
                               ),
  primary_verified_at          TEXT,
  secondary_destination_token  TEXT,
  secondary_copied_at          TEXT,
  created_at                   TEXT NOT NULL,
  updated_at                   TEXT NOT NULL,
  error_code                   TEXT
) STRICT;

CREATE TABLE operation_journal (
  operation_id          TEXT PRIMARY KEY,
  operation_type        TEXT NOT NULL CHECK (
                          operation_type IN (
                            'import_move', 'import_convert_promote', 'duplicate_delete',
                            'failed_move', 'failed_delete', 'metadata_replace',
                            'thumbnail_replace', 'trash_move', 'trash_restore',
                            'trash_purge', 'orphan_recovery_move', 'external_rename_repair',
                            'backup_create', 'backup_copy', 'backup_prune',
                            'recovery_bundle_export', 'catalog_restore'
                          )
                        ),
  status                TEXT NOT NULL CHECK (
                          status IN (
                            'planned', 'mutating', 'verifying', 'cleanup',
                            'completed', 'failed', 'recovery_required'
                          )
                        ),
  phase                 TEXT NOT NULL,
  photo_id              INTEGER REFERENCES id_reservations(photo_id) ON DELETE RESTRICT,
  import_job_id         TEXT REFERENCES import_jobs(job_id) ON DELETE RESTRICT,
  batch_id              TEXT,
  source_relative_path  TEXT,
  target_relative_path  TEXT,
  temporary_relative_path TEXT,
  backup_relative_path  TEXT,
  expected_source_sha256 BLOB CHECK (
                           expected_source_sha256 IS NULL OR
                           (typeof(expected_source_sha256) = 'blob' AND
                            length(expected_source_sha256) = 32)
                         ),
  expected_target_sha256 BLOB CHECK (
                           expected_target_sha256 IS NULL OR
                           (typeof(expected_target_sha256) = 'blob' AND
                            length(expected_target_sha256) = 32)
                         ),
  payload_json          TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  user_authorized_at    TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  completed_at          TEXT,
  error_class           TEXT,
  error_code            TEXT
) STRICT;

CREATE TABLE trash_batches (
  trash_batch_id        TEXT PRIMARY KEY,
  action                TEXT NOT NULL CHECK (action IN ('trash', 'restore', 'purge')),
  state                 TEXT NOT NULL CHECK (
                          state IN ('planned', 'running', 'stopping', 'completed', 'partial', 'failed')
                        ),
  requested_count       INTEGER NOT NULL CHECK (requested_count > 0),
  known_size_bytes      INTEGER NOT NULL CHECK (known_size_bytes >= 0),
  safety_backup_id      TEXT REFERENCES backup_records(backup_id) ON DELETE RESTRICT,
  manifest_relative_path TEXT,
  user_authorized_at    TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  completed_at          TEXT,
  CHECK (
    action <> 'purge' OR
    (safety_backup_id IS NOT NULL AND manifest_relative_path IS NOT NULL)
  )
) STRICT;

CREATE TABLE trash_batch_items (
  trash_batch_id   TEXT NOT NULL REFERENCES trash_batches(trash_batch_id) ON DELETE RESTRICT,
  photo_id         INTEGER NOT NULL REFERENCES photos(photo_id) ON DELETE RESTRICT,
  state            TEXT NOT NULL CHECK (
                     state IN ('pending', 'running', 'completed', 'failed', 'skipped')
                   ),
  error_code       TEXT,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (trash_batch_id, photo_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE external_change_events (
  event_id                  TEXT PRIMARY KEY,
  photo_id                  INTEGER REFERENCES photos(photo_id) ON DELETE RESTRICT,
  event_type                TEXT NOT NULL CHECK (
                              event_type IN (
                                'mtime_only', 'uncontrolled_metadata', 'metadata_conflict',
                                'content_conflict', 'unreadable', 'missing',
                                'renamed_candidate', 'storage_orphan', 'ambiguous_copy'
                              )
                            ),
  state                     TEXT NOT NULL CHECK (state IN ('open', 'resolved', 'superseded')),
  observed_size_bytes       INTEGER CHECK (
                              observed_size_bytes IS NULL OR observed_size_bytes >= 0
                            ),
  observed_mtime_ns         INTEGER,
  observed_file_sha256      BLOB CHECK (
                              observed_file_sha256 IS NULL OR
                              (typeof(observed_file_sha256) = 'blob' AND
                               length(observed_file_sha256) = 32)
                            ),
  observed_image_sha256     BLOB CHECK (
                              observed_image_sha256 IS NULL OR
                              (typeof(observed_image_sha256) = 'blob' AND
                               length(observed_image_sha256) = 32)
                            ),
  file_tag_snapshot_json    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(file_tag_snapshot_json)),
  detected_at               TEXT NOT NULL,
  resolved_at               TEXT,
  resolution                TEXT CHECK (
                              resolution IS NULL OR
                              resolution IN (
                                'accepted_observation', 'keep_catalog_tags', 'use_file_tags',
                                'accept_changed_image', 'restored_from_backup',
                                'renamed_repaired', 'moved_to_recovery'
                              )
                            ),
  resolution_detail_json    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(resolution_detail_json))
) STRICT;

CREATE TABLE content_revisions (
  photo_id             INTEGER NOT NULL REFERENCES photos(photo_id) ON DELETE RESTRICT,
  revision             INTEGER NOT NULL CHECK (revision >= 1),
  file_sha256          BLOB NOT NULL
                         CHECK (typeof(file_sha256) = 'blob' AND length(file_sha256) = 32),
  image_data_sha256    BLOB NOT NULL
                         CHECK (typeof(image_data_sha256) = 'blob' AND length(image_data_sha256) = 32),
  width                INTEGER NOT NULL CHECK (width > 0),
  height               INTEGER NOT NULL CHECK (height > 0),
  accepted_at          TEXT NOT NULL,
  source_event_id      TEXT REFERENCES external_change_events(event_id) ON DELETE SET NULL,
  PRIMARY KEY (photo_id, revision)
) STRICT, WITHOUT ROWID;

CREATE TABLE maintenance_jobs (
  maintenance_job_id  TEXT PRIMARY KEY,
  job_type            TEXT NOT NULL CHECK (
                        job_type IN (
                          'verify_library', 'scan_external_changes',
                          'regenerate_missing_thumbnails', 'rebuild_all_thumbnails',
                          'export_recovery_bundle', 'rebuild_catalog'
                        )
                      ),
  state               TEXT NOT NULL CHECK (
                        state IN ('queued', 'running', 'stopping', 'completed', 'failed')
                      ),
  completed_count     INTEGER NOT NULL DEFAULT 0 CHECK (completed_count >= 0),
  total_count         INTEGER CHECK (total_count IS NULL OR total_count >= 0),
  cursor_json         TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(cursor_json)),
  error_code          TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  completed_at        TEXT
) STRICT;

CREATE TABLE audit_events (
  audit_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at      TEXT NOT NULL,
  severity         TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
  event_type       TEXT NOT NULL,
  operation_id     TEXT,
  photo_id         INTEGER,
  detail_json      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json))
) STRICT;

CREATE UNIQUE INDEX ux_tags_sibling_normalized
  ON tags(COALESCE(parent_tag_id, 0), normalized_key);

CREATE INDEX ix_photos_active_order
  ON photos(lifecycle_state, photo_id DESC);

CREATE INDEX ix_photos_active_flagged_order
  ON photos(lifecycle_state, flagged, photo_id DESC);

CREATE INDEX ix_photos_integrity
  ON photos(integrity_state, lifecycle_state, photo_id);

CREATE INDEX ix_photos_source_hash
  ON photos(source_sha256);

CREATE INDEX ix_photos_current_hash
  ON photos(current_file_sha256);

CREATE INDEX ix_photos_image_hash
  ON photos(image_data_sha256);

CREATE INDEX ix_photo_tags_tag_photo
  ON photo_tags(tag_id, photo_id);

CREATE INDEX ix_tag_closure_descendant
  ON tag_closure(descendant_tag_id, ancestor_tag_id);

CREATE INDEX ix_tag_paths_leaf
  ON tag_paths(leaf_key, path_key, tag_id);

CREATE INDEX ix_import_jobs_work
  ON import_jobs(state, phase, batch_id, ordinal);

CREATE INDEX ix_metadata_jobs_work
  ON metadata_jobs(state, not_before, updated_at, photo_id);

CREATE INDEX ix_operation_journal_open
  ON operation_journal(status, created_at)
  WHERE status <> 'completed';

CREATE INDEX ix_external_events_open
  ON external_change_events(state, event_type, detected_at, photo_id);

CREATE UNIQUE INDEX ux_external_events_one_open
  ON external_change_events(photo_id, event_type)
  WHERE state = 'open' AND photo_id IS NOT NULL;

CREATE INDEX ix_backup_records_retention
  ON backup_records(kind, state, created_at DESC);

CREATE INDEX ix_trash_items_state
  ON trash_batch_items(state, trash_batch_id, photo_id);

CREATE INDEX ix_audit_events_time
  ON audit_events(occurred_at DESC, audit_id DESC);

CREATE TRIGGER trg_no_delete_id_reservation
BEFORE DELETE ON id_reservations
BEGIN
  SELECT RAISE(ABORT, 'photo ID reservations are immutable');
END;

CREATE TRIGGER trg_no_delete_photo
BEFORE DELETE ON photos
BEGIN
  SELECT RAISE(ABORT, 'photos become tombstones and are not deleted');
END;

CREATE TRIGGER trg_photo_identity_immutable
BEFORE UPDATE OF photo_id, original_filename, source_sha256, imported_at
ON photos
WHEN
  NEW.photo_id IS NOT OLD.photo_id OR
  NEW.original_filename IS NOT OLD.original_filename OR
  NEW.source_sha256 IS NOT OLD.source_sha256 OR
  NEW.imported_at IS NOT OLD.imported_at
BEGIN
  SELECT RAISE(ABORT, 'immutable photo identity field');
END;

CREATE TRIGGER trg_photo_source_format_immutable
BEFORE UPDATE OF source_format ON photos
WHEN NEW.source_format IS NOT OLD.source_format
 AND NOT (
   OLD.lifecycle_state IN ('active', 'trashed') AND
   NEW.lifecycle_state = 'purged' AND
   NEW.source_format IS NULL
 )
BEGIN
  SELECT RAISE(ABORT, 'immutable photo source format');
END;

CREATE TRIGGER trg_photo_no_unpurge
BEFORE UPDATE OF lifecycle_state ON photos
WHEN OLD.lifecycle_state = 'purged' AND NEW.lifecycle_state <> 'purged'
BEGIN
  SELECT RAISE(ABORT, 'purged photo cannot return to a live lifecycle');
END;

CREATE TRIGGER trg_photo_tag_not_purged
BEFORE INSERT ON photo_tags
WHEN (SELECT lifecycle_state FROM photos WHERE photo_id = NEW.photo_id) = 'purged'
BEGIN
  SELECT RAISE(ABORT, 'cannot tag a purged photo');
END;

CREATE TRIGGER trg_tag_insert_depth
BEFORE INSERT ON tags
WHEN NEW.parent_tag_id IS NOT NULL
BEGIN
  SELECT CASE
    WHEN (
      SELECT COUNT(*)
      FROM tag_closure
      WHERE descendant_tag_id = NEW.parent_tag_id
    ) + 1 > 12
    THEN RAISE(ABORT, 'tag hierarchy exceeds 12 levels')
  END;
END;

CREATE TRIGGER trg_tag_update_no_cycle
BEFORE UPDATE OF parent_tag_id ON tags
WHEN NEW.parent_tag_id IS NOT NULL
BEGIN
  SELECT CASE
    WHEN NEW.parent_tag_id = OLD.tag_id OR EXISTS (
      SELECT 1
      FROM tag_closure
      WHERE ancestor_tag_id = OLD.tag_id
        AND descendant_tag_id = NEW.parent_tag_id
    )
    THEN RAISE(ABORT, 'tag hierarchy cycle')
  END;
END;

CREATE TRIGGER trg_tag_update_depth
BEFORE UPDATE OF parent_tag_id ON tags
BEGIN
  SELECT CASE
    WHEN
      COALESCE((
        SELECT COUNT(*)
        FROM tag_closure
        WHERE descendant_tag_id = NEW.parent_tag_id
      ), 0)
      + 1
      + COALESCE((
        SELECT MAX(depth)
        FROM tag_closure
        WHERE ancestor_tag_id = OLD.tag_id
      ), 0)
      > 12
    THEN RAISE(ABORT, 'tag hierarchy exceeds 12 levels')
  END;
END;

CREATE TRIGGER trg_legacy_tag_cannot_gain_parent
BEFORE UPDATE OF parent_tag_id ON tags
WHEN OLD.legacy_flat_only = 1 AND NEW.parent_tag_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'legacy flat-only tag cannot have a parent');
END;

CREATE TRIGGER trg_tag_cannot_become_legacy_with_children
BEFORE UPDATE OF legacy_flat_only ON tags
WHEN NEW.legacy_flat_only = 1
 AND EXISTS (SELECT 1 FROM tags WHERE parent_tag_id = OLD.tag_id)
BEGIN
  SELECT RAISE(ABORT, 'tag with children cannot become legacy flat-only');
END;

CREATE TRIGGER trg_tag_cannot_use_legacy_parent_insert
BEFORE INSERT ON tags
WHEN NEW.parent_tag_id IS NOT NULL
 AND (SELECT legacy_flat_only FROM tags WHERE tag_id = NEW.parent_tag_id) = 1
BEGIN
  SELECT RAISE(ABORT, 'legacy flat-only tag cannot be a parent');
END;

CREATE TRIGGER trg_tag_cannot_use_legacy_parent_update
BEFORE UPDATE OF parent_tag_id ON tags
WHEN NEW.parent_tag_id IS NOT NULL
 AND (SELECT legacy_flat_only FROM tags WHERE tag_id = NEW.parent_tag_id) = 1
BEGIN
  SELECT RAISE(ABORT, 'legacy flat-only tag cannot be a parent');
END;

PRAGMA user_version = 1;
~~~

### 11.3 Temporary session tables

The catalog process creates these in SQLite's in-memory TEMP database at each start:

~~~sql
CREATE TEMP TABLE selection_sessions (
  selection_id       TEXT PRIMARY KEY,
  query_fingerprint  TEXT NOT NULL,
  catalog_revision   INTEGER NOT NULL,
  created_at         TEXT NOT NULL
) STRICT;

CREATE TEMP TABLE selection_members (
  selection_id  TEXT NOT NULL REFERENCES selection_sessions(selection_id) ON DELETE CASCADE,
  photo_id      INTEGER NOT NULL,
  selected      INTEGER NOT NULL CHECK (selected IN (0, 1)),
  PRIMARY KEY (selection_id, photo_id)
) STRICT, WITHOUT ROWID;

CREATE TEMP TABLE view_sessions (
  view_session_id    TEXT PRIMARY KEY,
  query_fingerprint TEXT NOT NULL,
  catalog_revision  INTEGER NOT NULL,
  created_at        TEXT NOT NULL
) STRICT;

CREATE TEMP TABLE view_members (
  view_session_id  TEXT NOT NULL REFERENCES view_sessions(view_session_id) ON DELETE CASCADE,
  position         INTEGER NOT NULL CHECK (position >= 0),
  photo_id         INTEGER NOT NULL,
  PRIMARY KEY (view_session_id, position),
  UNIQUE (view_session_id, photo_id)
) STRICT, WITHOUT ROWID;
~~~

Selections and view sessions intentionally do not survive application restart. Staged batch edits are renderer state until Apply. The renderer holds opaque session IDs, never the complete set for a Select All operation.

### 11.4 Catalog invariants outside DDL

The catalog repository enforces and tests these transactional invariants:

- Every tag has exactly one self-row in <code>tag_closure</code>.
- Every ancestor/descendant pair has exactly one closure row with correct depth.
- Every tag has exactly one current <code>tag_paths</code> row.
- User-created hierarchy names are NFC-normalized and no segment exceeds 64 UTF-8 bytes.
- A legacy flat-only tag is a root, has no children, and never appears in hierarchical XMP.
- No current <code>tag_paths.path_key</code> collides with a <code>tag_aliases.path_key</code>.
- A photo's metadata job requested revision equals its newest unsynchronized desired revision.
- A committed ID reservation has one corresponding photo.
- An abandoned ID reservation has no photo.
- Purge removes photo-tag assignments, metadata jobs, content-revision detail, flags, dimensions, live observations, and thumbnail state while retaining only the approved photo tombstone fields and purge-batch identity.
- Only one open external conflict exists for a given photo and conflict class.
- Every mutation of photo, thumbnail, backup, or recovery artifacts that crosses catalog and filesystem state has an operation-journal record committed before mutation. Ephemeral logs, the session lock marker, and the external restore marker use their explicitly defined protocols instead.

Startup runs lightweight invariant queries. Full Verify Library includes an exhaustive closure/path rebuild comparison.

### 11.5 Initial rows and settings

The new-catalog transaction inserts one <code>app_state</code> row with a generated catalog UUID, one migration record, and these validated settings:

| Key | JSON value | Validation |
| --- | --- | --- |
| <code>conversion.jpegQuality</code> | <code>92</code> | Integer 1–100 |
| <code>conversion.alphaBackground</code> | <code>"#ffffff"</code> | Opaque six-digit RGB |
| <code>library.defaultOrder</code> | <code>"newest-imported"</code> | Approved order enum |
| <code>batch.warningThreshold</code> | <code>500</code> | Integer 1–100000 |
| <code>backup.secondaryDestination</code> | <code>null</code> | Null or native-picker result object |

Unknown setting keys are ignored on read and cannot be written through IPC. Invalid known values cause the default to be used in read-only startup state and create a maintenance warning; they are not silently overwritten until the user saves valid settings.

### 11.6 Revision semantics

- <code>catalog_revision</code> increments once for every committed logical mutation transaction.
- <code>photos.row_revision</code> increments whenever a renderer-visible property of that photo changes.
- <code>desired_metadata_revision</code> increments once per transaction that changes the desired file projection for that photo.
- <code>synced_metadata_revision</code> identifies exactly what revision was verified in the canonical JPEG.
- <code>content_revision</code> increments only when changed image data is explicitly accepted.
- <code>thumbnail_revision</code> increments whenever the external thumbnail bytes are replaced.

Expected-row and plan-hash checks reject stale mutations before any filesystem intent is journaled.

## 12. Tag normalization and hierarchy maintenance

### 12.1 Display normalization

For each user-entered hierarchy segment:

1. Remove leading and trailing Unicode whitespace.
2. Normalize the display string to Unicode NFC.
3. Reject empty output.
4. Reject <code>/</code>, <code>|</code>, semicolon, U+0000 through U+001F, and U+007F.
5. Encode as UTF-8 and reject more than 64 bytes.

The deterministic sibling key is:

~~~text
NFC(displayName).toLocaleLowerCase("en-US").normalize("NFC")
~~~

No accent stripping, punctuation folding, or transliteration occurs. Thus visually similar but canonically different names remain distinct unless NFC and lowercase make them equal. The selected algorithm is covered by fixed Unicode fixtures so an Electron/ICU upgrade cannot silently alter stored keys; an upgrade that changes a fixture requires a migration.

### 12.2 Legacy flat-keyword exception

Existing XMP, IPTC, or XP flat keywords may contain a slash, semicolon, control character, or more than 64 UTF-8 bytes even though PhotoTagger must not allow users to create such hierarchy segments. An unmatched existing value that fails segment validation becomes a <code>legacy_flat_only</code> root record:

- Its original display value is retained exactly after NFC normalization.
- It may be assigned, filtered, removed, or renamed.
- It cannot become a parent or child and cannot receive children.
- It is exported only to flat keyword fields that can represent it without mutation, never HierarchicalSubject.
- The UI labels it as a legacy flat keyword and does not parse its slash as hierarchy.
- Renaming it to a valid segment converts it into a normal root tag.

Its internal path key is prefixed with <code>legacy-flat:</code> followed by its normalized key, preventing ambiguity with true hierarchy paths. User path entry never creates this exception.

Before projection, each legacy value is checked against the destination field's encoding and delimiter rules. PhotoTagger never splits, truncates, escapes into a different meaning, or silently renames an imported legacy value. A value that cannot round-trip through one compatibility field is omitted from that field only, remains authoritative in SQLite and every safely representable field, and produces a field-specific metadata warning. All tags created or renamed through PhotoTagger's normal validator are representable in every selected version-one field.

### 12.3 Path keys

For normal tags, <code>tag_paths.path_display</code> joins NFC display segments with <code>/</code>, while <code>path_key</code> joins normalized sibling keys. For a legacy flat-only root, path display remains the original flat value and path key uses the reserved legacy prefix. The UI receives <code>legacyFlatOnly</code> and can distinguish it without reparsing display text.

### 12.4 Closure maintenance

Create, rename, move, merge, and delete use one catalog transaction:

1. Validate the proposed final tree entirely.
2. Apply tag rows.
3. Rebuild closure rows for the affected subtree.
4. Rebuild path rows for the affected subtree.
5. Apply aliases and palette changes.
6. Determine distinct affected photos.
7. Increment each affected photo's desired metadata revision once.
8. Upsert one metadata job per eligible photo.
9. Increment catalog revision once.
10. Run affected-subtree invariants before commit.

For merge, the preview is produced from the same deterministic planning function later used by the mutation. The confirmed request includes a plan hash; the catalog rejects Apply if the current tree produces a different hash.

### 12.5 Suggestions

Autocomplete normalizes the query and performs bounded prefix searches against <code>leaf_key</code> and <code>path_key</code>. It returns at most 50 suggestions ordered by:

1. Exact leaf-key match.
2. Leaf prefix match.
3. Full-path prefix match.
4. Palette membership.
5. Path key.
6. Tag ID.

No fuzzy library or network service is used.

## 13. Library queries, paging, and frozen selections

### 13.1 Query model

A Library query contains:

~~~typescript
type LibraryQuery = {
  tagIds: number[];
  flaggedOnly: boolean;
  order:
    | "newest-imported"
    | "oldest-imported"
    | "original-filename-asc"
    | "original-filename-desc";
};
~~~

Tag IDs are deduplicated and sorted before validation. The catalog serializes the normalized query as canonical JSON and calculates a SHA-256 query fingerprint. Cursors bind to that fingerprint and cannot be reused with a different query.

### 13.2 Hierarchical AND filtering

The tag-closure table turns each selected parent into all qualifying descendants. A simplified newest-first query is:

~~~sql
WITH matching AS (
  SELECT pt.photo_id
  FROM photo_tags AS pt
  JOIN tag_closure AS tc
    ON tc.descendant_tag_id = pt.tag_id
  WHERE tc.ancestor_tag_id IN (
    SELECT value FROM json_each(:filter_tag_ids_json)
  )
  GROUP BY pt.photo_id
  HAVING COUNT(DISTINCT tc.ancestor_tag_id) = :filter_count
)
SELECT
  p.photo_id,
  p.original_filename,
  p.flagged,
  p.integrity_state,
  p.content_revision,
  p.thumbnail_revision,
  p.width,
  p.height
FROM photos AS p
JOIN matching AS m ON m.photo_id = p.photo_id
WHERE p.lifecycle_state = 'active'
  AND (:flagged_only = 0 OR p.flagged = 1)
  AND p.photo_id < :after_photo_id
ORDER BY p.photo_id DESC
LIMIT :page_size;
~~~

With no tag filters, the matching CTE is omitted. Count and first-page queries run in one catalog request and one read transaction so their results share a snapshot.

### 13.3 Keyset paging

- Default page size is 200 photos.
- The renderer may prefetch two pages beyond the visible region.
- Cursors contain query fingerprint, order mode, final sort value, and photo ID.
- Cursors are opaque base64url-encoded canonical JSON validated by the catalog.
- Photo ID is the final deterministic tie-breaker for every order.
- Offset paging is not used for the main Library.

Original-filename ordering uses the stored NFC filename plus photo ID. It does not attempt locale-dependent reordering after a runtime upgrade.

### 13.4 Selection snapshot

Select All performs <code>INSERT ... SELECT</code> into TEMP <code>selection_members</code> in a read transaction. Individual selection changes insert, delete, or update exact member rows. This intentionally materializes IDs in SQLite memory, not in renderer DOM or JavaScript state.

A selection token therefore freezes exact membership even when:

- New photos import.
- Tags change.
- Flag state changes.
- A selected photo ceases to match the filter.

Before a mutation, the catalog rechecks each selected member's current eligibility. Ineligible IDs are reported as skipped; no newly matching ID is added.

Selection sessions expire when cleared, when the application exits, or after 30 idle minutes with no staged changes. Filter changes with staged edits invoke the required Apply/Discard/Cancel dialog before the old selection is destroyed.

### 13.5 Image View session

Opening Image View creates TEMP <code>view_members</code> from the complete ordered Library query and records the selected ID's position. Navigation uses integer position, not a rerun of the current filters.

Trashing or purging the current member removes it and chooses the nearest remaining position. Missing or unreadable members remain represented by a placeholder and do not block navigation. Navigation stops at the first and final member; it does not wrap.

## 14. File observation, hashing, and decode validation

### 14.1 Quick fingerprint

The quick fingerprint is:

~~~text
canonical expected location + byte size + mtime in nanoseconds
~~~

Node BigInt stat values are used inside privileged processes. The renderer receives only formatted time and size. A matching quick fingerprint avoids expensive hashing but is never proof of content equality.

### 14.2 Whole-file SHA-256

<code>source_sha256</code> and <code>current_file_sha256</code> are calculated by streaming the complete file through Node's SHA-256 implementation with bounded buffers. Hashing never loads the complete file in memory.

- Source hash is immutable after import.
- Current-file hash changes after a successful metadata rewrite or accepted external change.
- Exact duplicate lookup checks indexed source and current hashes.
- Before deleting an exact Inbox duplicate, the matched stored photo is located and fully decoded again.

### 14.3 JPEG image-data SHA-256

JPEG image-data hash is obtained from ExifTool's <code>ImageDataHash</code> with:

~~~text
-api
ImageHashType=SHA256
-ImageDataHash
~~~

This hash excludes metadata and identifies the encoded JPEG image payload. It is used to prove that an ExifTool metadata operation did not alter image data.

An image-data match with different whole-file bytes is only a possible duplicate. It never authorizes automatic deletion.

### 14.4 Full decode

Sharp validation sends decoded pixels through a bounded streaming sink and requires the pipeline to finish successfully. Calling only <code>metadata()</code> is not full validation.

Validation records:

- Detected format.
- Width and height.
- Page count and page height where applicable.
- EXIF orientation.
- Alpha presence.
- ICC/profile presence.
- Decoder warnings and errors.

The Sharp input limit is 268,402,689 pixels, matching its documented protective default. A larger image is preserved and reported as <code>resource_limit_exceeded</code>; it is not partially decoded or silently resized.

### 14.5 Durable temporary outputs

Before a verified temporary output can be renamed:

1. The producing stream closes successfully.
2. The file is opened read-only and fully decoded.
3. Expected dimensions and format are checked.
4. Required hashes and metadata are verified.
5. A file handle <code>sync()</code> succeeds.
6. The operation journal records that verification completed.

Node does not provide a universal durable directory-fsync guarantee on Windows. PhotoTagger therefore claims recoverable, journaled replacement rather than strict power-loss atomicity.

## 15. Image-processing design

### 15.1 Inbox snapshot and stability

Clicking Import enumerates regular files directly beneath Inbox, rejects links and subdirectories from the job snapshot, and sorts by:

1. <code>Intl.Collator("en-US", { numeric: true, sensitivity: "base" })</code>.
2. NFC filename code-unit order as a tie-breaker.
3. The exact enumerated filename as the final tie-breaker.

Each source must produce equal byte size and mtime-nanosecond observations two seconds apart and open for reading. The worker makes at most five stability observations during that import pass. A growing, changing, or locked file remains in Inbox with waiting state and is reconsidered only by a later explicit Import command.

### 15.2 Format detection

The main process reads a small bounded header for signature classification, then Sharp attempts a real decode. ExifTool independently identifies metadata format. The accepted result must be consistent:

| Input | Required evidence |
| --- | --- |
| JPEG | JPEG signature and successful Sharp JPEG decode |
| PNG | PNG signature and successful Sharp PNG decode |
| still WebP | RIFF/WEBP signature, successful Sharp WebP decode, exactly one page/frame |
| animated WebP | More than one frame/page; reject to Failed |
| GIF | GIF signature; reject to Failed without extracting a frame |
| Other | Unsupported; move to Failed |

An extension is never used as acceptance evidence.

### 15.3 Existing JPEG

The JPEG pipeline does not invoke Sharp output encoding for the stored photograph:

1. Stabilize and fully decode the Inbox source.
2. Read controlled and preserved metadata.
3. Calculate whole-file and image-data SHA-256.
4. Perform duplicate checks.
5. Reserve an ID.
6. Journal and rename source to its canonical Storage path.
7. Generate and verify the external thumbnail.
8. Fully decode and hash the canonical file.
9. Commit the photo, imported tags, content revision 1, and reservation.
10. Queue metadata synchronization only when controlled fields or PreservedFileName require normalization.

The absence of an embedded thumbnail alone does not force a new JPEG rewrite. When another metadata write is required, the job attempts the embedded thumbnail in the same output.

### 15.4 PNG and still-WebP conversion

The Sharp pixel pipeline is:

~~~typescript
sharp(source, {
  animated: true,
  failOn: "error",
  limitInputPixels: 268402689,
  sequentialRead: true
})
  .autoOrient()
  .flatten({ background: configuredBackground })
  .toColourspace("srgb")
  .withIccProfile("srgb")
  .jpeg({
    quality: configuredQuality,
    chromaSubsampling: "4:2:0",
    progressive: false,
    optimiseCoding: true,
    mozjpeg: false
  });
~~~

Defaults are quality 92 and opaque white. Original oriented dimensions are retained; there is no resize or upscale. <code>autoOrient</code> rotates/flips pixels and the output orientation is normal.

Conversion has two temporary generations:

1. Sharp creates a normalized pixel JPEG.
2. ExifTool creates the metadata-finalized JPEG from it, copying only the approved source fields and adding PhotoTagger-controlled fields.

The second output is the candidate promoted to Storage. The first temporary file is removed only after the candidate verifies.

### 15.5 Conversion metadata allowlist

Only applicable values present in the source are copied. Structural fields are mapped to the new JPEG rather than copied blindly.

| Group | Allowed information |
| --- | --- |
| Capture time | DateTimeOriginal, CreateDate, OffsetTimeOriginal, OffsetTimeDigitized, SubSecTimeOriginal, SubSecTimeDigitized |
| Camera | Make, Model, BodySerialNumber, LensMake, LensModel, LensSerialNumber |
| Exposure | ExposureTime, FNumber, ExposureProgram, ISO, SensitivityType, ShutterSpeedValue, ApertureValue, BrightnessValue, ExposureBiasValue, MaxApertureValue, MeteringMode, LightSource, Flash, FocalLength, FocalLengthIn35mmFormat |
| Position | Standard EXIF/XMP GPS latitude, longitude, altitude, direction, speed, timestamp, datum, destination, and processing-method fields |
| Authorship | Artist, Creator, Copyright, Rights, Marked, Credit, Source |
| Description | ImageDescription, UserComment, Title, Description, Headline, Caption-Abstract, Instructions |
| Location text | City, State/Province, Country, CountryCode, Sublocation, Location |
| Keywords | Lightroom HierarchicalSubject, XMP Subject, existing IPTC Keywords, XPKeywords |

The conversion explicitly excludes:

- Orientation and pixel-dimension tags from the source.
- Old thumbnail and preview images.
- Source ICC/profile blocks.
- PNG chunks or WebP container fields with no safe JPEG mapping.
- File type, MIME type, file size, and filename tags.
- Editing-history identifiers, document/instance IDs, derived-from links, and stale software fields.
- Content Credentials, C2PA/JUMBF, signatures, digests, and authenticity claims invalidated by conversion.
- Gain maps, depth maps, animation timing, alpha data, and format-specific auxiliary images.

If an allowlisted value cannot be represented safely, conversion succeeds with a metadata warning and the source is not deleted until the warning disposition and stored output are durably recorded.

### 15.6 External thumbnails

External thumbnails use:

- Maximum width and height of 512 pixels.
- Fit <code>inside</code>.
- No enlargement.
- Orientation-correct pixels.
- sRGB output.
- JPEG quality 82.
- 4:2:0 chroma subsampling.
- Optimized Huffman coding.
- No copied metadata.

Generation writes a unique temp in the final shard directory, fully decodes it, syncs it, and renames it to the derived final name. A missing thumbnail is a regenerable condition and never justifies rewriting the stored photograph.

Regeneration uses a <code>thumbnail_replace</code> journal operation. If a previous cache file exists, it is renamed to an operation-scoped backup before the verified temp is promoted; the backup is removed only after the new canonical thumbnail decodes and its revision commits. Failure may leave the thumbnail missing or retain the old cache, but it never changes or endangers the stored photograph.

### 15.7 Embedded-thumbnail candidates

The upright thumbnail candidate sequence is:

| Attempt | Bounding box | JPEG quality |
| ---: | ---: | ---: |
| 1 | 160 × 160 | 70 |
| 2 | 160 × 160 | 60 |
| 3 | 128 × 128 | 60 |
| 4 | 128 × 128 | 50 |
| 5 | 96 × 96 | 50 |

The first candidate that ExifTool can safely embed and that can be extracted and decoded is accepted. If all fail for capacity-related reasons, the metadata write is retried without replacing the existing IFD1 thumbnail and records <code>skipped_capacity</code>. A non-capacity error follows normal metadata failure handling.

## 16. Metadata projection and ExifTool protocol

### 16.1 Desired projection

For every explicit tag, the catalog produces its full current hierarchy path. Desired fields are:

| Field | Desired value |
| --- | --- |
| XMP-lr:HierarchicalSubject | One <code>|</code>-joined path per nonlegacy explicit tag |
| MWG:Keywords | Deduplicated flat closure of explicit tags and all ancestors, including legacy flat-only values |
| EXIF:XPKeywords | The same deterministic flat set joined with semicolon-space, excluding only imported legacy values that cannot round-trip through that delimiter format |
| XMP-xmpMM:PreservedFileName | Immediate Inbox filename only when the file field is empty |
| XMP-xmp:MetadataDate | Current metadata-write time |
| EXIF IFD1 ThumbnailImage | Best-effort upright thumbnail |

Hierarchy paths sort by normalized path key and tag ID. Flat keywords sort by normalized key, display string, and tag ID. Comparison is set-based and order-independent, but output is deterministic.

The projection records its per-field expected sets. A legacy-value omission from XPKeywords or a pre-existing IPTC record is a visible <code>compatibility_projection_warning</code>, not a failed SQLite tag assignment. If MWG cannot update existing IPTC safely because of legacy encoding or length, the worker rebuilds the candidate with the full XMP Subject set, the independently representable XP set, and unchanged IPTC Keywords, then records <code>iptc_sync_warning</code>. It never uses a lossy replacement value merely to make the fields appear equal.

### 16.2 Existing metadata import

The importer reads hierarchy first:

1. Parse every Lightroom hierarchy path on literal <code>|</code>.
2. Validate each segment using import-safe normalization.
3. Resolve an exact current path or alias.
4. Transactionally create valid missing paths.
5. Record each final hierarchy node as explicit.
6. Read MWG/XMP, IPTC, and XP flat keywords.
7. Remove flat values already represented by hierarchy closure.
8. Create unmatched valid values as ordinary root tags.
9. Create unmatched values that violate new-tag syntax as legacy flat-only roots.

A slash in an existing flat keyword remains a literal value and never creates hierarchy.

### 16.3 Read request

A normal metadata read requests JSON and exact groups, including:

~~~text
-j
-G1
-struct
-api
ImageHashType=SHA256
-ImageDataHash
-XMP-lr:HierarchicalSubject
-MWG:Keywords
-XMP-dc:Subject
-IPTC:Keywords
-EXIF:XPKeywords
-XMP-xmpMM:PreservedFileName
-XMP-xmp:MetadataDate
-EXIF:Orientation
-EXIF:ThumbnailImage
~~~

Conversion inspection adds the explicit allowlist. Diagnostic code does not request unrestricted <code>-all</code> output for logging.

### 16.4 Write request construction

The service creates a new output with <code>-o</code>; it never asks ExifTool to overwrite the canonical file directly.

The request:

1. Loads MWG behavior.
2. Clears each PhotoTagger-controlled list in the output candidate.
3. Adds each desired hierarchy and MWG keyword as a separate list item.
4. Writes XPKeywords as one semicolon-delimited value.
5. Adds PreservedFileName only when the pre-read field was empty.
6. Writes MetadataDate.
7. Attempts the selected thumbnail candidate when eligible.
8. Writes to a unique same-volume temporary output.

All paths and values are separate UTF-8 argument lines. The process is spawned directly; no shell parses the request.

If and only if the normal MWG write reports a classified IPTC encoding or keyword-length failure, the candidate is discarded and rebuilt from the unchanged input. The retry writes XMP Subject directly, writes the representable XPKeywords projection, leaves the pre-existing IPTC Keywords semantically unchanged, and carries the IPTC warning into verification and catalog state.

### 16.5 Metadata verification

Before replacement:

- Sharp fully decodes the output.
- Dimensions match the canonical input.
- ExifTool image-data SHA-256 matches the journaled pre-write value.
- Hierarchical and XMP flat controlled sets match their recorded desired projections.
- XPKeywords parses to its recorded representable projection; any excluded legacy value has the required warning.
- PreservedFileName follows the only-if-empty rule.
- The embedded thumbnail is extracted and fully decoded if reported written.
- The whole-file hash is calculated.

Only then may the replacement state machine begin.

### 16.6 Revision coalescing

A tag transaction:

1. Commits desired assignment state.
2. Increments the photo's desired metadata revision.
3. Upserts one metadata job with that revision.
4. Sets <code>not_before</code> to one second after the most recent change.

Immediately before writing, the worker reads the newest desired revision and full desired projection. If a later revision commits while revision N is being written, completion acknowledges only N and returns the job to pending for the newer revision.

Automatic retry delays are 1 second, 5 seconds, 30 seconds, 5 minutes, and 30 minutes. After five automatic retries, the job remains failed and manually retryable. Drive-unavailable and conflict states suspend rather than consume retry attempts.

## 17. Filesystem transaction protocol

### 17.1 Governing rule

SQLite and NTFS cannot participate in one atomic transaction. Every operation crossing that boundary therefore uses a recoverable protocol:

1. Observe and validate current database and filesystem state.
2. Commit intent, exact paths, expected hashes, and the next phase to SQLite.
3. Perform one filesystem mutation.
4. Observe and verify the resulting files.
5. Commit the observed phase and domain-state consequence.
6. Remove redundant temporary data only after another valid copy is proven.
7. Mark the journal operation complete.

Recovery never assumes that a requested filesystem call completed merely because control did not return. It inspects actual candidates and compares their hashes with journal evidence.

### 17.2 Path and file preconditions

Immediately before mutation, the coordinator verifies:

- Every parent is an approved Collection directory.
- Source and target parents are on the same filesystem device when rename is required.
- Source type is a regular file and not a symbolic link, junction, device, or directory.
- The observed source quick fingerprint still matches the planned observation.
- A required target is absent.
- Free-space preflight passes for operations that create a second full file.

Free-space preflight reserves the larger of 512 MiB or the expected candidate size plus 25 percent. Failure pauses the relevant operation with <code>insufficient_space</code>. ENOSPC remains handled because a preflight cannot guarantee capacity.

### 17.3 Candidate classification

At recovery, each relevant path is classified as:

- Absent.
- Present and exact expected whole-file hash.
- Present and expected image-data hash but different metadata.
- Present and valid but unexpected.
- Present and unreadable.

Unexpected or ambiguous valid candidates are preserved and the operation becomes <code>recovery_required</code>.

## 18. Operation state machines

### 18.1 Existing-JPEG import

~~~mermaid
stateDiagram-v2
    [*] --> Discovered
    Discovered --> WaitingStable
    WaitingStable --> Validating
    Validating --> Hashing
    Hashing --> DuplicateCheck
    DuplicateCheck --> DuplicateCleanup: exact match
    DuplicateCheck --> ReserveId: new photo
    ReserveId --> MovePlanned
    MovePlanned --> Stored
    Stored --> Thumbnail
    Thumbnail --> CatalogCommit
    CatalogCommit --> Completed
    DuplicateCleanup --> DuplicateCompleted
    Validating --> FailedMove: invalid
    FailedMove --> Failed
~~~

Technical phases:

| Phase | Durable action | Filesystem action | Completion evidence |
| --- | --- | --- | --- |
| Discover | Insert import job | None | Job row exists |
| Stabilize | Save size and mtime | Read/stat only | Two equal observations |
| Validate/hash | Save format, dimensions, hashes, metadata snapshot | Read only | Full decode and hashes complete |
| Duplicate | Save matched photo ID or no-match result | Read matched stored photo | Exact stored photo decodes |
| Reserve | Insert ID reservation and import-move journal | None | Reservation committed |
| Move | Mark journal mutating | Rename Inbox source to canonical Storage | Source absent and target exact hash |
| Thumbnail | Record thumbnail phase | Write, verify, and promote thumbnail | Final thumbnail decodes |
| Catalog commit | Insert photo/tags/revision, commit reservation | None | Photo and reservation invariants pass |
| Finish | Complete job and journal | Remove redundant temp only | No sole valid copy removed |

If source and target both exist after a crash, neither is deleted until hashes prove one is an exact redundant copy and the operation journal authorizes cleanup. A different target always becomes recovery review.

### 18.2 Converted import

Converted import uses:

~~~text
source
  -> Sharp pixel temp
  -> ExifTool metadata temp
  -> verified canonical Storage file
  -> catalog commit
  -> source deletion
~~~

The source remains until after canonical full decode, hashes, external thumbnail, photo row, imported tags, content revision 1, and committed ID reservation all verify. Source cleanup has its own authorized journal phase. If cleanup is interrupted, restart revalidates the canonical photo before deleting the remaining converted source.

If any pre-commit candidate fails:

- Preserve the original source or an exact recoverable copy.
- Preserve a valid stored candidate that cannot yet be reconciled.
- Remove an invalid temp only when the source remains proven readable.
- Continue the batch with the next source after recording this job as failed or recovery-required.

### 18.3 Exact-duplicate cleanup

Before unlink:

1. Match source SHA-256 against an indexed source or current hash.
2. Resolve the matched photo's expected active or Trash path.
3. Fully decode that stored JPEG.
4. Recalculate its relevant whole-file hash.
5. Commit a <code>duplicate_delete</code> journal row containing source path and expected hash.
6. Unlink only the Inbox source.
7. Verify source absence.
8. Mark duplicate job and journal complete.

If deletion returns an uncertain error, observed source presence decides whether to retry or complete. A changed source returns to validation and cannot be deleted under the old authorization.

### 18.4 Failed-folder move

Unsupported, animated, corrupt, or conversion-invalid sources use a journaled rename from Inbox to Failed. Collision suffix format is:

~~~text
{original-stem}__{first-8-job-id-characters}{original-extension}
~~~

The original Inbox filename remains in the job. Return to Inbox derives the original name and refuses to overwrite an occupied path.

Delete Permanently from Import Problems is a separate main-process confirmation defaulting to Cancel. After confirmation, the coordinator revalidates the exact Failed file, commits a <code>failed_delete</code> operation with its expected hash and authorization time, unlinks only that file, verifies absence, and retains the import-problem/history record as deletion evidence. An uncertain or failed unlink leaves the problem unresolved.

### 18.5 Metadata replacement

~~~mermaid
stateDiagram-v2
    [*] --> Pending
    Pending --> BuildTemp
    BuildTemp --> VerifyTemp
    VerifyTemp --> BackupCanonical
    BackupCanonical --> PromoteTemp
    PromoteTemp --> VerifyCanonical
    VerifyCanonical --> CommitCatalog
    CommitCatalog --> RemoveBackup
    RemoveBackup --> Complete
    VerifyTemp --> Failed: invalid output
    BackupCanonical --> Recovery: ambiguous state
    PromoteTemp --> Recovery: ambiguous state
~~~

Exact sequence:

1. Record canonical whole-file hash, image-data hash, desired revision, temp path, and backup path.
2. Create the ExifTool output temp without changing canonical.
3. Verify and sync temp.
4. Re-stat and re-hash the canonical file; if its whole-file or image-data hash differs from the journaled input, preserve it, discard the stale candidate, and classify the new external change.
5. Update journal to <code>backup_canonical</code>.
6. Rename canonical to Working backup.
7. Observe backup exact hash; update journal.
8. Rename verified temp to canonical.
9. Fully decode and verify canonical; update journal.
10. Commit current-file hash, observed size/mtime, embedded status, warnings, and synchronized revision.
11. Delete backup only after canonical verification and catalog commit.
12. Complete the journal.

Recovery matrix:

| Canonical | Temp | Backup | Action |
| --- | --- | --- | --- |
| Expected old file | Any | Absent | Keep canonical; discard or rebuild temp after validation |
| Absent | Expected new | Expected old | Promote temp, verify, then finish |
| Absent | Invalid/absent | Expected old | Restore backup |
| Expected new | Absent | Expected old | Finish catalog commit, then remove backup |
| Expected old | Expected new | Expected old | Preserve; journal evidence decides whether swap began |
| Unexpected valid candidate anywhere | Any | Any | Preserve all; recovery review |

### 18.6 Move to Trash

For each batch member independently:

1. Confirm lifecycle active and resolve any pending same-photo operation.
2. Commit batch item and <code>trash_move</code> journal intent.
3. Rename Storage JPEG to Trash/Photos.
4. Move thumbnail if present; otherwise set thumbnail pending.
5. Verify the Trash JPEG against the pre-move hash.
6. Set lifecycle trashed, <code>trashed_at</code>, and suspend metadata job.
7. Complete item and journal.

One failed item does not roll back successful members.

### 18.7 Restore from Trash

Restore is the reverse operation. The destination must be absent. If Storage contains the canonical filename:

- Exact same whole-file hash: preserve both until journal and lifecycle evidence identify redundancy.
- Different or unreadable content: preserve both and create a recovery conflict.

After successful rename, the app verifies the JPEG, restores or regenerates the thumbnail, sets lifecycle active, and resumes metadata only when integrity is clean.

### 18.8 Permanent purge

A purge batch cannot enter running state until:

- The strong user confirmation is recorded.
- A verified safety backup record exists.
- A deletion manifest has been written, synced, hashed, and reopened successfully.

For each Trash photo:

1. Commit an authorized <code>trash_purge</code> journal row.
2. Remove its cached thumbnail if present.
3. Unlink only its expected Trash JPEG.
4. Verify the JPEG is absent.
5. Delete photo-tag assignments, metadata jobs, content-revision detail, and any remaining cache-state records.
6. Clear flags, dimensions, live hashes/observations, synchronization state, and thumbnail state; preserve the photo row as a purged tombstone containing its ID, original filename, source and image-data hashes, import/trash/purge timestamps, and purge-batch identity.
7. Complete the batch item and journal.

An absent JPEG without authorized purge remains missing, not purged. A failed unlink keeps the lifecycle trashed.

### 18.9 Orphan and external rename repair

An unknown canonical-looking Storage JPEG is never adopted by filename alone. It is hashed and compared against missing photos and open journal evidence.

- One exact safe match: journal a rename repair or state reconciliation.
- No match: journal a move to Recovery.
- Multiple or conflicting matches: leave candidates untouched and create recovery review.

## 19. Startup recovery

### 19.1 Recovery order

Before new writes:

1. Resolve an active <code>restore-state.json</code>.
2. Validate catalog, WAL, and SHM presence.
3. Load all noncompleted operation-journal rows.
4. Recover catalog swaps and migrations.
5. Recover metadata replacements.
6. Recover import promotions and source cleanup.
7. Recover Trash, restore, and purge operations.
8. Recover Failed and orphan moves.
9. Reconcile job leases left in writing/running state.
10. Resume only operations whose next action is unambiguous.

An operation requiring judgment becomes recovery review while unrelated clean photos remain usable.

### 19.2 Worker leases

Starting a catalog or filesystem job sets a random lease ID and start time. Leases are process-local proof only; they expire immediately after an unclean shutdown. Recovery resets abandoned noncritical leases to pending. It does not replay a destructive phase without checking filesystem evidence.

### 19.3 Drive removal

On repeated ENODEV, ENOENT at the Collection root, or device mismatch:

- Stop dispatching work.
- Do not reinterpret expected files as individually missing.
- Keep the UI open with Collection unavailable status.
- Do not create directories on another drive.
- Poll only the known portable path at a bounded interval.
- Require full Collection revalidation before resuming.

If the application executable itself becomes unavailable and continued operation is unsafe, the process exits without cleanup attempts after displaying the best available local explanation.

### 19.4 Recovery retention

Completed low-level journal rows may be pruned after 30 days only when:

- Their higher-level import, backup, Trash, or audit record remains.
- A verified catalog snapshot newer than their completion exists.
- No referenced Working file remains.

Recovery files are never age-deleted automatically in version 1.

## 20. IPC and preload contract

### 20.1 Contract rules

All channels are prefixed <code>pt:v1:</code>. The renderer imports a generated TypeScript client implemented by the preload script. It cannot select a raw channel name.

Every invocation returns:

~~~typescript
type IpcResult<T> =
  | { ok: true; data: T; catalogRevision?: number }
  | { ok: false; error: AppErrorDto };

type AppErrorDto = {
  code: string;
  category:
    | "validation"
    | "conflict"
    | "unavailable"
    | "permission"
    | "capacity"
    | "integrity"
    | "internal";
  message: string;
  affectedPhotoId?: number;
  affectedDisplayName?: string;
  dataSafe: boolean;
  retryable: boolean;
  suggestedAction?: string;
  correlationId: string;
};
~~~

Raw errors, stack traces, SQL text, absolute mutation paths, BLOB hashes, and BigInt values do not cross into the renderer.

Requests carry <code>requestMs</code> only where the operation is safely cancellable. Timing out in the renderer does not imply cancellation; the response correlation ID can be checked through status APIs.

### 20.2 Shared DTOs

~~~typescript
type PhotoSummaryDto = {
  photoId: number;
  canonicalFilename: string;
  originalFilename: string;
  flagged: boolean;
  integrityState:
    | "clean"
    | "missing"
    | "unreadable"
    | "metadata_conflict"
    | "content_conflict"
    | "recovery_required";
  width: number;
  height: number;
  contentRevision: number;
  thumbnailRevision: number;
  thumbnailUrl: string;
};

type PhotoDetailDto = PhotoSummaryDto & {
  lifecycleState: "active" | "trashed";
  fullImageUrl?: string;
  explicitTags: TagPathDto[];
  desiredMetadataRevision: number;
  syncedMetadataRevision: number;
  metadataState:
    | "synchronized"
    | "pending"
    | "writing"
    | "failed"
    | "suspended_conflict"
    | "synchronized_with_warning";
  importedAt: string;
  lastVerifiedAt?: string;
};

type TagPathDto = {
  tagId: number;
  parentTagId?: number;
  displayName: string;
  fullPath: string;
  depth: number;
  childCount: number;
  pinned: boolean;
  legacyFlatOnly: boolean;
};

type SelectionRefDto = {
  selectionId: string;
  count: number;
  catalogRevisionAtCapture: number;
};

type PageCursorDto = { opaque: string };
~~~

Purged rows are not returned as <code>PhotoSummaryDto</code> or <code>PhotoDetailDto</code> and are never eligible for the photo protocol. Where deletion evidence must be shown, a separate tombstone DTO exposes only the approved retained fields.

Every numeric ID must be a positive safe JavaScript integer. Strings have request-specific maximum lengths. Arrays have bounded lengths except where an opaque server-side selection represents a large set.

### 20.3 Application and Library methods

| Preload method | Channel suffix | Request | Response |
| --- | --- | --- | --- |
| <code>app.getBootstrap</code> | <code>app:get-bootstrap</code> | empty | app version, modes, Collection display path, view state, counts, settings summary |
| <code>app.openFolder</code> | <code>app:open-folder</code> | approved folder enum | success |
| <code>library.query</code> | <code>library:query</code> | LibraryQuery, cursor, page size ≤ 200 | summaries, count, next cursor, query fingerprint |
| <code>library.createSelection</code> | <code>library:create-selection</code> | query fingerprint plus none/all/one seed | SelectionRefDto |
| <code>library.updateSelection</code> | <code>library:update-selection</code> | selection ID, exact photo IDs, select/unselect | updated count |
| <code>library.clearSelection</code> | <code>library:clear-selection</code> | selection ID | success |
| <code>library.getSelectionSummary</code> | <code>library:selection-summary</code> | selection ID | count, eligible/skipped counts, tag-state summary |
| <code>library.createViewSession</code> | <code>library:create-view-session</code> | query fingerprint and selected photo ID | session ID, position, count, detail |
| <code>library.navigateView</code> | <code>library:navigate-view</code> | session ID and previous/next | position and detail |
| <code>photo.getDetail</code> | <code>photo:get-detail</code> | photo ID | PhotoDetailDto |

The catalog validates that query fingerprints and session IDs belong to the current process. The renderer cannot manufacture a query cursor, selection, or view membership.

### 20.4 Tag, palette, batch, and flag methods

| Preload method | Channel suffix | Request | Response |
| --- | --- | --- | --- |
| <code>tags.suggest</code> | <code>tags:suggest</code> | query ≤ 768 UTF-8 bytes, limit ≤ 50 | TagPathDto list |
| <code>tags.getPanel</code> | <code>tags:get-panel</code> | photo ID or selection ID | palette tree, explicit/common/mixed states |
| <code>tags.toggleSingle</code> | <code>tags:toggle-single</code> | photo ID, tag ID, expected photo revision | committed photo/tag state |
| <code>tags.createPathAndAssignSingle</code> | <code>tags:create-path-single</code> | photo ID, entered path | created/resolved path and committed state |
| <code>batch.previewTags</code> | <code>batch:preview-tags</code> | selection ID and staged exact operations | eligible, skipped, changed counts and plan hash |
| <code>batch.applyTags</code> | <code>batch:apply-tags</code> | selection ID, staged operations, plan hash | committed and skipped counts |
| <code>flags.toggleSingle</code> | <code>flags:toggle-single</code> | photo ID, expected row revision | final boolean |
| <code>flags.toggleSelection</code> | <code>flags:toggle-selection</code> | selection ID | final boolean, committed and skipped counts |
| <code>palette.get</code> | <code>palette:get</code> | empty | ordered entries |
| <code>palette.update</code> | <code>palette:update</code> | complete ordered unique tag-ID list | committed entries |
| <code>tagAdmin.getTree</code> | <code>tag-admin:get-tree</code> | optional expansion cursor | tree with counts |
| <code>tagAdmin.preview</code> | <code>tag-admin:preview</code> | typed rename/move/merge/delete proposal | final tree effects, affected photos, plan hash |
| <code>tagAdmin.apply</code> | <code>tag-admin:apply</code> | proposal plus plan hash | committed result |

Expected revisions provide optimistic conflict detection. A stale renderer receives a conflict and fresh DTO, never a last-write-wins overwrite.

For <code>batch.applyTags</code>, the catalog recomputes eligibility and the material-change count from the frozen selection. If the count exceeds <code>batch.warningThreshold</code>, the main process displays the count in a confirmation dialog defaulting to Cancel. After approval, the catalog recomputes the same plan and requires the plan hash to match before committing; renderer input cannot bypass the threshold.

<code>flags.toggleSelection</code> determines its action inside the commit transaction: if any eligible selected photo is unflagged, it sets every eligible member; otherwise it clears every eligible member. It does not create metadata jobs.

Large tag-administration actions and destructive delete plans cause the main process to create the required safety backup before catalog Apply.

### 20.5 Import methods

| Preload method | Channel suffix | Request | Response |
| --- | --- | --- | --- |
| <code>inbox.getStatus</code> | <code>inbox:get-status</code> | empty | top-level count and scan time |
| <code>imports.start</code> | <code>imports:start</code> | empty | batch ID and snapshotted count |
| <code>imports.stopAfterCurrent</code> | <code>imports:stop-after-current</code> | batch ID | accepted state |
| <code>imports.getStatus</code> | <code>imports:get-status</code> | optional batch ID | progress and current display filename |
| <code>imports.getHistory</code> | <code>imports:get-history</code> | keyset cursor, filters | bounded history page |
| <code>importProblems.list</code> | <code>import-problems:list</code> | keyset cursor | problem page and count |
| <code>importProblems.retry</code> | <code>import-problems:retry</code> | job IDs ≤ 500 per call | accepted/skipped counts |
| <code>importProblems.returnToInbox</code> | <code>import-problems:return</code> | job IDs ≤ 500 | per-item results |
| <code>importProblems.delete</code> | <code>import-problems:delete</code> | job IDs ≤ 500 | result after main-owned confirmation |

<code>imports.start</code> always rescans and snapshots the current top-level files; it never adopts a stale renderer-supplied list.

### 20.6 Trash and conflict methods

| Preload method | Channel suffix | Request | Response |
| --- | --- | --- | --- |
| <code>trash.moveSelection</code> | <code>trash:move-selection</code> | selection ID | batch result after main-owned Yes/No confirmation |
| <code>trash.movePhoto</code> | <code>trash:move-photo</code> | photo ID | result after confirmation |
| <code>trash.query</code> | <code>trash:query</code> | cursor and page size | trash summaries, count, total bytes |
| <code>trash.restore</code> | <code>trash:restore</code> | exact IDs or Trash selection token | per-item result |
| <code>trash.purge</code> | <code>trash:purge</code> | exact IDs or Trash selection token | batch result after irreversible confirmation |
| <code>trash.empty</code> | <code>trash:empty</code> | empty | batch result after irreversible confirmation |
| <code>externalChanges.list</code> | <code>external:list</code> | event filter and cursor | review page |
| <code>externalChanges.resolve</code> | <code>external:resolve</code> | event IDs, allowed resolution, apply-to-compatible | results |
| <code>recovery.list</code> | <code>recovery:list</code> | cursor | ambiguous recovery items |

Permanent deletion confirmation is an Electron main-process dialog that displays count, known total size, and irreversible wording and defaults to Cancel. Renderer state cannot bypass it.

### 20.7 Settings, backup, and maintenance methods

| Preload method | Channel suffix | Request | Response |
| --- | --- | --- | --- |
| <code>settings.get</code> | <code>settings:get</code> | empty | validated public settings |
| <code>settings.update</code> | <code>settings:update</code> | allowed setting patch | committed settings |
| <code>settings.chooseSecondaryBackup</code> | <code>settings:choose-secondary</code> | empty | selected display path and availability |
| <code>backups.createNow</code> | <code>backups:create-now</code> | manual/safety reason | job ID |
| <code>backups.list</code> | <code>backups:list</code> | cursor | retained snapshot page |
| <code>backups.exportRecoveryBundle</code> | <code>backups:export-bundle</code> | empty | job ID after destination picker |
| <code>backups.restore</code> | <code>backups:restore</code> | backup ID and restore mode | job accepted after preview/confirmation |
| <code>catalog.rebuildFromPhotos</code> | <code>catalog:rebuild</code> | empty | job accepted after disclosure/confirmation |
| <code>maintenance.start</code> | <code>maintenance:start</code> | allowed maintenance job type | job ID |
| <code>maintenance.stopAfterCurrent</code> | <code>maintenance:stop</code> | job ID | accepted |
| <code>maintenance.getStatus</code> | <code>maintenance:get-status</code> | job ID | progress |
| <code>metadataActivity.list</code> | <code>metadata:list</code> | state and cursor | job page and counts |
| <code>metadataActivity.retry</code> | <code>metadata:retry</code> | exact photo IDs or retry-all flag | accepted count |
| <code>diagnostics.export</code> | <code>diagnostics:export</code> | include-paths acknowledgment | job/result after destination picker |

The secondary backup destination is the only durable user-selected path outside Collection. It is chosen through a native directory picker, stored as an absolute Windows path plus filesystem-device observation, and never accepted as renderer text.

### 20.8 Events

The preload exposes separate subscription methods, each returning an unsubscribe function:

| Event | Payload |
| --- | --- |
| <code>status.changed</code> | write-light state, concise text, safe-stop description |
| <code>catalog.changed</code> | monotonic catalog revision and affected entity classes |
| <code>import.changed</code> | batch ID and progress |
| <code>metadata.changed</code> | pending/writing/failed/warning counts |
| <code>attention.changed</code> | Import Problems, External Changes, Trash, Recovery counts |
| <code>drive.changed</code> | available/unavailable/read-only state |
| <code>maintenance.changed</code> | job ID and progress |

Each event has a process-local sequence number. A sequence gap causes the renderer to refresh relevant state. Event payloads are validated on both sides of the preload boundary.

## 21. Renderer architecture

### 21.1 State model

Renderer state is divided into:

- Bootstrap and application availability.
- Active destination: Image, Library, Settings, Manage Tags, Edit Tag Pallet, Import Problems, External Changes, Trash, Metadata Activity, or Recovery.
- Edit/View mode.
- Library query and page cache.
- Opaque selection and Image View session references.
- Staged batch-tag plan.
- Expanded palette branches.
- Status and attention counts.

Catalog data is never optimistically treated as committed. Image View tag controls may display a brief pending interaction state, then update from the successful committed response. Library batch changes are projections until Apply.

### 21.2 Component boundaries

~~~text
AppShell
  PrimaryNavigation
  ContentRegion
    ImageView
    LibraryView
    MaintenanceView
  TaggingPanel
  StatusBar
  DialogHost
~~~

Feature components access only a typed application service. They do not call <code>window.photoTagger</code> directly, which permits unit testing and prevents channel details from spreading through UI code.

### 21.3 Library virtualization

TanStack Virtual virtualizes rows rather than individual tiles:

1. ResizeObserver calculates the current column count.
2. Each virtual row contains that many fixed-aspect thumbnail cells.
3. Pages of 200 summaries feed the row model.
4. Two viewports of overscan prevent visible HDD-loading gaps.
5. Thumbnail dimensions reserve layout before bytes arrive.
6. Broken or missing thumbnails show a stable placeholder and enqueue regeneration through main-process policy.

No operation creates one DOM element per result for a 100,000-photo query.

### 21.4 Accessibility and input

- Every icon button has an accessible name and visible tooltip.
- Keyboard focus is visible.
- Dialog focus is trapped and restored.
- Enter and Space activate buttons; Escape closes nondestructive overlays.
- Destructive confirmations do not bind Enter to the destructive default.
- Mixed tag state uses <code>aria-pressed="mixed"</code> or equivalent semantics.
- Disabled Image View is both visually apparent and programmatically disabled.
- Status changes use a polite live region; rapid metadata progress is summarized rather than announced per photo.
- Motion respects reduced-motion settings.

### 21.5 URL and text safety

React text rendering is used for filenames, tags, errors, and metadata. <code>dangerouslySetInnerHTML</code> is prohibited. User content never becomes CSS, a URL scheme, raw HTML, or a DOM ID without encoding.

## 22. Operational status model

The main process calculates one status snapshot:

~~~typescript
type OperationalStatus = {
  writeState: "safe" | "writing";
  text: string;
  activeOperation?: {
    kind: string;
    completed?: number;
    total?: number;
    stopBehavior: "not-running" | "after-current" | "not-yet-safe";
  };
  attention: {
    importProblems: number;
    externalChanges: number;
    recoveryItems: number;
    metadataFailures: number;
  };
};
~~~

The status light is orange only while application-owned physical bytes or directory entries are being changed. It is green at a recoverable safe boundary even if review items exist; those appear in text and badges.

## 23. External-change detection and resolution

### 23.1 Detection sources

Detection combines:

- Startup enumeration of expected Storage and Trash names.
- Background size/mtime comparison.
- Priority checks for the current full image and visible thumbnails.
- Debounced <code>fs.watch</code> events as hints.
- Manual Scan for External Changes.
- Full Verify Library.

Watcher events never prove completeness. A self-authored operation is recognized by its open journal, expected path, expected resulting hash, and scheduler ownership—not by ignoring a time window.

### 23.2 Background scan

The scanner uses photo-ID keyset batches of 500:

1. Derive expected location from lifecycle.
2. Stat the expected file.
3. Mark the whole Collection unavailable if the Collection root/device disappeared.
4. Mark an individual file missing only when the Collection remains available.
5. If size and mtime match, update scan cursor only.
6. If quick fingerprint differs, enqueue full inspection.
7. Enumerate unknown Storage and Trash entries separately without delaying the UI.

The scan cursor is resumable. Normal startup never hashes every photo.

### 23.3 Full inspection classification

| Evidence | Classification |
| --- | --- |
| Timestamp changed; whole-file hash equal | Accept observation |
| Whole-file hash changed; image hash and controlled fields equal | Uncontrolled metadata change; accept |
| Image hash equal; controlled fields differ | Metadata conflict |
| Valid image hash differs | Content conflict |
| File exists but full decode fails | Unreadable |
| Expected file absent while Collection available | Missing |
| Unknown file has unique missing-photo hash match | Renamed candidate |
| Unknown file has no or ambiguous match | Orphan or ambiguous copy |

Accepted uncontrolled metadata changes update current whole-file hash and observation values but do not alter immutable source hash.

### 23.4 Keep Catalog Tags

This resolution:

1. Revalidates the current file and conflict event.
2. Uses the externally modified file as the metadata-write input source.
3. Replaces only PhotoTagger-controlled fields while preserving current unrelated metadata.
4. Runs normal verified metadata replacement.
5. Resolves the conflict only after successful canonical verification.

If pixels changed since the conflict snapshot, the resolution is rejected and reclassified as content conflict.

### 23.5 Use File Tags

This resolution:

1. Re-reads current file tags.
2. Applies hierarchy-first import rules.
3. Replaces the photo's explicit SQLite assignments in one transaction.
4. Advances desired metadata revision.
5. Queues normalization of all controlled fields.
6. Resolves the conflict after catalog commit, while synchronization may remain pending.

There is no automatic union. The user may add more catalog tags afterward.

### 23.6 Accept Changed Image

This resolution requires a full decode and new whole-file/image-data hashes. It:

- Retains photo ID, original filename, source hash, lifecycle, flag, and catalog tags.
- Inserts the prior/new evidence into <code>content_revisions</code>.
- Increments <code>content_revision</code>.
- Updates dimensions, orientation, current hash, image hash, size, and mtime.
- Regenerates the external thumbnail.
- Advances desired metadata revision and queues synchronization.
- Resolves the content conflict after the new revision commits.

### 23.7 Resolve Later and Restore From Backup

Resolve Later changes no file or catalog tag. Metadata jobs remain suspended.

Restore From Backup does not open arbitrary bytes through the renderer. It explains the expected canonical filename and keeps the conflict open while the user restores the file through Explorer. A rescan validates the restored file and offers the appropriate resolution.

## 24. Catalog backup

### 24.1 Snapshot creation

The catalog utility process uses better-sqlite3's SQLite Online Backup API:

1. Insert a creating <code>backup_records</code> row before snapshot start.
2. Wait until no filesystem operation is in a critical swap/purge phase.
3. Back up into <code>Working/Backups/{backup_id}.sqlite.partial</code>.
4. Open the partial through a separate read-only connection.
5. Run <code>PRAGMA quick_check</code> and <code>PRAGMA foreign_key_check</code>.
6. Check application ID, schema version, migration checksums, catalog UUID, catalog revision, and important table counts.
7. Close and SHA-256 the candidate.
8. Create canonical manifest JSON and sync both files.
9. Rename them to final paths under the appropriate Data/Backups area.
10. Mark the record verified.

A partial file never replaces an existing verified snapshot.

### 24.2 Manifest

The manifest contains:

~~~json
{
  "format": "phototagger-catalog-backup-v1",
  "backupId": "opaque-uuid",
  "createdAt": "UTC timestamp",
  "kind": "automatic",
  "applicationVersion": "1.0.0",
  "schemaVersion": 1,
  "catalogUuid": "opaque-uuid",
  "catalogRevision": 1234,
  "sqliteFilename": "catalog-20260913T120000Z.sqlite",
  "sqliteSha256": "lowercase hex",
  "counts": {
    "activePhotos": 0,
    "trashedPhotos": 0,
    "purgedPhotos": 0,
    "tags": 0,
    "explicitAssignments": 0
  }
}
~~~

Keys are written in the fixed order above. The manifest itself receives a sibling SHA-256 file for recovery bundles and secondary copies.

### 24.3 Backup triggers and retention

Automatic backup occurs on the first idle opportunity of a changed local calendar day. The local date comes from Windows; manifests remain UTC.

Safety backups occur before:

- Schema migration.
- Catalog restore.
- Permanent purge.
- Destructive tag merge/delete/move affecting stored metadata.

Retention selects verified snapshots:

- Newest snapshot for each of the most recent seven local dates.
- Newest snapshot in each of the most recent four ISO weeks.
- Newest snapshot in each of the most recent six calendar months.
- Three newest safety snapshots.
- Every manual snapshot/export.

One snapshot may satisfy several buckets; it is stored once. Pruning first marks its record, then uses a <code>backup_prune</code> operation to delete only files whose hashes match the record. A failed prune is harmless and retryable.

### 24.4 Secondary destination

After primary verification, the coordinator:

1. Resolves the user-selected destination.
2. Warns if its filesystem device matches Collection.
3. Copies the snapshot and manifest to unique <code>.partial</code> names.
4. Verifies size and SHA-256.
5. Renames both to final names.
6. Records success.

An unavailable destination sets <code>copy_pending</code> and retries on later idle opportunities. A secondary network/NAS folder is used only for completed snapshot files; the live WAL database is never opened there.

### 24.5 Recovery bundle

yazl streams a ZIP containing:

~~~text
catalog/catalog.sqlite
catalog/manifest.json
catalog/SHA256SUMS.txt
exports/tag-hierarchy.json
exports/photo-tags.csv
exports/settings.json
README.txt
~~~

The SQLite snapshot is verified before export. JSON and CSV are generated from the same catalog revision. The ZIP writes to a partial destination, is reopened and enumerated, then promoted. It contains no photo or thumbnail bytes.

The partial path, expected entries, destination, checksum, and final promotion are tracked by the maintenance job and a <code>recovery_bundle_export</code> operation. Cancellation or interruption may leave a uniquely named partial, but cannot overwrite an existing export.

## 25. Catalog restoration and rebuild

### 25.1 Why restoration has an external marker

The catalog cannot be the sole journal for replacing itself because SQLite must close before its files move. <code>Data/restore-state.json</code> is therefore the one filesystem operation marker outside SQLite.

It is written using temp-file, file-sync, rename, and reread verification and contains:

~~~json
{
  "format": "phototagger-restore-state-v1",
  "operationId": "opaque-uuid",
  "phase": "prepared",
  "expectedCatalogUuid": "opaque-uuid",
  "oldCatalogRelativePath": "Working/Restore/{operation_id}/old/catalog.sqlite",
  "candidateRelativePath": "Working/Restore/{operation_id}/candidate.sqlite",
  "candidateSha256": "lowercase hex",
  "createdAt": "UTC timestamp"
}
~~~

No user-provided value becomes one of these paths.

### 25.2 Restore activation

1. Enter maintenance mode and stop mutating workers.
2. Validate the chosen backup and manifest.
3. Reject a newer unsupported schema.
4. Create an emergency snapshot of the current readable catalog.
5. Copy the backup to the candidate path.
6. Apply supported migrations to the candidate.
7. Run full <code>integrity_check</code>, foreign-key checks, schema checks, and application invariants.
8. Write marker phase <code>prepared</code>.
9. Checkpoint and close the live catalog.
10. Move live database and any WAL/SHM files beneath the restore operation's old directory.
11. Update marker to <code>old_moved</code>.
12. Rename candidate to <code>Data/catalog.sqlite</code>.
13. Update marker to <code>candidate_promoted</code>.
14. Open and validate the new live catalog.
15. Update marker to <code>activated</code>.
16. Move the old catalog set into a dated Recovery/Catalog directory.
17. Remove the marker and restart services.
18. Reconcile current Storage and Trash according to the selected restore mode.

Marker recovery:

| Phase | Recovery |
| --- | --- |
| prepared | Live catalog remains primary; discard/cancel only after validating it |
| old_moved | Promote the verified candidate or restore the exact old catalog |
| candidate_promoted | Validate candidate; restore exact old catalog if invalid |
| activated | Finish archiving old set and remove marker |
| Invalid marker | Preserve all candidates and enter manual Recovery mode |

### 25.3 Restore modes

Recover Current Collection:

- Restores SQLite-only information from the snapshot.
- Treats current Storage and Trash as later physical evidence.
- Reads newer embedded tag projections.
- Regenerates missing thumbnails.
- Produces a reconciliation preview before applying ambiguous changes.

Roll Back Catalog State:

- Uses snapshot tags, flags, palette, settings, and states.
- Scans current files.
- Previews the count of JPEG metadata rewrites.
- Queues rewrites only after confirmation.

Neither mode claims to restore missing image bytes.

### 25.4 Rebuild from photos

Rebuild creates a separate temporary catalog:

1. Preserve failed catalog, WAL, and SHM under Recovery.
2. Enumerate canonical IDs in Storage and Trash.
3. Fully validate and hash every candidate.
4. Insert explicit ID reservations with origin <code>rebuild</code>.
5. Recover preserved filename and hierarchy-first tags.
6. Restore lifecycle from physical directory.
7. Recreate photo, tag, closure, path, and content-revision rows.
8. Set the next sequence above every recovered or evidenced tombstone ID.
9. Generate missing external thumbnails.
10. Run full checks.
11. Activate through the restore marker protocol.

The preview discloses unrecoverable SQLite-only information. Rebuild does not rewrite JPEG metadata during discovery.

## 26. Error handling, audit, and diagnostics

### 26.1 Error taxonomy

Privileged code converts low-level failures into stable application codes:

| Category | Representative codes | Default behavior |
| --- | --- | --- |
| Validation | unsupported_format, animated_input, corrupt_image, invalid_tag | Isolate item; show corrective action |
| Transient source | source_locked, source_unstable | Leave in Inbox; report waiting |
| Collection | collection_unavailable, device_changed, permission_denied | Pause global mutation lane |
| Capacity | insufficient_space, image_resource_limit | Preserve source; pause or fail item safely |
| Catalog | schema_unsupported, migration_failed, integrity_failed, constraint_failed | Enter maintenance/Recovery mode |
| Metadata | exiftool_timeout, metadata_verify_failed, embedded_thumbnail_capacity | Retry, fail, or complete with warning as classified |
| Conflict | metadata_conflict, content_conflict, destination_occupied | Suspend affected photo; require resolution |
| Recovery | ambiguous_candidates, restore_marker_invalid | Preserve all candidates; require review |

An error shown to the user identifies the affected display filename or photo ID, operation, data-safety state, and next available action.

### 26.2 Structured logs

Pino writes newline-delimited JSON under <code>Data/Logs</code>. Rotation is:

- Maximum 10 MiB per file.
- Ten retained application log files.
- One active file.
- Oldest rotated file removed only after the replacement log is open.

Each record may include:

- UTC timestamp and severity.
- Application, Electron, SQLite, Sharp, and ExifTool versions.
- Session, correlation, operation, job, batch, and photo IDs.
- Relative Collection paths.
- State transition.
- Exit status, duration, byte count, and error code.

Logs do not contain image/thumbnail bytes, complete metadata dumps, tag lists unless required for a user-requested diagnostic, secrets, raw IPC objects, or unrestricted absolute paths.

### 26.3 Catalog audit events

The <code>audit_events</code> table records important durable outcomes such as:

- Import completion, duplicate deletion, and Failed moves.
- Tag rename, move, merge, and delete.
- Trash, restore, and purge.
- Conflict creation and resolution.
- Backup verification, restore, and rebuild.
- Recovery decisions and ambiguous states.

Routine per-page queries and thumbnail reads are not audited.

### 26.4 Diagnostic report

After an explicit disclosure that filenames and paths may be present, diagnostic export creates a ZIP with:

- Version manifest.
- Sanitized settings.
- Recent logs.
- Schema and migration inventory.
- Table counts and state counts.
- <code>quick_check</code> and foreign-key results.
- Open job and journal summaries.
- Collection device and free-space observations.

It excludes the database itself, photos, thumbnails, tag assignments, and unrestricted metadata unless the separate Recovery Bundle action is selected.

## 27. Performance and resource design

### 27.1 Reference environment

Performance acceptance uses:

- Windows 11 x64.
- Four physical CPU cores at 2.5 GHz or better.
- 16 GiB RAM.
- USB 3.x external 7200-RPM NTFS HDD.
- 100,000 photos and 10,000 tags.
- 1,000,000 explicit photo-tag assignments.
- 10,000-file Inbox snapshot.
- External thumbnails already generated except in the explicit cold-cache scenario.

The test report records exact hardware, drive model, filesystem, catalog size, cache condition, and antivirus state.

### 27.2 Budgets

| Operation | Target |
| --- | --- |
| Window usable after normal start | ≤ 5 seconds |
| Indexed filter count plus first page | p95 ≤ 500 ms |
| Next Library page from warm catalog | p95 ≤ 250 ms |
| Tag suggestion first 50 | p95 ≤ 100 ms |
| Visible thumbnail scrolling | No long main-thread task above 50 ms |
| Select All snapshot at 100,000 matches | ≤ 2 seconds with progress affordance after 500 ms |
| Main process idle CPU | Below 1 percent average after background scan settles |
| Normal startup full-file hashes | Zero, absent a changed quick fingerprint or recovery need |

The 500-ms filter requirement measures catalog request through first DTO response after startup readiness. Both cold-process and warm-cache results are reported; the release gate applies to the documented reference run.

### 27.3 Backpressure

- Renderer retains at most six Library pages per query before evicting distant pages.
- Photo protocol permits at most eight concurrent thumbnail reads and two full-image reads.
- The image utility permits one full decode or transform.
- ExifTool permits one request.
- The mutation scheduler permits one physical writer.
- Inbox enumeration stores filenames/stat data but does not open or decode multiple images concurrently.
- Event progress is coalesced to at most ten renderer updates per second.

### 27.4 Query maintenance

After migration and major tag-administration operations, the catalog runs targeted <code>ANALYZE</code> as needed and <code>PRAGMA optimize</code>. It does not VACUUM automatically. Performance tests capture <code>EXPLAIN QUERY PLAN</code> for canonical queries and fail if required indexes are not used.

## 28. Test architecture

### 28.1 Test layers

| Layer | Scope |
| --- | --- |
| Unit | Normalization, path containment, hashes, projections, state reducers, retry classification |
| Catalog integration | Real SQLite migrations, constraints, queries, transactions, closure maintenance, backup API |
| Image/metadata integration | Real Sharp and bundled ExifTool against fixture copies |
| Recovery | Real filesystem layouts and process-kill/failpoint scenarios |
| Renderer component | Interaction, mixed states, staged edits, accessibility |
| Electron E2E | Packaged-style renderer/preload/main interaction |
| Package smoke | Unpacked and ZIP release on Windows x64 |
| Performance | Seeded 100,000-photo catalog, virtual grid, selection, queries, queues |

Mocks are used only at an explicit boundary. Recovery acceptance uses real files, real SQLite, and real rename/unlink behavior on NTFS.

### 28.2 Fixture corpus

Fixtures include:

- Baseline and progressive JPEGs.
- EXIF orientations 1 through 8.
- JPEGs with XMP, IPTC, XPKeywords, ICC profiles, GPS, large APP1 blocks, and embedded thumbnails.
- Transparent, indexed, 8-bit, and 16-bit PNGs.
- Still and animated WebP.
- GIF and unsupported signatures.
- Truncated headers, truncated entropy streams, malformed metadata, and decoder bombs bounded by resource limits.
- Unicode filenames and tags, reserved Windows names, long paths, delimiter characters, and normalization-equivalent strings.
- Exact whole-file duplicates and image-data-only duplicates.
- ExifTool output warnings and capacity failures.

Every source fixture is immutable. Tests work on generated copies in a unique temporary Collection.

### 28.3 Golden assertions

For image operations, tests retain expected:

- Source SHA-256.
- Current-file SHA-256 where byte determinism is promised.
- Image-data SHA-256.
- Dimensions and orientation.
- Controlled metadata sets.
- Pixel samples or decoded-pixel hash for conversion fixtures.

Existing-JPEG import must preserve the exact source whole-file hash before any separately required metadata job. Metadata replacement must preserve image-data hash. Conversion quality is validated by pipeline settings, dimensions, decode success, and approved visual/sample fixtures rather than requiring cross-libvips byte identity after a dependency upgrade.

### 28.4 Fault injection

All filesystem and catalog boundary adapters expose test-only failpoints. Recovery tests terminate the process or throw after:

- Every journal commit.
- Every temp close/sync.
- Every rename.
- Every unlink.
- Every canonical verification.
- Every catalog domain commit.
- Backup partial creation, manifest creation, and promotion.
- Every restore-marker phase.

Each test restarts the application and asserts:

- At least one valid copy remains unless purge was explicitly authorized.
- No photo ID is reused.
- No unknown file appears in normal Library.
- Catalog and filesystem converge or expose a reviewable ambiguity.
- Re-running recovery is idempotent.

### 28.5 Requirement traceability

Test names include functional requirement or acceptance IDs, for example:

~~~text
AC-009__FR-IMP-030__crash-after-storage-rename
AC-025__FR-TRASH-025__crash-after-authorized-unlink
AC-037__FR-LIB-017__select-all-membership-remains-fixed
~~~

A generated report fails CI when a required acceptance ID has no executable test or an explicitly documented manual verification.

### 28.6 Security and offline tests

The packaged app is run with outbound network blocked. Tests assert:

- No DNS, HTTP, HTTPS, WebSocket, telemetry, or updater attempt.
- Renderer Node globals are absent.
- Arbitrary IPC channels and malformed payloads fail.
- Navigation and new-window attempts are denied.
- Photo protocol traversal and encoded-separator attempts fail.
- CSP contains no unsafe production directive.
- Electron fuses match the release policy.

## 29. Release and packaging procedure

### 29.1 Release pipeline

On a clean Windows x64 worker:

1. Check out an annotated release commit.
2. Install Node 24.20.0 and npm 11.19.0.
3. Run <code>npm ci</code>.
4. Verify direct package versions and vendor ExifTool checksum.
5. Run formatting, linting, type checking, unit, integration, and renderer tests.
6. Run recovery tests on NTFS.
7. Build the Electron package.
8. Run package smoke and offline/security tests against the packaged executable.
9. Run the required acceptance subset.
10. Create the Forge ZIP.
11. Generate release SHA-256 and dependency manifest.
12. Archive test reports with the release.

### 29.2 Package verification

Verification proves:

- <code>PhotoTagger.exe</code> starts without installation or administrator access.
- better-sqlite3 and Sharp native binaries load.
- ExifTool executable and support folder are present and report 13.59.
- No source maps, test fixtures, development server URLs, or secrets ship.
- Production CSP and fuses are active.
- The app creates Collection beside the executable.
- Moving the entire folder to another NTFS drive letter preserves operation.
- The package makes no network request.

### 29.3 Versioning and upgrades

Application versions use semantic versioning. Catalog compatibility is governed separately by <code>user_version</code> and migration records.

Because version 1 has no automatic updater, upgrades are manual:

- Exit PhotoTagger cleanly.
- Back up the Collection.
- Replace runtime files while preserving Collection.
- Start the new executable, which performs candidate-based migration if needed.

The release ZIP and instructions never encourage extracting over Collection with a destructive overwrite tool.

Code signing is recommended for a broadly distributed release but is not required for internal version-one functionality. Signing cannot change runtime behavior or introduce an online dependency.

## 30. Implementation sequence

### Milestone 0 — Engineering foundation

Deliver:

- Repository and exact dependency lock.
- TypeScript/Forge/Webpack setup.
- Shared contracts and error model.
- Packaged secure window and preload bridge.
- Portable Collection bootstrap and logging.
- Windows package smoke test.

Exit: packaged app launches offline from a movable folder and renderer has no Node access.

### Milestone 1 — Catalog and read-only UI

Deliver:

- Migration 001 and catalog utility process.
- Tags, closure/path maintenance, settings, and query repositories.
- Approved Image/Library layout.
- Keyset Library query, virtual grid, filters, flag filter, and session selections.
- Synthetic 100,000-photo catalog performance harness.

Exit: catalog/UI requirements work against seeded records without importing image files.

### Milestone 2 — JPEG vertical slice

Deliver:

- Mutation scheduler and journal.
- Inbox scan and stabilization.
- Full JPEG decode and hashes.
- ID reservation, same-volume move, external thumbnail, catalog commit.
- Image View and immediate single tagging in SQLite.
- Restart persistence and first import recovery tests.

Exit: one or many JPEGs import without re-encoding, appear in both views, accept tags, and recover at every implemented phase.

### Milestone 3 — Metadata projection

Deliver:

- Bundled persistent ExifTool service.
- Existing metadata import.
- Tag projection and job coalescing.
- Verified metadata replacement and embedded thumbnail behavior.
- Metadata Activity screen.

Exit: tag changes survive restart, preserve JPEG image-data hash, and synchronize controlled fields.

### Milestone 4 — Conversion and import problems

Deliver:

- PNG/still-WebP conversion.
- Conversion metadata allowlist.
- Animation/unsupported/corrupt handling.
- Exact and possible duplicate handling.
- Import Problems actions.

Exit: all supported and rejected fixture types satisfy import acceptance scenarios.

### Milestone 5 — Library batch work and administration

Deliver:

- Frozen Select All.
- Mixed/On/Off staged batch changes.
- Flags.
- Tag Pallet editor.
- Tag rename, move, merge, delete, previews, aliases, and safety snapshots.

Exit: batch operations satisfy correctness and reference-scale tests.

### Milestone 6 — Trash and purge

Deliver:

- Trash grid, same-volume move, read-only view, restore.
- Strong purge confirmation, snapshot, manifest, tombstones.
- Complete Trash fault matrix.

Exit: all Trash acceptance and recovery tests pass.

### Milestone 7 — External changes and maintenance

Deliver:

- Watcher hints, scans, quick fingerprints, full classifications.
- Metadata/content conflict review and resolution.
- Verify Library and thumbnail maintenance.
- Orphan and renamed-file handling.

Exit: external edits are never silently overwritten and all review paths are testable.

### Milestone 8 — Backup, restore, and rebuild

Deliver:

- Automatic retention, secondary copies, and Recovery Bundle.
- Restore marker and both restore modes.
- Rebuild catalog from photos.
- Full catalog-swap fault tests.

Exit: catalog loss/corruption scenarios recover to the approved limits.

### Milestone 9 — Release hardening

Deliver:

- Complete AC-001 through AC-037 report.
- Reference performance report.
- Accessibility and offline/security audit.
- Dependency/license inventory.
- Windows x64 ZIP and checksums.

Exit: release candidate meets every mandatory Product and Functional requirement.

## 31. Technical traceability

| Functional area | Primary technical sections |
| --- | --- |
| FR-PLAT, FR-START, FR-SHUT | 6–10, 19, 29 |
| FR-ID, FR-STATE | 11, 17–19 |
| FR-UI | 20–22 |
| FR-IMP, FR-DUP, FR-FAIL | 14–15, 17–19 |
| FR-CONV, FR-THM | 14–16 |
| FR-TAG, FR-TADM | 11–13, 16, 20 |
| FR-META | 14, 16–19 |
| FR-LIB, FR-BATCH, FR-FLAG | 11–13, 20–21 |
| FR-TRASH | 17–20, 24 |
| FR-EXT | 14, 18–19, 23 |
| FR-BACK, FR-REST | 11, 17, 19, 24–25 |
| FR-SET | 20–22, 24–26 |
| FR-OPS | 5, 17–19, 22, 26 |
| FR-SEC | 4, 7–9, 20, 28–29 |
| FR-PERF | 5, 11–13, 21, 27–28 |

The implementation backlog and tests must attach individual FR IDs. This table is architectural coverage, not a substitute for requirement-level test traceability.

## 32. Architecture decision records

The repository will create short ADRs for:

1. Electron utility process for catalog ownership.
2. better-sqlite3 and exact SQLite amalgamation.
3. One serialized filesystem mutation lane.
4. Closure table for hierarchical filtering.
5. ExifTool ImageDataHash with SHA-256.
6. Custom ID-only photo protocol.
7. Candidate-based catalog migration and external restore marker.
8. React virtualized grid and server-side selection snapshots.
9. Existing-JPEG no-reencode boundary.
10. Conversion metadata allowlist.

An ADR records context, decision, consequences, and supersession. It may explain the design but may not silently override this specification.

## 33. Resolved deferred decisions

The Functional Specification's deferred technical decisions are resolved as follows:

| Deferred item | Resolution |
| --- | --- |
| Dependency versions | Section 7 exact baseline |
| SQLite binding/worker | better-sqlite3 in catalog utility process |
| Packaging | Electron Forge ZIP of folder-based Windows package |
| Schema/indexes/triggers | Section 11 |
| Migration format/application ID | Numbered immutable SQL; PTAG application ID |
| Normalization key | NFC plus deterministic en-US lowercase plus NFC |
| Invalid pre-existing flat keywords | Root-only <code>legacy_flat_only</code> records with per-field lossless projection warnings; user-created tags remain under normal validation |
| Conversion metadata allowlist | Section 15.4 |
| Thumbnail quality/sharding | Quality 82; low-byte hexadecimal shard |
| Stability/retry | Two-second stability samples; bounded retries in Sections 15–16 |
| Reference performance environment | Section 27 |
| Log rotation/diagnostics | Section 26 |
| Branding | Working name PhotoTagger; icon remains replaceable before final release |

Brand artwork and optional code-signing credentials do not block implementation.

## 34. Definition of technical readiness

The design is ready for implementation when:

1. The initial DDL executes on the pinned SQLite version.
2. Every table, index, trigger, and temporary table passes schema tests.
3. Every destructive filesystem transition has a precommitted journal state and recovery outcome.
4. Every renderer capability maps to a named validated IPC operation.
5. No renderer operation accepts an arbitrary path, command, SQL fragment, or Electron object.
6. Packaging can locate every native dependency and ExifTool resource.
7. Acceptance tests map to implementation milestones.
8. The design introduces no network dependency or automatic updater.
9. Product and functional traceability checks contain no unresolved requirement prefix.

## 35. Primary technical references

- [Electron releases](https://releases.electronjs.org/)
- [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security)
- [Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process)
- [Electron protocol API](https://www.electronjs.org/docs/latest/api/protocol)
- [Electron Forge Webpack plugin](https://www.electronforge.io/config/plugins/webpack)
- [Electron Forge native-module unpacking](https://www.electronforge.io/config/plugins/auto-unpack-natives)
- [Electron Forge ZIP maker](https://www.electronforge.io/config/makers/zip)
- [Electron Forge fuses](https://www.electronforge.io/config/plugins/fuses)
- [better-sqlite3 API](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md)
- [SQLite Online Backup API](https://www.sqlite.org/backup.html)
- [SQLite write-ahead logging](https://www.sqlite.org/wal.html)
- [SQLite PRAGMA reference](https://www.sqlite.org/pragma.html)
- [Sharp installation and native binaries](https://sharp.pixelplumbing.com/install/)
- [Sharp input metadata](https://sharp.pixelplumbing.com/api-input/)
- [Sharp output options](https://sharp.pixelplumbing.com/api-output/)
- [ExifTool application documentation](https://exiftool.org/exiftool_pod2.html)
- [ExifTool tag-name documentation](https://exiftool.org/TagNames/)
- [ExifTool distribution and Windows packaging](https://exiftool.org/)

## 36. Approval status

This document resolves the technical choices needed to start PhotoTagger version-one implementation. Its final design review produced these results:

- All 36 numbered sections and 66 fenced blocks are structurally balanced.
- The DDL creates 22 durable tables, 18 explicit indexes, 13 triggers, and four temporary session tables without foreign-key or integrity errors in the available SQLite 3.53.3 validator.
- Constraint probes reject duplicate open conflicts, legacy-parent violations, and attempts to reactivate a purged ID while permitting the approved minimal tombstone transition.
- All 25 Functional Specification requirement families are mapped, all 19 Product Specification goals are present in the source trace, and acceptance IDs AC-001 through AC-037 form a complete sequence.
- The migration is rerun unchanged against the packaged better-sqlite3 SQLite 3.53.4 binary during Milestone 0; that package-specific repetition is an implementation release gate, not an unresolved design choice.

No remaining technical-design decision blocks repository scaffolding or the JPEG vertical slice.
