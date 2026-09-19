import { describe, expect, it } from "vitest";
import {
  PhysicalWritePriority,
  PhysicalWriteScheduler,
  type PhysicalWriteTask,
} from "../../src/main/scheduler/physical-write-scheduler";

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function task(
  label: string,
  priority: PhysicalWritePriority,
  run: () => Promise<void> | void,
  photoId?: number,
): PhysicalWriteTask<void> {
  return { label, priority, safeStop: "safe_boundary", photoId, run };
}

describe("M2A PhysicalWriteScheduler", () => {
  it("runs exactly one writer at a time and preserves FIFO order for equal priorities", async () => {
    const scheduler = new PhysicalWriteScheduler();
    const events: string[] = [];
    let active = 0;
    const first = scheduler.submit(
      task("first", PhysicalWritePriority.CURRENT_IMPORT_PHOTO, async () => {
        active += 1;
        events.push(`first-start-${active}`);
        await Promise.resolve();
        events.push(`first-end-${active}`);
        active -= 1;
      }),
    );
    const second = scheduler.submit(
      task("second", PhysicalWritePriority.CURRENT_IMPORT_PHOTO, () => {
        active += 1;
        events.push(`second-start-${active}`);
        active -= 1;
      }),
    );
    const third = scheduler.submit(
      task("third", PhysicalWritePriority.CURRENT_IMPORT_PHOTO, () => {
        active += 1;
        events.push(`third-start-${active}`);
        active -= 1;
      }),
    );

    await Promise.all([first, second, third]);
    expect(events).toEqual([
      "first-start-1",
      "first-end-1",
      "second-start-1",
      "third-start-1",
    ]);
  });

  it("selects the highest priority queued task but never preempts a running critical task", async () => {
    const scheduler = new PhysicalWriteScheduler();
    const releaseCurrent = deferred<void>();
    const events: string[] = [];
    const current = scheduler.submit(
      task(
        "current-import",
        PhysicalWritePriority.CURRENT_IMPORT_PHOTO,
        async () => {
          events.push("current-start");
          await releaseCurrent.promise;
          events.push("current-finish");
        },
        7,
      ),
    );
    const lower = scheduler.submit(
      task("lower", PhysicalWritePriority.THUMBNAIL_MAINTENANCE, () => {
        events.push("lower");
      }),
    );
    const recovery = scheduler.submit(
      task("recovery", PhysicalWritePriority.RECOVERY_REPAIR, () => {
        events.push("recovery");
      }),
    );

    expect(events).toEqual(["current-start"]);
    expect(scheduler.isPhotoOwned(7)).toBe(true);
    releaseCurrent.resolve();
    await Promise.all([current, lower, recovery]);
    expect(events).toEqual([
      "current-start",
      "current-finish",
      "recovery",
      "lower",
    ]);
    expect(scheduler.isPhotoOwned(7)).toBe(false);
  });

  it("releases global and per-photo ownership after failures so later work proceeds", async () => {
    const scheduler = new PhysicalWriteScheduler();
    const events: string[] = [];
    const failed = scheduler.submit(
      task(
        "fails",
        PhysicalWritePriority.CURRENT_IMPORT_PHOTO,
        () => {
          events.push("failed");
          throw new Error("synthetic failure");
        },
        9,
      ),
    );
    const afterFailure = scheduler.submit(
      task(
        "after-failure",
        PhysicalWritePriority.CURRENT_IMPORT_PHOTO,
        () => {
          events.push("after-failure");
        },
        9,
      ),
    );

    await expect(failed).rejects.toThrow("synthetic failure");
    await expect(afterFailure).resolves.toBeUndefined();
    expect(events).toEqual(["failed", "after-failure"]);
    expect(scheduler.isPhotoOwned(9)).toBe(false);
    expect(scheduler.isRunning()).toBe(false);
  });

  it("stops accepting new work while allowing current and already accepted tasks to drain deterministically", async () => {
    const scheduler = new PhysicalWriteScheduler();
    const releaseCurrent = deferred<void>();
    const events: string[] = [];
    const current = scheduler.submit(
      task("current", PhysicalWritePriority.CURRENT_IMPORT_PHOTO, async () => {
        events.push("current-start");
        await releaseCurrent.promise;
        events.push("current-end");
      }),
    );
    const queued = scheduler.submit(
      task("queued", PhysicalWritePriority.BATCH_METADATA_SYNC, () => {
        events.push("queued");
      }),
    );

    const shutdown = scheduler.shutdown();
    expect(scheduler.isAcceptingNewWork()).toBe(false);
    await expect(
      scheduler.submit(
        task("new", PhysicalWritePriority.RECOVERY_REPAIR, () => undefined),
      ),
    ).rejects.toThrow("not accepting new work");
    expect(events).toEqual(["current-start"]);
    releaseCurrent.resolve();
    await Promise.all([current, queued, shutdown]);
    expect(events).toEqual(["current-start", "current-end", "queued"]);
    expect(scheduler.queuedCount()).toBe(0);
  });

  it("validates task ownership inputs without filesystem-specific behavior", async () => {
    const scheduler = new PhysicalWriteScheduler();
    expect(() =>
      scheduler.submit({
        label: "",
        priority: PhysicalWritePriority.CURRENT_IMPORT_PHOTO,
        safeStop: "complete",
        run: () => undefined,
      }),
    ).toThrow("label is required");
    expect(() =>
      scheduler.submit({
        label: "bad-photo",
        priority: PhysicalWritePriority.CURRENT_IMPORT_PHOTO,
        safeStop: "complete",
        photoId: 0,
        run: () => undefined,
      }),
    ).toThrow("positive safe integer");
    await scheduler.whenIdle();
  });
});
