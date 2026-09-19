import { performance } from "perf_hooks";
import fs from "fs";
import os from "os";
import path from "path";
import { initializeNewCatalogState } from "../../src/catalog/migrations/initial-state";
import {
  createSessionTables,
  openNewCatalogForSchemaValidation,
  openProductionCatalog,
  type CatalogDatabase,
} from "../../src/catalog/migrations/schema";
import {
  IssuedLibraryQueryRegistry,
  type LibraryOrder,
  type LibraryQuery,
} from "../../src/catalog/library/library-query-model";
import {
  LibraryQueryService,
  type LibraryPageResult,
  type PhotoSummaryDto,
} from "../../src/catalog/queries/library-query";
import { PhotoDetailQuery } from "../../src/catalog/queries/photo-detail";
import { TagSuggestionsQuery } from "../../src/catalog/queries/tag-suggestions";
import { LibrarySelectionService } from "../../src/catalog/sessions/library-selection-service";
import { LibraryViewSessionService } from "../../src/catalog/sessions/library-view-session-service";

/**
 * Opt-in M1F validation. It deliberately uses the production schema and query
 * services while keeping its deterministic catalog in a disposable directory.
 */
const PHOTO_COUNT = 100_000;
const ROOT_COUNT = 20;
const MIDDLE_PER_ROOT = 49;
const MIDDLE_COUNT = ROOT_COUNT * MIDDLE_PER_ROOT;
const LEAF_COUNT = 9_000;
const TAG_COUNT = ROOT_COUNT + MIDDLE_COUNT + LEAF_COUNT;
const ASSIGNMENTS_PER_PHOTO = 10;
const PHOTO_TAG_COUNT = PHOTO_COUNT * ASSIGNMENTS_PER_PHOTO;
const PAGE_SIZE = 200;
const QUERY_SAMPLES = 7;
const TEMP_MATERIALIZATION_SAMPLES = 5;
const TIMESTAMP = "2026-09-19T12:00:00.000Z";
const HASH = Buffer.alloc(32, 73);

function progress(message: string): void {
  process.stderr.write(`M1F: ${message}\n`);
}

type BenchmarkName =
  | "Library first page: unfiltered"
  | "Library subsequent page: deep keyset"
  | "Library first page: flagged"
  | "Library first page: broad tag"
  | "Library first page: medium tag"
  | "Library first page: narrow tag"
  | "Library first page: multi-tag AND"
  | "Tag suggestions"
  | "Select All: unfiltered"
  | "Select All: medium tag"
  | "Select All: narrow tag"
  | "Image View session: unfiltered"
  | "Image View session: medium tag"
  | "Image View session: narrow tag"
  | "Image View navigation: beginning"
  | "Image View navigation: middle"
  | "Image View navigation: end"
  | "PhotoDetail read";

export interface BenchmarkResult {
  operation: BenchmarkName;
  datasetOrResultSize: number;
  samples: number[];
  minMs: number;
  medianMs: number;
  maxMs: number;
  p95Ms: number;
  notes: string;
}

export interface M1FPerformanceResults {
  seed: {
    photoCount: number;
    tagCount: number;
    photoTagCount: number;
    flaggedCount: number;
    activeCount: number;
    integrityCounts: Record<string, number>;
    schemaInitializationMs: number;
    seedMs: number;
    analyzeMs: number;
    databaseBytes: number;
    transactionMode: string;
  };
  resources: {
    rssBeforeBytes: number;
    rssAfterSeedBytes: number;
    rssAfterSelectionsBytes: number;
    rssAfterViewSessionsBytes: number;
  };
  queryPlans: Record<string, string[]>;
  benchmarks: BenchmarkResult[];
  correctness: string[];
}

interface SeedReferences {
  broadTagId: number;
  mediumTagId: number;
  narrowTagId: number;
  zeroTagId: number;
  suggestionExact: string;
  suggestionPathPrefix: string;
  missingPhotoId: number;
  unreadablePhotoId: number;
  cleanPhotoId: number;
  multiTagIds: [number, number];
}

interface SeedResult {
  database: CatalogDatabase;
  databasePath: string;
  directory: string;
  references: SeedReferences;
  summary: M1FPerformanceResults["seed"];
  rssBeforeBytes: number;
  rssAfterSeedBytes: number;
}

function nowMs(): number {
  return performance.now();
}

function elapsedMs(startedAt: number): number {
  return Number((nowMs() - startedAt).toFixed(3));
}

function safeNumber(value: unknown, label: string): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number)) {
    throw new Error(`${label} is not a safe integer`);
  }
  return number;
}

function count(
  database: CatalogDatabase,
  sql: string,
  parameters?: unknown,
): number {
  const row =
    parameters === undefined
      ? database.prepare(sql).get()
      : database.prepare(sql).get(parameters);
  if (!row || typeof row !== "object" || !("count" in row)) {
    throw new Error("Count query returned no count");
  }
  return safeNumber((row as { count: unknown }).count, "count");
}

function revision(database: CatalogDatabase): bigint {
  const row = database
    .prepare("SELECT catalog_revision FROM app_state WHERE singleton = 1")
    .get() as { catalog_revision: bigint } | undefined;
  if (!row) {
    throw new Error("Missing app_state singleton");
  }
  return row.catalog_revision;
}

function deterministicTimestamp(photoId: number): string {
  return new Date(Date.UTC(2025, 0, 1) + photoId * 60_000).toISOString();
}

