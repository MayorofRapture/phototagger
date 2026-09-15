# AI Agent Guidelines for PhotoTagger

This document provides mandatory operational and architectural rules for all AI coding agents working on the PhotoTagger repository.

---

## 1. Specification Authority Hierarchy

The three specification documents located in the repository are the sole and absolute source of truth. They must be followed strictly in this order of precedence:

1. **Product Specification** (`Specs/PhotoTagger_Product_Specification_v1.md`) — Controls product intent, scope, and priorities.
2. **Functional Specification** (`Specs/PhotoTagger_Functional_Specification_v1.md`) — Controls observable user experience and operational behavior.
3. **Technical Design Specification** (`Specs/PhotoTagger_Technical_Design_Specification_v1.md`) — Controls software architecture, data structures, dependencies, protocols, and implementation.
4. **Source Code, Migrations, Tests, and Packaging** — Must conform unconditionally to all three documents.

If an implementation convenience conflicts with an approved specification requirement, **the specification wins**. Do not alter specifications, substitute architectural designs, or weaken requirements without explicit human approval.

---

## 2. Milestone-by-Milestone Implementation Sequence

Agents must work **strictly one milestone at a time** as defined in Section 30 of the Technical Design Specification:

- **Milestone 0: Engineering Foundation** (Current) — Repository scaffolding, locked dependencies, TypeScript/Forge/Webpack config, secure window/preload, portable Collection bootstrap, structured logging, base tests, and package smoke verification.
- **Milestone 1: Catalog and Read-Only UI** — Schema migration 001, better-sqlite3 in catalog utility process, tag closure/paths, virtualized Library view, queries, and synthetic benchmark harness.
- **Milestone 2: JPEG Vertical Slice** — Mutation scheduler, journal, Inbox stabilization, JPEG decode/hash, ID reservation, move to Storage, thumbnail generation, catalog commit, Image View, and restart recovery.
- **Milestone 3: Metadata Projection** — Bundled ExifTool service, metadata import, hierarchical XMP / flat MWG / XPKeywords projection, embedded thumbnails, and Metadata Activity screen.
- **Milestone 4: Conversion and Import Problems** — PNG and still-WebP conversion pipeline, metadata allowlist, failure isolation to Failed folder, duplicate handling, and problem management.
- **Milestone 5: Library Batch Work and Administration** — Frozen Select All, batch tag staging/application, flags, Tag Pallet editor, tag administration (rename, move, merge, delete), and safety backups.
- **Milestone 6: Trash and Purge** — Trash grid/view, same-volume move, restore, multi-step permanent purge with safety backup/manifest/tombstones, and fault matrix.
- **Milestone 7: External Changes and Maintenance** — Background scanner, change classification (metadata vs content conflicts), reconciliation actions, and library integrity verification.
- **Milestone 8: Backup, Restore, and Rebuild** — Automatic/manual backups, secondary destination copy, Recovery Bundle ZIP, restore marker protocol, and catalog rebuild from photos.
- **Milestone 9: Release Hardening** — Full AC-001 through AC-037 requirement verification, offline security verification, performance audit, and release packaging.

**Never start implementing features from later milestones before completing and verifying the current milestone.**

---

## 3. Core Architectural Boundaries & Process Isolation

1. **Process Boundaries**:
   - **Main Coordinator Process**: Owns window lifecycle, security policy, single-instance enforcement, IPC validation, physical-write scheduling, filesystem path containment, and custom protocols (`pt-app://`, `pt-photo://`). Does NOT run large SQL queries, decode heavy images, or execute ExifTool commands directly.
   - **Catalog Utility Process**: Electron `utilityProcess` owning the single `better-sqlite3` connection. Executes queries, migrations, transactions, and returns renderer-safe DTOs.
   - **Image Utility Process**: Electron `utilityProcess` owning `sharp` for decode validation, orientation, PNG/WebP-to-JPEG conversion, and thumbnail generation.
   - **Metadata Service**: Bundled ExifTool x64 running persistently (`-stay_open True -@ -`). Communicates via UTF-8 arguments through standard I/O pipes.
   - **Renderer Process**: Unprivileged, sandboxed React application. Absolutely NO Node integration, no raw IPC access, no direct filesystem access, and no SQL access.

2. **Security Rules**:
   - `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`.
   - Content Security Policy (CSP) strictly prohibits inline scripts, eval, remote resources, or telemetry.
   - Preload script exposes only a frozen, typed API client (`window.photoTagger`).
   - Renderer accesses images ONLY via `pt-photo://` custom protocol using numeric photo IDs and revision tokens; renderer never handles filesystem paths.
   - Main process validates IPC sender window, frame origin, and validates all request payloads with Zod schemas.

3. **Data Safety & Filesystem Protocol**:
   - The primary goal is **preserving the only valid photo copy**. Never delete a source file without verified canonical storage and committed catalog/journal state.
   - SQLite and NTFS cannot share atomic transactions. Operations crossing boundaries must use the journaled protocol: Intent committed to SQLite $\rightarrow$ Filesystem mutation $\rightarrow$ Verification $\rightarrow$ Domain consequence committed $\rightarrow$ Cleanup redundant temps.
   - Storage photos are named `0000000427.jpg` (10-digit zero-padded immutable photo ID).
   - External thumbnails are sharded by `(photo_id & 255).toString(16).padStart(2, '0')`.
   - All mutations pass through the serialized physical-write lane coordinated by the main process.

---

## 4. Locked Dependency Versions & Zero Range Policy

All direct dependencies must use **exact pinned versions** with a committed `package-lock.json` (no `^` or `~` ranges):

- **Electron**: `44.3.0`
- **React & React DOM**: `19.3.0`
- **TanStack React Virtual**: `3.14.12`
- **better-sqlite3**: `13.0.3` (bundling SQLite `3.53.4`)
- **Sharp**: `0.35.4`
- **Zod**: `4.6.4` (or exact matching version specified)
- **Pino**: `10.3.1`
- **yazl**: `3.3.1`
- **Electron Forge**: `7.11.2`
- **Webpack**: `5.110.3`
- **TypeScript**: `5.4.5`
- **Vitest**: `5.0.0`
- **Playwright**: `1.63.0`
- **ESLint**: `10.10.0`
- **Prettier**: `3.9.6`

Do not upgrade or replace dependencies without explicit design approval and complete Windows package/recovery verification.

---

## 5. Offline and Portable Constraints

- PhotoTagger is completely offline: zero network requests, zero telemetry, zero auto-updaters, zero cloud dependencies.
- Portable execution: Application data resides under `./Collection` beside the executable. Paths stored in SQLite or DTOs must be Collection-relative or derived, never absolute drive paths.
