import {
  applyInitialMigration,
  createSessionTables,
  openNewCatalogForSchemaValidation,
  type CatalogDatabase,
} from './migrations/schema';
import {
  CatalogRequestSchema,
  CatalogRequestType,
  type CatalogRequest,
  type CatalogResponse,
} from '../shared/contracts/catalog-process';

interface CatalogProcessDependencies {
  openCatalog: typeof openNewCatalogForSchemaValidation;
  applyMigration: typeof applyInitialMigration;
  createTemporaryTables: typeof createSessionTables;
}

const defaultDependencies: CatalogProcessDependencies = {
  openCatalog: openNewCatalogForSchemaValidation,
  applyMigration: applyInitialMigration,
  createTemporaryTables: createSessionTables,
};

export class CatalogProcessHandler {
  private db: CatalogDatabase | null = null;
  private dbPath: string | null = null;
  private readonly dependencies: CatalogProcessDependencies;

  constructor(
    dependencies: Partial<CatalogProcessDependencies> = {},
    registerExitHandlers = true
  ) {
    this.dependencies = { ...defaultDependencies, ...dependencies };
    if (registerExitHandlers) {
      this.setupExitHandlers();
    }
  }

  public handleRawMessage(rawMessage: unknown): CatalogResponse {
    const parseResult = CatalogRequestSchema.safeParse(rawMessage);

    if (!parseResult.success) {
      const requestId =
        typeof rawMessage === 'object' &&
        rawMessage !== null &&
        'requestId' in rawMessage &&
        typeof (rawMessage as { requestId: unknown }).requestId === 'string'
          ? (rawMessage as { requestId: string }).requestId
          : 'unknown';

      return {
        requestId,
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: `Malformed request payload: ${parseResult.error.message}`,
        },
      };
    }

    return this.dispatchRequest(parseResult.data);
  }

  public closeDatabase(): void {
    if (this.db === null) {
      return;
    }

    try {
      if (this.db.open) {
        this.db.close();
      }
    } finally {
      this.db = null;
      this.dbPath = null;
    }
  }

  private dispatchRequest(request: CatalogRequest): CatalogResponse {
    try {
      switch (request.type) {
        case CatalogRequestType.PING:
          return {
            requestId: request.requestId,
            success: true,
            result: { pong: true, timestamp: new Date().toISOString() },
          };

        case CatalogRequestType.OPEN_TEST_CATALOG:
          return this.openTestCatalog(request);

        case CatalogRequestType.CLOSE_CATALOG:
          if (this.db === null) {
            return {
              requestId: request.requestId,
              success: false,
              error: {
                code: 'NO_CATALOG_OPEN',
                message: 'Cannot close catalog: no catalog is currently open',
              },
            };
          }
          this.closeDatabase();
          return {
            requestId: request.requestId,
            success: true,
            result: { closed: true },
          };
      }
    } catch (error: unknown) {
      return {
        requestId: request.requestId,
        success: false,
        error: {
          code: 'EXECUTION_ERROR',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  private openTestCatalog(
    request: Extract<CatalogRequest, { type: 'openTestCatalog' }>
  ): CatalogResponse {
    if (this.db !== null) {
      return {
        requestId: request.requestId,
        success: false,
        error: {
          code: 'CATALOG_ALREADY_OPEN',
          message: `Catalog is already open at ${this.dbPath}`,
        },
      };
    }

    const { databasePath } = request.payload;
    const database = this.dependencies.openCatalog(databasePath);
    try {
      this.dependencies.applyMigration(database);
      this.dependencies.createTemporaryTables(database);
      const userVersion = Number(database.pragma('user_version', { simple: true }));
      const temporaryTableNames = database
        .prepare("SELECT name FROM sqlite_temp_master WHERE type = 'table' ORDER BY name")
        .pluck()
        .all()
        .map(String);

      this.db = database;
      this.dbPath = databasePath;
      return {
        requestId: request.requestId,
        success: true,
        result: { opened: true, databasePath, userVersion, temporaryTableNames },
      };
    } catch (error) {
      if (database.open) {
        database.close();
      }
      throw error;
    }
  }

  private setupExitHandlers(): void {
    const cleanup = (): void => this.closeDatabase();
    process.on('exit', cleanup);
    process.on('SIGINT', () => {
      cleanup();
      process.exit(0);
    });
    process.on('SIGTERM', () => {
      cleanup();
      process.exit(0);
    });
  }
}

export const handler = new CatalogProcessHandler();

if (process.parentPort) {
  process.parentPort.on('message', (event) => {
    process.parentPort?.postMessage(handler.handleRawMessage(event.data));
  });
}