function uuidFor(counter: number): string {
  return `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
}

function statistics(
  samples: number[],
): Pick<BenchmarkResult, "minMs" | "medianMs" | "maxMs" | "p95Ms"> {
  if (samples.length === 0) {
    throw new Error("A benchmark needs at least one sample");
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const medianIndex = Math.floor(sorted.length / 2);
  const p95Index = Math.min(
    sorted.length - 1,
    Math.ceil(sorted.length * 0.95) - 1,
  );
  return {
    minMs: sorted[0],
    medianMs: sorted[medianIndex],
    maxMs: sorted[sorted.length - 1],
    p95Ms: sorted[p95Index],
  };
}

function benchmark<T>(
  operation: BenchmarkName,
  datasetOrResultSize: number,
  sampleCount: number,
  notes: string,
  run: () => T,
  validate: (value: T) => void,
): BenchmarkResult {
  const samples: number[] = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const startedAt = nowMs();
    const value = run();
    samples.push(elapsedMs(startedAt));
    validate(value);
  }
  return {
    operation,
    datasetOrResultSize,
    samples,
    ...statistics(samples),
    notes,
  };
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`M1F correctness assertion failed: ${message}`);
  }
}

function leafName(
  rootNumber: number,
  middleNumber: number,
  leafNumber: number,
): string {
  return `Leaf-${String(rootNumber).padStart(2, "0")}-${String(middleNumber).padStart(2, "0")}-${String(leafNumber).padStart(2, "0")}`;
}

function insertTag(
  database: CatalogDatabase,
  tagId: number,
  parentTagId: number | null,
  displayName: string,
  fullPath: string,
  depth: number,
  ancestors: number[],
): void {
  const normalized = displayName.toLocaleLowerCase("en-US").normalize("NFC");
  database
    .prepare(
      `INSERT INTO tags
    (tag_id, parent_tag_id, display_name, normalized_key, legacy_flat_only, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, ?, ?)`,
    )
    .run(tagId, parentTagId, displayName, normalized, TIMESTAMP, TIMESTAMP);
  database
    .prepare(
      `INSERT INTO tag_paths
    (tag_id, path_display, path_key, leaf_key, depth, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      tagId,
      fullPath,
      fullPath.toLocaleLowerCase("en-US"),
      normalized,
      depth,
      TIMESTAMP,
    );
  const closure = database.prepare(`INSERT INTO tag_closure
    (ancestor_tag_id, descendant_tag_id, depth) VALUES (?, ?, ?)`);
  closure.run(tagId, tagId, 0);
  ancestors.forEach((ancestorTagId, index) => {
    closure.run(ancestorTagId, tagId, ancestors.length - index);
  });
}

function photoIntegrityState(photoId: number): string {
  if (photoId % 1_009 === 0) return "missing";
  if (photoId % 1_003 === 0) return "unreadable";
  if (photoId % 997 === 0) return "metadata_conflict";
  if (photoId % 991 === 0) return "content_conflict";
  if (photoId % 983 === 0) return "recovery_required";
  return "clean";
}

function buildPhotoTagIds(
  photoId: number,
  assignableLeafIds: readonly number[],
  leafIdsByRoot: readonly (readonly number[])[],
): number[] {
  const tags = new Set<number>();
  // The first explicit tag deliberately gives roots 1 and 2 broad, realistic coverage.
  const broadRootOffset = photoId % 2 === 0 ? 0 : 1;
  const broadRootLeaves = leafIdsByRoot[broadRootOffset];
  tags.add(broadRootLeaves[photoId % broadRootLeaves.length]);
  let salt = 0;
  while (tags.size < ASSIGNMENTS_PER_PHOTO) {
    tags.add(
      assignableLeafIds[
        (photoId * 97 + salt * 7_919) % assignableLeafIds.length
      ],
    );
    salt += 1;
  }
  return [...tags];
}

