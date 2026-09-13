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
