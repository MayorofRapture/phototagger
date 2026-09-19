export const PhysicalWritePriority = {
  RECOVERY_REPAIR: 1,
  USER_RESTORE_OR_CONFLICT_RESOLUTION: 2,
  CURRENT_IMPORT_PHOTO: 3,
  INTERACTIVE_METADATA_SYNC: 4,
  BATCH_METADATA_SYNC: 5,
  THUMBNAIL_MAINTENANCE: 6,
  AUTOMATIC_BACKUP: 7,
} as const;

export type PhysicalWritePriority =
  (typeof PhysicalWritePriority)[keyof typeof PhysicalWritePriority];

/** A task may finish fully or stop only at a boundary it declares safe. */
export type PhysicalWriteSafeStop = "complete" | "safe_boundary";

export interface PhysicalWriteTask<T> {
  label: string;
  priority: PhysicalWritePriority;
  safeStop: PhysicalWriteSafeStop;
  /** Optional durable photo identity for the explicit per-photo ownership guard. */
  photoId?: number;
  run: () => Promise<T> | T;
}

interface QueuedTask<T> {
  sequence: number;
  task: PhysicalWriteTask<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

/**
 * Process-local coordinator for application-owned physical writers.
 * It deliberately has no filesystem knowledge and never persists its queue.
 */
export class PhysicalWriteScheduler {
  private readonly queue: QueuedTask<unknown>[] = [];
  private readonly ownedPhotoIds = new Set<number>();
  private acceptingNewWork = true;
  private running = false;
  private sequence = 0;
  private idleResolvers: Array<() => void> = [];

  public submit<T>(task: PhysicalWriteTask<T>): Promise<T> {
    this.assertTask(task);
    if (!this.acceptingNewWork) {
      return Promise.reject(
        new Error("Physical-write scheduler is not accepting new work"),
      );
    }
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        sequence: this.sequence++,
        task,
        resolve,
        reject,
      } as QueuedTask<unknown>);
      this.startNext();
    });
  }

  /** Refuses future submissions and drains already accepted work without preemption. */
  public stopAcceptingNewWork(): void {
    this.acceptingNewWork = false;
    this.resolveIdleIfNeeded();
  }

  /** Controlled shutdown waits for the current critical operation and accepted queue. */
  public async shutdown(): Promise<void> {
    this.stopAcceptingNewWork();
    await this.whenIdle();
  }

  public whenIdle(): Promise<void> {
    if (!this.running && this.queue.length === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.idleResolvers.push(resolve));
  }

  public isAcceptingNewWork(): boolean {
    return this.acceptingNewWork;
  }

  public isRunning(): boolean {
    return this.running;
  }

  public queuedCount(): number {
    return this.queue.length;
  }

  public isPhotoOwned(photoId: number): boolean {
    return this.ownedPhotoIds.has(photoId);
  }

  private startNext(): void {
    if (this.running) {
      return;
    }
    const queued = this.takeNext();
    if (!queued) {
      this.resolveIdleIfNeeded();
      return;
    }
    this.running = true;
    const photoId = queued.task.photoId;
    if (photoId !== undefined) {
      if (this.ownedPhotoIds.has(photoId)) {
        queued.reject(
          new Error(`Physical-write task cannot acquire photo ${photoId}`),
        );
        this.running = false;
        this.startNext();
        return;
      }
      this.ownedPhotoIds.add(photoId);
    }
    void this.runTask(queued, photoId);
  }

  private async runTask(
    queued: QueuedTask<unknown>,
    photoId: number | undefined,
  ): Promise<void> {
    try {
      const value = await queued.task.run();
      queued.resolve(value);
    } catch (error) {
      queued.reject(error);
    } finally {
      if (photoId !== undefined) {
        this.ownedPhotoIds.delete(photoId);
      }
      this.running = false;
      this.startNext();
    }
  }

  private takeNext(): QueuedTask<unknown> | undefined {
    if (this.queue.length === 0) {
      return undefined;
    }
    let nextIndex = 0;
    for (let index = 1; index < this.queue.length; index += 1) {
      const candidate = this.queue[index];
      const current = this.queue[nextIndex];
      if (
        candidate.task.priority < current.task.priority ||
        (candidate.task.priority === current.task.priority &&
          candidate.sequence < current.sequence)
      ) {
        nextIndex = index;
      }
    }
    return this.queue.splice(nextIndex, 1)[0];
  }

  private assertTask(task: PhysicalWriteTask<unknown>): void {
    if (task.label.length === 0) {
      throw new Error("Physical-write task label is required");
    }
    if (!Object.values(PhysicalWritePriority).includes(task.priority)) {
      throw new Error("Physical-write task priority is invalid");
    }
    if (task.safeStop !== "complete" && task.safeStop !== "safe_boundary") {
      throw new Error("Physical-write task safe-stop policy is invalid");
    }
    if (
      task.photoId !== undefined &&
      (!Number.isSafeInteger(task.photoId) || task.photoId <= 0)
    ) {
      throw new Error(
        "Physical-write task photo ID must be a positive safe integer",
      );
    }
  }

  private resolveIdleIfNeeded(): void {
    if (this.running || this.queue.length > 0) {
      return;
    }
    for (const resolve of this.idleResolvers.splice(0)) {
      resolve();
    }
  }
}