function createSeedCatalog(): SeedResult {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "phototagger-m1f-"));
  const databasePath = path.join(directory, "catalog.sqlite");
  const rssBeforeBytes = process.memoryUsage().rss;
  let database: CatalogDatabase | undefined;
  try {
    const schemaStartedAt = nowMs();
    database = openNewCatalogForSchemaValidation(databasePath);
    const catalog = database;
    initializeNewCatalogState(catalog, {
      appVersion: "1.0.0-m1f",
      now: () => TIMESTAMP,
      catalogUuid: () => "00000000-0000-4000-8000-0000000000f1",
    });
    createSessionTables(catalog);
    progress("schema and TEMP tables initialized");
    const schemaInitializationMs = elapsedMs(schemaStartedAt);

    const middleIdsByRoot: number[][] = Array.from(
      { length: ROOT_COUNT },
      () => [],
    );
    const leafIdsByRoot: number[][] = Array.from(
      { length: ROOT_COUNT },
      () => [],
    );
    const integrityCounts: Record<string, number> = {
      clean: 0,
      missing: 0,
      unreadable: 0,
      metadata_conflict: 0,
      content_conflict: 0,
      recovery_required: 0,
    };
    let missingPhotoId = 0;
    let unreadablePhotoId = 0;
    let cleanPhotoId = 0;
    let nextTagId = 1;
    const seeded = catalog.transaction(() => {
      for (let rootIndex = 0; rootIndex < ROOT_COUNT; rootIndex += 1) {
        const rootId = nextTagId++;
        insertTag(
          catalog,
          rootId,
          null,
          `Theme-${String(rootIndex + 1).padStart(2, "0")}`,
          `Theme-${String(rootIndex + 1).padStart(2, "0")}`,
          1,
          [],
        );
      }
      for (let rootIndex = 0; rootIndex < ROOT_COUNT; rootIndex += 1) {
        const rootId = rootIndex + 1;
        for (
          let middleIndex = 0;
          middleIndex < MIDDLE_PER_ROOT;
          middleIndex += 1
        ) {
          const middleId = nextTagId++;
          middleIdsByRoot[rootIndex].push(middleId);
          const rootName = `Theme-${String(rootIndex + 1).padStart(2, "0")}`;
          const middleName = `Group-${String(rootIndex + 1).padStart(2, "0")}-${String(middleIndex + 1).padStart(2, "0")}`;
          insertTag(
            catalog,
            middleId,
            rootId,
            middleName,
            `${rootName}/${middleName}`,
            2,
            [rootId],
          );
        }
      }
      const baseLeavesPerMiddle = Math.floor(LEAF_COUNT / MIDDLE_COUNT);
      const extraLeaves = LEAF_COUNT % MIDDLE_COUNT;
      let middleOrdinal = 0;
      for (let rootIndex = 0; rootIndex < ROOT_COUNT; rootIndex += 1) {
        const rootId = rootIndex + 1;
        const rootName = `Theme-${String(rootIndex + 1).padStart(2, "0")}`;
        for (
          let middleIndex = 0;
          middleIndex < MIDDLE_PER_ROOT;
          middleIndex += 1
        ) {
          const middleId = middleIdsByRoot[rootIndex][middleIndex];
          const middleName = `Group-${String(rootIndex + 1).padStart(2, "0")}-${String(middleIndex + 1).padStart(2, "0")}`;
          const leafTotal =
            baseLeavesPerMiddle + (middleOrdinal < extraLeaves ? 1 : 0);
          middleOrdinal += 1;
          for (let leafIndex = 0; leafIndex < leafTotal; leafIndex += 1) {
            const leafId = nextTagId++;
            let displayName = leafName(
              rootIndex + 1,
              middleIndex + 1,
              leafIndex + 1,
            );
            if (leafId === 9_998) displayName = "%Literal";
            if (leafId === 9_999) displayName = "_Score";
            if (leafId === 10_000) displayName = "ZeroResult";
            leafIdsByRoot[rootIndex].push(leafId);
            insertTag(
              catalog,
              leafId,
              middleId,
              displayName,
              `${rootName}/${middleName}/${displayName}`,
              3,
              [rootId, middleId],
            );
          }
        }
      }
      expect(nextTagId === TAG_COUNT + 1, "seeded exactly 10,000 tags");
      const paletteInsert = catalog.prepare(`INSERT INTO palette_entries
      (tag_id, position, pinned_at) VALUES (?, ?, ?)`);
      [1_100, 2_200, 3_300, 4_400, 5_500].forEach((tagId, position) =>
        paletteInsert.run(tagId, position, TIMESTAMP),
      );

      const reservation = catalog.prepare(`INSERT INTO id_reservations
      (photo_id, origin, state, reserved_at, committed_at)
      VALUES (?, 'import', 'committed', ?, ?)`);
      const photo = catalog.prepare(`INSERT INTO photos (
      photo_id, original_filename, source_format, lifecycle_state, integrity_state, flagged,
      width, height, display_orientation, source_sha256, current_file_sha256,
      image_data_sha256, observed_size_bytes, observed_mtime_ns, content_revision,
      desired_metadata_revision, synced_metadata_revision, metadata_warning_code,
      embedded_thumbnail_status, thumbnail_state, thumbnail_revision, imported_at,
      last_verified_at, updated_at
    ) VALUES (?, ?, 'jpeg', 'active', ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      'not_attempted', 'ready', ?, ?, ?, ?)`);
      const assignment = catalog.prepare(`INSERT INTO photo_tags
      (photo_id, tag_id, assigned_at) VALUES (?, ?, ?)`);
      const assignableLeafIds = leafIdsByRoot
        .flat()
        .filter((tagId) => tagId !== 10_000);
      for (let photoId = 1; photoId <= PHOTO_COUNT; photoId += 1) {
        const integrityState = photoIntegrityState(photoId);
        integrityCounts[integrityState] += 1;
        if (integrityState === "missing" && missingPhotoId === 0)
          missingPhotoId = photoId;
        if (integrityState === "unreadable" && unreadablePhotoId === 0)
          unreadablePhotoId = photoId;
        if (integrityState === "clean" && cleanPhotoId === 0)
          cleanPhotoId = photoId;
        const desiredMetadataRevision = photoId % 211 === 0 ? 2 : 1;
        const syncedMetadataRevision = photoId % 211 === 0 ? 1 : 1;
        reservation.run(photoId, TIMESTAMP, TIMESTAMP);
        photo.run(
          photoId,
          `IMG-${String(photoId % 5_000).padStart(5, "0")}.jpg`,
          integrityState,
          photoId % 10 === 0 ? 1 : 0,
          800 + (photoId % 1_200),
          600 + (photoId % 900),
          HASH,
          HASH,
          HASH,
          100_000 + (photoId % 10_000),
          1_735_689_600_000_000_000 + photoId,
          1 + (photoId % 5),
          desiredMetadataRevision,
          syncedMetadataRevision,
          photoId % 503 === 0 ? "embedded_thumbnail_capacity" : null,
          1 + (photoId % 3),
          deterministicTimestamp(photoId),
          integrityState === "clean"
            ? deterministicTimestamp(photoId + 1)
            : null,
          TIMESTAMP,
        );
        for (const tagId of buildPhotoTagIds(
          photoId,
          assignableLeafIds,
          leafIdsByRoot,
        )) {
          assignment.run(photoId, tagId, TIMESTAMP);
        }
      }
      const metadataJob = catalog.prepare(`INSERT INTO metadata_jobs (
      photo_id, requested_revision, writing_revision, state, not_before, attempt_count,
      created_at, updated_at
    ) VALUES (?, 2, ?, ?, ?, 0, ?, ?)`);
      const states = [
        "pending",
        "debouncing",
        "writing",
        "failed",
        "suspended",
        "completed_warning",
      ];
      states.forEach((state, index) => {
        const photoId = 200 + index;
        catalog
          .prepare(
            `UPDATE photos SET desired_metadata_revision = 2,
        synced_metadata_revision = 1, metadata_warning_code = NULL WHERE photo_id = ?`,
          )
          .run(photoId);
        metadataJob.run(
          photoId,
          state === "writing" ? 2 : null,
          state,
          TIMESTAMP,
          TIMESTAMP,
          TIMESTAMP,
        );
      });
    });
    const seedStartedAt = nowMs();
    seeded.immediate();
    const seedMs = elapsedMs(seedStartedAt);
    progress("deterministic tags, photos, and photo-tag assignments seeded");

    const analyzeStartedAt = nowMs();
    catalog.exec("ANALYZE");
    catalog.pragma("optimize");
    catalog.pragma("wal_checkpoint(TRUNCATE)");
    const analyzeMs = elapsedMs(analyzeStartedAt);
    progress("ANALYZE and checkpoint completed");
    const databaseBytes = [
      databasePath,
      `${databasePath}-wal`,
      `${databasePath}-shm`,
    ]
      .filter((artifact) => fs.existsSync(artifact))
      .reduce((total, artifact) => total + fs.statSync(artifact).size, 0);
    const broadTagId = 1;
    const mediumTagId = middleIdsByRoot[0][0];
    const narrowTagId = leafIdsByRoot[0][0];
    const secondMultiTagId = 3;
    return {
      database: catalog,
      databasePath,
      directory,
      references: {
        broadTagId,
        mediumTagId,
        narrowTagId,
        zeroTagId: 10_000,
        suggestionExact: leafName(1, 1, 1),
        suggestionPathPrefix: "Theme-01/Group-01",
        missingPhotoId,
        unreadablePhotoId,
        cleanPhotoId,
        multiTagIds: [mediumTagId, secondMultiTagId],
      },
      summary: {
        photoCount: PHOTO_COUNT,
        tagCount: TAG_COUNT,
        photoTagCount: PHOTO_TAG_COUNT,
        flaggedCount: Math.floor(PHOTO_COUNT / 10),
        activeCount: PHOTO_COUNT,
        integrityCounts,
        schemaInitializationMs,
        seedMs,
        analyzeMs,
        databaseBytes,
        transactionMode:
          "one explicit IMMEDIATE transaction; prepared statements; 10 assignments/photo",
      },
      rssBeforeBytes,
      rssAfterSeedBytes: process.memoryUsage().rss,
    };
  } catch (error) {
    if (database?.open) {
      database.close();
    }
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function expectedCount(database: CatalogDatabase, query: LibraryQuery): number {
  if (query.tagIds.length === 0) {
    return count(
      database,
      `SELECT COUNT(*) AS count FROM photos
       WHERE lifecycle_state = 'active'${query.flaggedOnly ? " AND flagged = 1" : ""}`,
    );
  }
  return count(
    database,
    `WITH matching AS (
    SELECT pt.photo_id
    FROM photo_tags AS pt
    JOIN tag_closure AS tc ON tc.descendant_tag_id = pt.tag_id
    WHERE tc.ancestor_tag_id IN (SELECT value FROM json_each(@tag_ids))
    GROUP BY pt.photo_id
    HAVING COUNT(DISTINCT tc.ancestor_tag_id) = @tag_count
  )
  SELECT COUNT(*) AS count
  FROM photos AS p
  JOIN matching AS m ON m.photo_id = p.photo_id
  WHERE p.lifecycle_state = 'active'${query.flaggedOnly ? " AND p.flagged = 1" : ""}`,
    { tag_ids: JSON.stringify(query.tagIds), tag_count: query.tagIds.length },
  );
}

function comparePhotos(
  order: LibraryOrder,
  left: PhotoSummaryDto,
  right: PhotoSummaryDto,
): number {
  switch (order) {
    case "newest-imported":
      return right.photoId - left.photoId;
    case "oldest-imported":
      return left.photoId - right.photoId;
    case "original-filename-asc":
      return (
        left.originalFilename.localeCompare(right.originalFilename) ||
        left.photoId - right.photoId
      );
    case "original-filename-desc":
      return (
        right.originalFilename.localeCompare(left.originalFilename) ||
        right.photoId - left.photoId
      );
  }
}

function assertOrdered(order: LibraryOrder, photos: PhotoSummaryDto[]): void {
  for (let index = 1; index < photos.length; index += 1) {
    expect(
      comparePhotos(order, photos[index - 1], photos[index]) <= 0,
      `${order} page ordering is deterministic at index ${index}`,
    );
  }
}

function issueAndCheck(
  service: LibraryQueryService,
  database: CatalogDatabase,
  query: LibraryQuery,
  options: { cursor?: string | null; pageSize?: number } = {},
  expectedTotalCount?: number,
): LibraryPageResult {
  const page = service.queryLibrary(query, options);
  expect(
    page.totalCount === (expectedTotalCount ?? expectedCount(database, query)),
    "Library total count matches independent query",
  );
  expect(
    page.photos.length <= (options.pageSize ?? PAGE_SIZE),
    "Library page respects requested bound",
  );
  assertOrdered(query.order, page.photos);
  return page;
}

function queryPlan(
  database: CatalogDatabase,
  sql: string,
  parameters: Record<string, unknown> = {},
): string[] {
  return (
    database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(parameters) as Array<{
      detail: unknown;
    }>
  ).map((row) => String(row.detail));
}

function assertPlanIncludes(
  plan: string[],
  requiredIndex: string,
  label: string,
): void {
  expect(
    plan.some((line) => line.includes(requiredIndex)),
    `${label} uses ${requiredIndex}`,
  );
}

function cleanupViewSession(
  database: CatalogDatabase,
  viewSessionId: string,
): void {
  database
    .prepare("DELETE FROM temp.view_sessions WHERE view_session_id = ?")
    .run(viewSessionId);
}

export function runM1FPerformanceValidation(): M1FPerformanceResults {
  const seed = createSeedCatalog();
  const { database, references } = seed;
  try {
    progress("running production query and plan validation");
    const registry = new IssuedLibraryQueryRegistry();
    const library = new LibraryQueryService(database, registry);
    let selectionCounter = 1;
    let viewCounter = 1;
    const selections = new LibrarySelectionService(database, registry, {
      now: () => TIMESTAMP,
      selectionId: () => uuidFor(selectionCounter++),
    });
    const views = new LibraryViewSessionService(database, registry, {
      now: () => TIMESTAMP,
      viewSessionId: () => uuidFor(500_000 + viewCounter++),
    });
    const details = new PhotoDetailQuery(database);
    const suggestions = new TagSuggestionsQuery(database);
    const queries: Record<string, LibraryQuery> = {
      unfiltered: { tagIds: [], flaggedOnly: false, order: "newest-imported" },
      flagged: { tagIds: [], flaggedOnly: true, order: "newest-imported" },
      broad: {
        tagIds: [references.broadTagId],
        flaggedOnly: false,
        order: "newest-imported",
      },
      medium: {
        tagIds: [references.mediumTagId],
        flaggedOnly: false,
        order: "newest-imported",
      },
      narrow: {
        tagIds: [references.narrowTagId],
        flaggedOnly: false,
        order: "newest-imported",
      },
      multi: {
        tagIds: [...references.multiTagIds],
        flaggedOnly: false,
        order: "newest-imported",
      },
      zero: {
        tagIds: [references.zeroTagId],
        flaggedOnly: false,
        order: "newest-imported",
      },
    };
    const resultSizes = Object.fromEntries(
      Object.entries(queries).map(([name, query]) => [
        name,
        expectedCount(database, query),
      ]),
    ) as Record<string, number>;
    expect(
      resultSizes.unfiltered === PHOTO_COUNT,
      "all seeded photos are active Library members",
    );
    expect(
      resultSizes.flagged === Math.floor(PHOTO_COUNT / 10),
      "flagged population is deterministic",
    );
    expect(
      resultSizes.broad > 10_000,
      "broad parent tag has a substantial descendant population",
    );
    expect(
      resultSizes.medium > resultSizes.narrow,
      "medium tag is broader than narrow leaf",
    );
    expect(resultSizes.narrow > 0, "narrow tag has matches");
    expect(resultSizes.multi > 0, "multi-tag AND has matches");
    expect(resultSizes.zero === 0, "unassigned zero tag has no matches");

    const queryPlans = {
      unfiltered: queryPlan(
        database,
        `SELECT photo_id FROM photos
        WHERE lifecycle_state = 'active' ORDER BY photo_id DESC LIMIT 201`,
      ),
      flagged: queryPlan(
        database,
        `SELECT photo_id FROM photos
        WHERE lifecycle_state = 'active' AND flagged = 1 ORDER BY photo_id DESC LIMIT 201`,
      ),
      tagFiltered: queryPlan(
        database,
        `WITH matching AS (
        SELECT pt.photo_id
        FROM photo_tags AS pt
        JOIN tag_closure AS tc ON tc.descendant_tag_id = pt.tag_id
        WHERE tc.ancestor_tag_id IN (SELECT value FROM json_each(@tag_ids))
        GROUP BY pt.photo_id
        HAVING COUNT(DISTINCT tc.ancestor_tag_id) = @tag_count
      )
      SELECT p.photo_id FROM photos AS p
      JOIN matching AS m ON m.photo_id = p.photo_id
      WHERE p.lifecycle_state = 'active'
      ORDER BY p.photo_id DESC LIMIT 201`,
        {
          tag_ids: JSON.stringify([references.broadTagId]),
          tag_count: 1,
        },
      ),
      tagSuggestions: queryPlan(
        database,
        `SELECT
          t.tag_id,
          (
            SELECT COUNT(*)
            FROM tags AS child
            WHERE child.parent_tag_id = t.tag_id
          ) AS child_count,
          CASE
            WHEN p.leaf_key = @exact_key THEN 1
            WHEN p.leaf_key LIKE @prefix_key ESCAPE '\\' THEN 2
            WHEN p.path_key LIKE @prefix_key ESCAPE '\\' THEN 3
          END AS match_quality
        FROM tags AS t
        JOIN tag_paths AS p ON p.tag_id = t.tag_id
        LEFT JOIN palette_entries AS pe ON pe.tag_id = t.tag_id
        WHERE p.leaf_key = @exact_key
           OR p.leaf_key LIKE @prefix_key ESCAPE '\\'
           OR p.path_key LIKE @prefix_key ESCAPE '\\'
        ORDER BY
          match_quality,
          CASE WHEN pe.tag_id IS NULL THEN 1 ELSE 0 END,
          p.path_key,
          t.tag_id
        LIMIT @limit`,
        {
          exact_key: "theme-01/group-01",
          prefix_key: "theme-01/group-01%",
          limit: 50,
        },
      ),
    };
    assertPlanIncludes(
      queryPlans.unfiltered,
      "ix_photos_active_order",
      "unfiltered Library plan",
    );
    assertPlanIncludes(
      queryPlans.flagged,
      "ix_photos_active_flagged_order",
      "flagged Library plan",
    );
    assertPlanIncludes(
      queryPlans.tagFiltered,
      "ix_photo_tags_tag_photo",
      "tag-filter Library plan",
    );
    progress("query plans validated");

    const benchmarks: BenchmarkResult[] = [];
    benchmarks.push(
      benchmark(
        "Library first page: unfiltered",
        resultSizes.unfiltered,
        QUERY_SAMPLES,
        "Production LibraryQueryService, newest-imported, count plus first page.",
        () =>
          issueAndCheck(
            library,
            database,
            queries.unfiltered,
            {
              pageSize: PAGE_SIZE,
            },
            resultSizes.unfiltered,
          ),
        (page) =>
          expect(
            page.photos.length === PAGE_SIZE && page.nextCursor !== null,
            "unfiltered first page has a cursor",
          ),
      ),
    );

    const firstPage = issueAndCheck(library, database, queries.unfiltered, {
      pageSize: PAGE_SIZE,
    });
    expect(
      firstPage.nextCursor !== null,
      "unfiltered first page has a keyset cursor",
    );
    let deepCursor: string | null = firstPage.nextCursor;
    const traversedIds = new Set(
      firstPage.photos.map((photo) => photo.photoId),
    );
    let previousPage = firstPage;
    for (let pageNumber = 1; pageNumber <= 250; pageNumber += 1) {
      expect(
        deepCursor !== null,
        "large unfiltered result retains a deep cursor",
      );
      const nextPage = issueAndCheck(library, database, queries.unfiltered, {
        cursor: deepCursor,
        pageSize: PAGE_SIZE,
      });
      for (const photo of nextPage.photos) {
        expect(
          !traversedIds.has(photo.photoId),
          "keyset traversal has no duplicate IDs",
        );
        traversedIds.add(photo.photoId);
      }
      expect(
        comparePhotos(
          "newest-imported",
          previousPage.photos.at(-1)!,
          nextPage.photos[0],
        ) <= 0,
        "keyset boundary preserves ordering",
      );
      previousPage = nextPage;
      deepCursor = nextPage.nextCursor;
    }
    expect(
      traversedIds.size === PAGE_SIZE * 251,
      "tested keyset pages have no skipped boundary members",
    );
    expect(deepCursor !== null, "deep keyset cursor remains available");
    progress("Library query and deep keyset validation completed");
    const deepCursorForBenchmark = deepCursor;
    benchmarks.push(
      benchmark(
        "Library subsequent page: deep keyset",
        resultSizes.unfiltered,
        QUERY_SAMPLES,
        "Production cursor after 50,200 previously traversed rows; no OFFSET shortcut.",
        () =>
          issueAndCheck(
            library,
            database,
            queries.unfiltered,
            {
              cursor: deepCursorForBenchmark,
              pageSize: PAGE_SIZE,
            },
            resultSizes.unfiltered,
          ),
        (page) =>
          expect(
            page.photos.length === PAGE_SIZE,
            "deep keyset page remains bounded and full",
          ),
      ),
    );
    progress("tag suggestion validation completed");

    const libraryCases: Array<[BenchmarkName, keyof typeof queries]> = [
      ["Library first page: flagged", "flagged"],
      ["Library first page: broad tag", "broad"],
      ["Library first page: medium tag", "medium"],
      ["Library first page: narrow tag", "narrow"],
      ["Library first page: multi-tag AND", "multi"],
    ];
    for (const [operation, key] of libraryCases) {
      benchmarks.push(
        benchmark(
          operation,
          resultSizes[key],
          QUERY_SAMPLES,
          "Production LibraryQueryService, precomputed independent count oracle, bounded first page.",
          () =>
            issueAndCheck(
              library,
              database,
              queries[key],
              {
                pageSize: PAGE_SIZE,
              },
              resultSizes[key],
            ),
          (page) =>
            expect(
              page.photos.length === Math.min(PAGE_SIZE, resultSizes[key]),
              `${key} page size is correct`,
            ),
        ),
      );
    }
    const zeroPage = issueAndCheck(library, database, queries.zero, {
      pageSize: PAGE_SIZE,
    });
    expect(
      zeroPage.totalCount === 0 &&
        zeroPage.photos.length === 0 &&
        zeroPage.nextCursor === null,
      "zero-result Library query is stable",
    );

    const orderModes: LibraryOrder[] = [
      "newest-imported",
      "oldest-imported",
      "original-filename-asc",
      "original-filename-desc",
    ];
    for (const order of orderModes) {
      const query: LibraryQuery = { tagIds: [], flaggedOnly: false, order };
      const page = issueAndCheck(library, database, query, {
        pageSize: PAGE_SIZE,
      });
      expect(page.nextCursor !== null, `${order} issues an opaque cursor`);
      const next = issueAndCheck(library, database, query, {
        cursor: page.nextCursor,
        pageSize: PAGE_SIZE,
      });
      expect(
        !next.photos.some((photo) =>
          page.photos.some((first) => first.photoId === photo.photoId),
        ),
        `${order} has no duplicate across first keyset boundary`,
      );
      const created = views.createViewSession(page.queryFingerprint, 50_000);
      const memberIds = database
        .prepare(
          `SELECT photo_id FROM temp.view_members
        WHERE view_session_id = ? ORDER BY position LIMIT ?`,
        )
        .pluck()
        .all(created.viewSessionId, PAGE_SIZE)
        .map((value) => safeNumber(value, "view member photo_id"));
      expect(
        memberIds.join(",") ===
          page.photos.map((photo) => photo.photoId).join(","),
        `${order} Image View membership reuses exact Library ordering`,
      );
      cleanupViewSession(database, created.viewSessionId);
    }

    const exactSuggestions = suggestions.findTagSuggestions(
      references.suggestionExact,
    );
    expect(
      exactSuggestions[0]?.fullPath.endsWith(references.suggestionExact),
      "exact leaf suggestion resolves",
    );
    const prefixSuggestions = suggestions.findTagSuggestions("leaf-", 50);
    expect(
      prefixSuggestions.length === 50 && prefixSuggestions[0].pinned,
      "palette-aware leaf prefix ranking is stable",
    );
    expect(
      suggestions.findTagSuggestions(references.suggestionPathPrefix).length >
        0,
      "path-prefix suggestion resolves",
    );
    expect(
      suggestions
        .findTagSuggestions("%")
        .some((tag) => tag.displayName === "%Literal"),
      "percent suggestion is literal",
    );
    expect(
      suggestions
        .findTagSuggestions("_")
        .some((tag) => tag.displayName === "_Score"),
      "underscore suggestion is literal",
    );
    benchmarks.push(
      benchmark(
        "Tag suggestions",
        TAG_COUNT,
        QUERY_SAMPLES,
        "Production TagSuggestionsQuery, path-prefix lookup with maximum 50 results.",
        () =>
          suggestions.findTagSuggestions(references.suggestionPathPrefix, 50),
        (rows) =>
          expect(
            rows.length > 0 && rows.length <= 50,
            "suggestion result is bounded",
          ),
      ),
    );

    const unfilteredFingerprint = firstPage.queryFingerprint;
    const mediumFingerprint = issueAndCheck(library, database, queries.medium, {
      pageSize: PAGE_SIZE,
    }).queryFingerprint;
    const narrowFingerprint = issueAndCheck(library, database, queries.narrow, {
      pageSize: PAGE_SIZE,
    }).queryFingerprint;
    const revisionBeforeTempOperations = revision(database);
    const selectAllBenchmark = (
      operation: BenchmarkName,
      fingerprint: string,
      expected: number,
    ): BenchmarkResult =>
      benchmark(
        operation,
        expected,
        TEMP_MATERIALIZATION_SAMPLES,
        "Production LibrarySelectionService Select All into TEMP selection_members.",
        () => {
          const selection = selections.createSelection(fingerprint, {
            type: "all",
          });
          const stored = count(
            database,
            `SELECT COUNT(*) AS count FROM temp.selection_members
            WHERE selection_id = ? AND selected = 1`,
            selection.selectionId,
          );
          selections.clearSelection(selection.selectionId);
          return { ...selection, stored };
        },
        (selection) =>
          expect(
            selection.count === expected && selection.stored === expected,
            "Select All captures complete frozen membership",
          ),
      );
    benchmarks.push(
      selectAllBenchmark(
        "Select All: unfiltered",
        unfilteredFingerprint,
        resultSizes.unfiltered,
      ),
    );
    benchmarks.push(
      selectAllBenchmark(
        "Select All: medium tag",
        mediumFingerprint,
        resultSizes.medium,
      ),
    );
    benchmarks.push(
      selectAllBenchmark(
        "Select All: narrow tag",
        narrowFingerprint,
        resultSizes.narrow,
      ),
    );
    const emptySelection = selections.createSelection(unfilteredFingerprint, {
      type: "none",
    });
    expect(
      selections.getSelection(emptySelection.selectionId).count === 0,
      "Select None readback is empty",
    );
    const oneSelection = selections.updateSelection(
      emptySelection.selectionId,
      [50_000],
      true,
    );
    expect(oneSelection.count === 1, "Select One update captures exact ID");
    expect(
      selections.updateSelection(emptySelection.selectionId, [50_000], false)
        .count === 0,
      "selection update deselects exact ID",
    );
    selections.clearSelection(emptySelection.selectionId);
    expect(
      revision(database) === revisionBeforeTempOperations,
      "selection TEMP operations do not mutate catalog revision",
    );
    const rssAfterSelectionsBytes = process.memoryUsage().rss;
    progress("selection validation completed");

    const createViewBenchmark = (
      operation: BenchmarkName,
      fingerprint: string,
      selectedPhotoId: number,
      expected: number,
    ): BenchmarkResult =>
      benchmark(
        operation,
        expected,
        TEMP_MATERIALIZATION_SAMPLES,
        "Production LibraryViewSessionService complete ordered TEMP membership.",
        () => {
          const created = views.createViewSession(fingerprint, selectedPhotoId);
          const memberCount = count(
            database,
            `SELECT COUNT(*) AS count FROM temp.view_members
            WHERE view_session_id = ?`,
            created.viewSessionId,
          );
          const extent = database
            .prepare(
              `SELECT MIN(position) AS minimum, MAX(position) AS maximum
            FROM temp.view_members WHERE view_session_id = ?`,
            )
            .get(created.viewSessionId) as {
            minimum: unknown;
            maximum: unknown;
          };
          cleanupViewSession(database, created.viewSessionId);
          return { ...created, memberCount, extent };
        },
        (created) => {
          expect(
            created.count === expected && created.memberCount === expected,
            "Image View captures complete membership",
          );
          expect(
            safeNumber(created.extent.minimum, "minimum view position") === 0,
            "Image View positions start at zero",
          );
          expect(
            safeNumber(created.extent.maximum, "maximum view position") ===
              expected - 1,
            "Image View positions are contiguous",
          );
        },
      );
    benchmarks.push(
      createViewBenchmark(
        "Image View session: unfiltered",
        unfilteredFingerprint,
        50_000,
        resultSizes.unfiltered,
      ),
    );
    const mediumSelectedId = issueAndCheck(library, database, queries.medium, {
      pageSize: PAGE_SIZE,
    }).photos[0].photoId;
    const narrowSelectedId = issueAndCheck(library, database, queries.narrow, {
      pageSize: PAGE_SIZE,
    }).photos[0].photoId;
    benchmarks.push(
      createViewBenchmark(
        "Image View session: medium tag",
        mediumFingerprint,
        mediumSelectedId,
        resultSizes.medium,
      ),
    );
    benchmarks.push(
      createViewBenchmark(
        "Image View session: narrow tag",
        narrowFingerprint,
        narrowSelectedId,
        resultSizes.narrow,
      ),
    );

    const startView = views.createViewSession(
      unfilteredFingerprint,
      PHOTO_COUNT,
    );
    const middleView = views.createViewSession(unfilteredFingerprint, 50_000);
    const endView = views.createViewSession(unfilteredFingerprint, 2);
    expect(
      startView.position === 0,
      "beginning selected photo has position zero",
    );
    expect(
      middleView.position === PHOTO_COUNT - 50_000,
      "middle selected photo has expected position",
    );
    expect(
      endView.position === PHOTO_COUNT - 2,
      "end selected photo has expected position",
    );
    const navigationBenchmark = (
      operation: BenchmarkName,
      sessionId: string,
    ): BenchmarkResult =>
      benchmark(
        operation,
        PHOTO_COUNT,
        QUERY_SAMPLES,
        "Production stored-position next and previous navigation pair.",
        () => {
          const next = views.navigateView(sessionId, "next");
          const previous = views.navigateView(sessionId, "previous");
          return { next, previous };
        },
        ({ next, previous }) =>
          expect(
            next.position === previous.position + 1,
            "navigation uses adjacent stored positions",
          ),
      );
    benchmarks.push(
      navigationBenchmark(
        "Image View navigation: beginning",
        startView.viewSessionId,
      ),
    );
    benchmarks.push(
      navigationBenchmark(
        "Image View navigation: middle",
        middleView.viewSessionId,
      ),
    );
    benchmarks.push(
      navigationBenchmark("Image View navigation: end", endView.viewSessionId),
    );
    cleanupViewSession(database, startView.viewSessionId);
    cleanupViewSession(database, middleView.viewSessionId);
    cleanupViewSession(database, endView.viewSessionId);
    expect(
      revision(database) === revisionBeforeTempOperations,
      "view-session TEMP operations do not mutate catalog revision",
    );
    const rssAfterViewSessionsBytes = process.memoryUsage().rss;
    progress("Image View session validation completed");

    const cleanDetail = details.getPhotoDetail(references.cleanPhotoId);
    const missingDetail = details.getPhotoDetail(references.missingPhotoId);
    const unreadableDetail = details.getPhotoDetail(
      references.unreadablePhotoId,
    );
    expect(
      cleanDetail.fullImageUrl !== undefined &&
        cleanDetail.explicitTags.length === ASSIGNMENTS_PER_PHOTO,
      "clean PhotoDetail has renderer-safe full URL and explicit tags",
    );
    expect(
      missingDetail.fullImageUrl === undefined &&
        unreadableDetail.fullImageUrl === undefined,
      "ineligible PhotoDetail rows omit full URL",
    );
    benchmarks.push(
      benchmark(
        "PhotoDetail read",
        PHOTO_COUNT,
        QUERY_SAMPLES,
        "Production PhotoDetailQuery across low, middle, and high ID ranges.",
        () => [
          details.getPhotoDetail(references.cleanPhotoId),
          details.getPhotoDetail(50_000),
          details.getPhotoDetail(100_000),
        ],
        (rows) =>
          expect(
            rows.every((row) => Number.isSafeInteger(row.photoId)),
            "PhotoDetail IDs remain safe numbers",
          ),
      ),
    );
    progress("PhotoDetail validation completed");

    const frozen = views.createViewSession(unfilteredFingerprint, PHOTO_COUNT);
    const frozenCount = count(
      database,
      "SELECT COUNT(*) AS count FROM temp.view_members WHERE view_session_id = ?",
      frozen.viewSessionId,
    );
    database
      .prepare(
        `UPDATE photos SET lifecycle_state = 'trashed', trashed_at = ?, updated_at = ?
      WHERE photo_id = ?`,
      )
      .run(TIMESTAMP, TIMESTAMP, PHOTO_COUNT);
    expect(
      count(
        database,
        "SELECT COUNT(*) AS count FROM temp.view_members WHERE view_session_id = ?",
        frozen.viewSessionId,
      ) === frozenCount,
      "later durable fixture changes do not redefine frozen view membership",
    );
    expect(
      views.navigateView(frozen.viewSessionId, "next").detail.photoId ===
        PHOTO_COUNT - 1,
      "frozen navigation does not rerun Library filters",
    );
    cleanupViewSession(database, frozen.viewSessionId);

    const correctness = [
      "Production schema and initial state seeded in a disposable catalog.",
      "All four Library orders produced deterministic first/second keyset pages with no duplicate boundary IDs.",
      "251 unfiltered pages (50,200 rows beyond the first page) retained keyset cursors with no duplicate or skipped tested members.",
      "Independent SQL counts matched production LibraryQueryService for unfiltered, flagged, broad, medium, narrow, multi-tag AND, and zero-result cases.",
      "Ancestor tag filters included explicitly tagged descendants; multi-tag AND and unassigned-tag zero result behaved correctly.",
      "Tag suggestions covered exact leaf, leaf prefix, path prefix, palette ordering, and literal percent/underscore input.",
      "Select None, Select One, and Select All used complete TEMP membership with no catalog revision increment.",
      "Image View sessions captured complete contiguous zero-based TEMP membership for all four orders and navigated stored positions.",
      "Missing/unreadable PhotoDetail rows omitted full URLs; clean rows exposed only renderer-safe ID/revision URLs.",
      "Frozen Image View membership survived a later fixture change and TEMP state was checked separately after reopen.",
    ];
    return {
      seed: seed.summary,
      resources: {
        rssBeforeBytes: seed.rssBeforeBytes,
        rssAfterSeedBytes: seed.rssAfterSeedBytes,
        rssAfterSelectionsBytes,
        rssAfterViewSessionsBytes,
      },
      queryPlans,
      benchmarks,
      correctness,
    };
  } finally {
    const wasOpen = database.open;
    if (wasOpen) {
      database.close();
    }
    if (wasOpen) {
      const reopened = openProductionCatalog(seed.databasePath).database;
      try {
        createSessionTables(reopened);
        expect(
          count(
            reopened,
            "SELECT COUNT(*) AS count FROM temp.selection_sessions",
          ) === 0,
          "TEMP selection sessions disappear after catalog reopen",
        );
        expect(
          count(
            reopened,
            "SELECT COUNT(*) AS count FROM temp.view_sessions",
          ) === 0,
          "TEMP view sessions disappear after catalog reopen",
        );
      } finally {
        reopened.close();
      }
    }
    fs.rmSync(seed.directory, { recursive: true, force: true });
    progress("disposable catalog cleaned up");
  }
}

async function main(): Promise<void> {
  const outputPath = process.env.PHOTOTAGGER_M1F_RESULT_PATH;
  try {
    const startedAt = nowMs();
    const results = runM1FPerformanceValidation();
    const payload = JSON.stringify(
      { ...results, totalMs: elapsedMs(startedAt) },
      null,
      2,
    );
    if (outputPath) {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, `${payload}\n`, "utf8");
      process.stdout.write(`M1F result written to ${outputPath}\n`);
      return;
    }
    process.stdout.write(`${payload}\n`);
  } catch (error) {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    if (outputPath) {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(
        outputPath,
        `${JSON.stringify({ error: message }, null, 2)}\n`,
        "utf8",
      );
    }
    throw error;
  }
}

void main().catch((error: unknown) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
