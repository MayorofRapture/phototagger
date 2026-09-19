import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeNewCatalogState } from "../../src/catalog/migrations/initial-state";
import {
  openNewCatalogForSchemaValidation,
  type CatalogDatabase,
} from "../../src/catalog/migrations/schema";
import {
  CatalogOperationError,
  ImportRepository,
} from "../../src/catalog/repositories/import-repository";
import { FinalJpegCatalogCommitInputSchema } from "../../src/shared/contracts/import-catalog";

const timestamp = "2026-09-20T12:00:00.000Z";
const hashHex = "ab".repeat(32);
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function id(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function createRepository(): {
  database: CatalogDatabase;
  repository: ImportRepository;
} {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "phototagger-import-repository-"),
  );
  directories.push(directory);
  const database = openNewCatalogForSchemaValidation(
    path.join(directory, "catalog.sqlite"),
  );
  initializeNewCatalogState(database, {
    appVersion: "1.0.0-test",
    now: () => timestamp,
    catalogUuid: () => id(900),
  });
  return {
    database,
    repository: new ImportRepository(database, { now: () => timestamp }),
  };
}

function createBatch(
  repository: ImportRepository,
  batchNumber = 1,
  jobNumbers = [1, 2],
) {
  return repository.createBatch({
    batchId: id(batchNumber),
    snapshotAt: timestamp,
    entries: jobNumbers.map((jobNumber, ordinal) => ({
      jobId: id(jobNumber + 100),
      ordinal,
      originalFilename: `source-${ordinal}.jpg`,
      sourceRelativePath: `Inbox/source-${ordinal}.jpg`,
    })),
  });
}

function revision(database: CatalogDatabase): bigint {
  return (
    database
      .prepare("SELECT catalog_revision FROM app_state WHERE singleton = 1")
      .get() as {
      catalog_revision: bigint;
    }
  ).catalog_revision;
}

function insertVerifiedPhoto(database: CatalogDatabase, photoId: number): void {
  const hash = Buffer.from(hashHex, "hex");
  database
    .prepare(
      `INSERT INTO photos (
        photo_id, original_filename, source_format, lifecycle_state, integrity_state, flagged,
        width, height, display_orientation, source_sha256, current_file_sha256,
        image_data_sha256, observed_size_bytes, observed_mtime_ns, content_revision,
        desired_metadata_revision, synced_metadata_revision, embedded_thumbnail_status,
        thumbnail_state, thumbnail_revision, imported_at, updated_at
      ) VALUES (?, 'source-1.jpg', 'jpeg', 'active', 'clean', 0, 1200, 800, 1, ?, ?, ?,
        1234, 1760000000000000000, 1, 0, 0, 'not_attempted', 'ready', 1, ?, ?)`,
    )
    .run(photoId, hash, hash, hash, timestamp, timestamp);
}

