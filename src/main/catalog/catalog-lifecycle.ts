import path from 'path';
import type { Logger } from 'pino';
import type { CollectionPaths } from '../bootstrap/collection';
import type { OpenCatalogResult, PingResult } from '../../shared/contracts/catalog-process';

export interface CatalogLifecycleClient {
  start(): void;
  ping(): Promise<PingResult>;
  openCatalog(databasePath: string): Promise<OpenCatalogResult>;
  stop(): Promise<void>;
}

export function resolveCatalogPath(collectionPaths: CollectionPaths): string {
  return path.join(collectionPaths.data, 'catalog.sqlite');
}

export class CatalogLifecycle {
  private startAttempted = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(
    private readonly client: CatalogLifecycleClient,
    private readonly logger: Pick<Logger, 'info' | 'error'>
  ) {}

  public async start(collectionPaths: CollectionPaths): Promise<OpenCatalogResult> {
    if (this.startAttempted) {
      throw new Error('Catalog lifecycle startup has already been attempted');
    }
    this.startAttempted = true;

    this.logger.info('Starting catalog utility process');
    try {
      this.client.start();
      await this.client.ping();
      this.logger.info('Opening production catalog');
      const result = await this.client.openCatalog(resolveCatalogPath(collectionPaths));
      this.logger.info(
        { created: result.created, schemaVersion: result.userVersion },
        'Production catalog opened successfully'
      );
      return result;
    } catch (error) {
      this.logger.error({ err: error }, 'Catalog startup failed');
      await this.stop();
      throw error;
    }
  }

  public stop(): Promise<void> {
    if (this.shutdownPromise === null) {
      this.shutdownPromise = this.performShutdown();
    }
    return this.shutdownPromise;
  }

  private async performShutdown(): Promise<void> {
    this.logger.info('Shutting down catalog utility process');
    try {
      await this.client.stop();
      this.logger.info('Catalog utility process stopped');
    } catch (error) {
      this.logger.error({ err: error }, 'Catalog shutdown failed');
    }
  }
}