describe("M2A ImportRepository", () => {
  it("defines the M2D final-JPEG commit boundary without creating a photo in M2A", () => {
    expect(
      FinalJpegCatalogCommitInputSchema.safeParse({
        jobId: id(101),
        photoId: 1,
        sourceSha256Hex: hashHex,
        currentFileSha256Hex: hashHex,
        imageDataSha256Hex: hashHex,
        observedSizeBytes: 1234,
        observedMtimeNs: "1760000000000000000",
        width: 1200,
        height: 800,
        displayOrientation: 1,
        importedAt: timestamp,
      }).success,
    ).toBe(true);
    expect(
      FinalJpegCatalogCommitInputSchema.safeParse({
        jobId: id(101),
        photoId: 1,
      }).success,
    ).toBe(false);
  });

  it("creates an ordered snapshot atomically with initial durable job state and one revision", () => {
    const { database, repository } = createRepository();
    const result = createBatch(repository);

    expect(result.catalogRevision).toBe(1);
    expect(result.batch).toMatchObject({
      batchId: id(1),
      state: "queued",
      totalCount: 2,
      completedCount: 0,
      failedCount: 0,
      waitingCount: 0,
    });
    expect(
      result.jobs.map((job) => [
        job.ordinal,
        job.state,
        job.phase,
        job.currentRelativePath,
      ]),
    ).toEqual([
      [0, "queued", "discovered", "Inbox/source-0.jpg"],
      [1, "queued", "discovered", "Inbox/source-1.jpg"],
    ]);
    expect(repository.getBatch({ batchId: id(1) })).toEqual(result.batch);
    expect(
      repository.listJobs({ batchId: id(1) }).map((job) => job.jobId),
    ).toEqual([id(101), id(102)]);
    expect(revision(database)).toBe(1n);

    expect(() =>
      repository.createBatch({
        batchId: id(2),
        snapshotAt: timestamp,
        entries: [
          {
            jobId: id(201),
            ordinal: 0,
            originalFilename: "a.jpg",
            sourceRelativePath: "Inbox/a.jpg",
          },
          {
            jobId: id(202),
            ordinal: 0,
            originalFilename: "b.jpg",
            sourceRelativePath: "Inbox/b.jpg",
          },
        ],
      }),
    ).toThrow(CatalogOperationError);
    expect(() =>
      repository.createBatch({
        batchId: id(3),
        snapshotAt: timestamp,
        entries: [
          {
            jobId: id(301),
            ordinal: 0,
            originalFilename: "a.jpg",
            sourceRelativePath: "Inbox/a.jpg",
          },
          {
            jobId: id(302),
            ordinal: 1,
            originalFilename: "b.jpg",
            sourceRelativePath: "Inbox/a.jpg",
          },
        ],
      }),
    ).toThrow(CatalogOperationError);
    expect(() =>
      repository.createBatch({
        batchId: id(4),
        snapshotAt: timestamp,
        entries: [
          {
            jobId: id(101),
            ordinal: 0,
            originalFilename: "again.jpg",
            sourceRelativePath: "Inbox/again.jpg",
          },
        ],
      }),
    ).toThrow();
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM import_batches").get(),
    ).toEqual({ count: 1n });
    expect(revision(database)).toBe(1n);
    database.close();
  });

  it("enforces legal job transitions, expected state checks, durable counters, and no double counting", () => {
    const { database, repository } = createRepository();
    createBatch(repository);
    const firstJobId = id(101);
    const secondJobId = id(102);

    const waiting = repository.transitionJob({
      jobId: firstJobId,
      expectedState: "queued",
      expectedPhase: "discovered",
      state: "waiting",
      phase: "waiting_stable",
    });
    expect(waiting).toMatchObject({
      catalogRevision: 2,
      batch: {
        state: "running",
        waitingCount: 1,
        completedCount: 0,
        failedCount: 0,
      },
    });
    expect(() =>
      repository.transitionJob({
        jobId: firstJobId,
        expectedState: "queued",
        state: "running",
        phase: "validating",
      }),
    ).toThrow(/expected state or phase/i);
    expect(() =>
      repository.transitionJob({
        jobId: firstJobId,
        state: "completed",
        phase: "terminal",
      }),
    ).toThrow(/not allowed/i);

    expect(
      repository.transitionJob({
        jobId: firstJobId,
        state: "queued",
        phase: "discovered",
      }).batch.waitingCount,
    ).toBe(0);
    repository.transitionJob({
      jobId: firstJobId,
      state: "running",
      phase: "validating",
    });
    const measured = repository.transitionJob({
      jobId: firstJobId,
      state: "running",
      phase: "hashing",
      measurements: {
        detectedFormat: "jpeg",
        sourceSizeBytes: 1234,
        sourceMtimeNs: "1760000000000000000",
        sourceSha256Hex: hashHex,
        candidateWidth: 1200,
        candidateHeight: 800,
        candidateOrientation: 1,
        stagedMetadataJson: '{"source":"synthetic"}',
      },
    });
    expect(measured.job).toMatchObject({
      state: "running",
      phase: "hashing",
      detectedFormat: "jpeg",
      sourceMtimeNs: "1760000000000000000",
      sourceSha256Hex: hashHex,
    });
    for (const [state, phase] of [
      ["running", "duplicate_check"],
      ["running", "id_reserved"],
    ] as const) {
      repository.transitionJob({ jobId: firstJobId, state, phase });
    }
    const moving = repository.transitionJob({
      jobId: firstJobId,
      state: "running",
      phase: "moving",
      currentRelativePath: "Working/Import/source-0.jpg",
    });
    expect(moving.job.currentRelativePath).toBe("Working/Import/source-0.jpg");
    for (const [state, phase] of [
      ["running", "stored_verification"],
      ["running", "thumbnail_generation"],
      ["running", "catalog_commit"],
      ["running", "source_cleanup"],
      ["completed", "terminal"],
    ] as const) {
      repository.transitionJob({ jobId: firstJobId, state, phase });
    }
    const completedRevision = revision(database);
    const repeated = repository.transitionJob({
      jobId: firstJobId,
      state: "completed",
      phase: "terminal",
    });
    expect(repeated.catalogRevision).toBe(Number(completedRevision));
    expect(repeated.batch.completedCount).toBe(1);

    const failed = repository.transitionJob({
      jobId: secondJobId,
      state: "failed",
      phase: "terminal",
      error: { errorClass: "validation", errorCode: "unsupported" },
    });
    expect(failed.batch).toMatchObject({
      state: "paused_error",
      completedCount: 1,
      failedCount: 1,
    });
    const failedRevision = revision(database);
    const repeatedFailure = repository.transitionJob({
      jobId: secondJobId,
      state: "failed",
      phase: "terminal",
    });
    expect(repeatedFailure.catalogRevision).toBe(Number(failedRevision));
    expect(repeatedFailure.batch.failedCount).toBe(1);
    expect(revision(database)).toBe(failedRevision);
    database.close();
  });

  it("persists stop-after-current without changing the active or queued jobs", () => {
    const { database, repository } = createRepository();
    createBatch(repository);
    repository.transitionJob({
      jobId: id(101),
      state: "running",
      phase: "validating",
    });
    const before = repository.listJobs({ batchId: id(1) });
    const stopped = repository.requestStop({ batchId: id(1) });
    expect(stopped).toMatchObject({
      batch: { state: "stopping", requestedStopAt: timestamp },
    });
    expect(repository.listJobs({ batchId: id(1) })).toEqual(before);
    const revisionAfterStop = revision(database);
    expect(repository.requestStop({ batchId: id(1) }).catalogRevision).toBe(
      Number(revisionAfterStop),
    );
    expect(revision(database)).toBe(revisionAfterStop);
    database.close();
  });

  it("reserves permanent import IDs once, commits or abandons them, and never reuses abandoned IDs", () => {
    const { database, repository } = createRepository();
    createBatch(repository);
    const first = repository.reservePhotoId({ jobId: id(101) });
    expect(first.reservation).toMatchObject({
      photoId: 1,
      state: "reserved",
      origin: "import",
    });
    const reservationRevision = revision(database);
    expect(repository.reservePhotoId({ jobId: id(101) })).toEqual({
      reservation: first.reservation,
      catalogRevision: Number(reservationRevision),
    });
    repository.transitionJob({
      jobId: id(101),
      state: "failed",
      phase: "terminal",
      error: { errorClass: "io", errorCode: "simulated" },
    });
    expect(
      repository.abandonReservation({ jobId: id(101) }).reservation,
    ).toMatchObject({
      photoId: 1,
      state: "abandoned",
      abandonedAt: timestamp,
    });

    const second = repository.reservePhotoId({ jobId: id(102) });
    expect(second.reservation.photoId).toBe(2);
    expect(() => repository.commitReservation({ jobId: id(102) })).toThrow(
      /corresponding photo row/i,
    );
    insertVerifiedPhoto(database, second.reservation.photoId);
    expect(
      repository.commitReservation({ jobId: id(102) }).reservation,
    ).toMatchObject({
      photoId: 2,
      state: "committed",
      committedAt: timestamp,
    });
    expect(() => repository.abandonReservation({ jobId: id(102) })).toThrow(
      /terminal/i,
    );
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM id_reservations").get(),
    ).toEqual({ count: 2n });
    database.close();
  });

  it("commits journal intent before later physical work and enforces its durable status lifecycle", () => {
    const { database, repository } = createRepository();
    createBatch(repository);
    const intent = repository.createJournalIntent({
      operationId: id(501),
      operationType: "import_move",
      phase: "move_source_to_storage",
      importJobId: id(101),
      batchId: id(1),
      sourceRelativePath: "Inbox/source-0.jpg",
      targetRelativePath: "Storage/0000000001.jpg",
      expectedSourceSha256Hex: hashHex,
    });
    expect(intent.journal).toMatchObject({
      status: "planned",
      expectedSourceSha256Hex: hashHex,
      sourceRelativePath: "Inbox/source-0.jpg",
    });
    for (const status of [
      "mutating",
      "verifying",
      "cleanup",
      "completed",
    ] as const) {
      repository.transitionJournal({ operationId: id(501), status });
    }
    const completed = repository.transitionJournal({
      operationId: id(501),
      status: "completed",
    });
    expect(completed.journal).toMatchObject({
      status: "completed",
      completedAt: timestamp,
    });
    expect(() =>
      repository.transitionJournal({
        operationId: id(501),
        status: "mutating",
      }),
    ).toThrow(/not allowed/i);

    const reservation = repository.reservePhotoId({ jobId: id(101) });
    const thumbnail = repository.createJournalIntent({
      operationId: id(502),
      operationType: "thumbnail_replace",
      phase: "replace_thumbnail",
      photoId: reservation.reservation.photoId,
      targetRelativePath: "Thumbnails/01/0000000001.jpg",
      expectedTargetSha256Hex: hashHex,
    });
    expect(
      repository.transitionJournal({
        operationId: thumbnail.journal.operationId,
        status: "recovery_required",
        errorClass: "verification",
        errorCode: "ambiguous",
      }).journal,
    ).toMatchObject({ status: "recovery_required", errorCode: "ambiguous" });
    expect(() =>
      repository.createJournalIntent({
        operationId: id(503),
        operationType: "import_move",
        phase: "bad",
        importJobId: id(101),
        batchId: id(1),
        sourceRelativePath: "C:/outside.jpg",
        targetRelativePath: "Storage/0000000001.jpg",
        expectedSourceSha256Hex: hashHex,
      }),
    ).toThrow();
    database.close();
  });
});
