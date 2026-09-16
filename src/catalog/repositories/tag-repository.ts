import type { CatalogDatabase } from '../migrations/schema';
import { normalizeTagPath } from '../tags/tag-normalization';

export interface TagDto {
  tagId: number;
  parentTagId: number | null;
  displayName: string;
  normalizedKey: string;
  legacyFlatOnly: boolean;
  pathDisplay: string;
  pathKey: string;
  leafKey: string;
  depth: number;
}

export interface ResolveOrCreatePathResult {
  path: TagDto[];
  created: boolean;
  catalogRevision: bigint;
}

export interface TagRepositoryOptions {
  now?: () => string;
}

interface TagRow {
  tag_id: unknown;
  parent_tag_id: unknown;
  display_name: unknown;
  normalized_key: unknown;
  legacy_flat_only: unknown;
  path_display: unknown;
  path_key: unknown;
  leaf_key: unknown;
  depth: unknown;
}

interface ClosureRow {
  ancestor_tag_id: unknown;
  depth: unknown;
}

interface AppStateRow {
  catalog_revision: unknown;
}

interface PathNode {
  tagId: number;
  displayName: string;
  normalizedKey: string;
  pathDisplay: string;
  pathKey: string;
  depth: number;
}

function safeInteger(value: unknown, field: string): number {
  const numericValue = typeof value === 'bigint' ? Number(value) : value;
  if (typeof numericValue !== 'number' || !Number.isSafeInteger(numericValue)) {
    throw new Error(`${field} is not a safe integer`);
  }
  return numericValue;
}

function safeTagId(value: unknown, field = 'tag_id'): number {
  const id = safeInteger(value, field);
  if (id <= 0) {
    throw new Error(`${field} must be positive`);
  }
  return id;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${field} is not text`);
  }
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  const numericValue = safeInteger(value, field);
  if (numericValue !== 0 && numericValue !== 1) {
    throw new Error(`${field} must be 0 or 1`);
  }
  return numericValue === 1;
}

function requireTagRow(row: TagRow): TagDto {
  const tagId = safeTagId(row.tag_id);
  const parentTagId = row.parent_tag_id === null ? null : safeTagId(row.parent_tag_id, 'parent_tag_id');
  const depth = safeInteger(row.depth, 'tag_paths.depth');
  if (depth < 1 || depth > 12) {
    throw new Error('tag_paths.depth is outside the supported range');
  }
  return {
    tagId,
    parentTagId,
    displayName: requireText(row.display_name, 'tags.display_name'),
    normalizedKey: requireText(row.normalized_key, 'tags.normalized_key'),
    legacyFlatOnly: requireBoolean(row.legacy_flat_only, 'tags.legacy_flat_only'),
    pathDisplay: requireText(row.path_display, 'tag_paths.path_display'),
    pathKey: requireText(row.path_key, 'tag_paths.path_key'),
    leafKey: requireText(row.leaf_key, 'tag_paths.leaf_key'),
    depth,
  };
}

export class TagRepository {
  private readonly now: () => string;

  constructor(
    private readonly database: CatalogDatabase,
    options: TagRepositoryOptions = {}
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** Resolves a normal slash-delimited path, creating only missing tags. */
  public resolveOrCreatePath(path: string): ResolveOrCreatePathResult {
    const normalizedPath = normalizeTagPath(path);
    const resolve = this.database.transaction(() => {
      const catalogRevision = this.readCatalogRevision();
      const nodes: PathNode[] = [];
      let parentTagId: number | null = null;
      let created = false;
      let timestamp: string | undefined;

      for (const segment of normalizedPath.segments) {
        const existing = this.findSibling(parentTagId, segment.normalizedKey);
        if (existing) {
          const dto = this.readTagDto(existing.tag_id);
          if (dto.legacyFlatOnly) {
            throw new Error('legacy flat-only tags cannot participate in normal paths');
          }
          const expectedPathDisplay = nodes.length === 0
            ? dto.displayName
            : `${nodes[nodes.length - 1].pathDisplay}/${dto.displayName}`;
          const expectedPathKey = nodes.length === 0
            ? dto.normalizedKey
            : `${nodes[nodes.length - 1].pathKey}/${dto.normalizedKey}`;
          this.validateExistingNode(dto, nodes, expectedPathDisplay, expectedPathKey);
          nodes.push({
            tagId: dto.tagId,
            displayName: dto.displayName,
            normalizedKey: dto.normalizedKey,
            pathDisplay: dto.pathDisplay,
            pathKey: dto.pathKey,
            depth: dto.depth,
          });
          parentTagId = dto.tagId;
          continue;
        }

        if (timestamp === undefined) {
          timestamp = this.now();
        }
        const inserted = this.database.prepare(`
          INSERT INTO tags (
            parent_tag_id, display_name, normalized_key, legacy_flat_only,
            created_at, updated_at
          ) VALUES (?, ?, ?, 0, ?, ?)
        `).run(parentTagId, segment.displayName, segment.normalizedKey, timestamp, timestamp);
        const tagId = safeTagId(inserted.lastInsertRowid, 'last_insert_rowid');
        const pathDisplay = nodes.length === 0
          ? segment.displayName
          : `${nodes[nodes.length - 1].pathDisplay}/${segment.displayName}`;
        const pathKey = nodes.length === 0
          ? segment.normalizedKey
          : `${nodes[nodes.length - 1].pathKey}/${segment.normalizedKey}`;

        const insertClosure = this.database.prepare(
          'INSERT INTO tag_closure (ancestor_tag_id, descendant_tag_id, depth) VALUES (?, ?, ?)'
        );
        for (let index = 0; index < nodes.length; index += 1) {
          insertClosure.run(nodes[index].tagId, tagId, nodes.length - index);
        }
        insertClosure.run(tagId, tagId, 0);
        this.database.prepare(`
          INSERT INTO tag_paths (tag_id, path_display, path_key, leaf_key, depth, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(tagId, pathDisplay, pathKey, segment.normalizedKey, nodes.length + 1, timestamp);

        nodes.push({
          tagId,
          displayName: segment.displayName,
          normalizedKey: segment.normalizedKey,
          pathDisplay,
          pathKey,
          depth: nodes.length + 1,
        });
        parentTagId = tagId;
        created = true;
      }

      if (created) {
        this.validateAffectedNodes(nodes);
        const revisionUpdate = this.database.prepare(`
          UPDATE app_state
          SET catalog_revision = catalog_revision + 1
          WHERE singleton = 1
        `).run();
        if (revisionUpdate.changes !== 1) {
          throw new Error('Tag creation requires the app_state singleton');
        }
      }

      return {
        path: nodes.map((node) => this.readTagDto(node.tagId)),
        created,
        catalogRevision: created ? catalogRevision + 1n : catalogRevision,
      };
    });

    return resolve.immediate();
  }

  public getTagById(tagId: number): TagDto | null {
    const safeId = safeTagId(tagId, 'tagId');
    const row = this.database.prepare(`
      SELECT t.tag_id, t.parent_tag_id, t.display_name, t.normalized_key,
             t.legacy_flat_only, p.path_display, p.path_key, p.leaf_key, p.depth
      FROM tags AS t
      LEFT JOIN tag_paths AS p ON p.tag_id = t.tag_id
      WHERE t.tag_id = ?
    `).get(safeId) as TagRow | undefined;
    if (!row) {
      return null;
    }
    if (row.path_display === null || row.path_key === null || row.leaf_key === null || row.depth === null) {
      throw new Error('Tag is missing its required tag_paths row');
    }
    return requireTagRow(row);
  }

  public listChildren(parentTagId: number | null): TagDto[] {
    const safeParentId = parentTagId === null ? null : safeTagId(parentTagId, 'parentTagId');
    const rows = safeParentId === null
      ? this.database.prepare(`
          SELECT t.tag_id, t.parent_tag_id, t.display_name, t.normalized_key,
                 t.legacy_flat_only, p.path_display, p.path_key, p.leaf_key, p.depth
          FROM tags AS t
          LEFT JOIN tag_paths AS p ON p.tag_id = t.tag_id
          WHERE t.parent_tag_id IS NULL
          ORDER BY t.normalized_key, t.display_name, t.tag_id
        `).all()
      : this.database.prepare(`
          SELECT t.tag_id, t.parent_tag_id, t.display_name, t.normalized_key,
                 t.legacy_flat_only, p.path_display, p.path_key, p.leaf_key, p.depth
          FROM tags AS t
          LEFT JOIN tag_paths AS p ON p.tag_id = t.tag_id
          WHERE t.parent_tag_id = ?
          ORDER BY t.normalized_key, t.display_name, t.tag_id
        `).all(safeParentId);
    return (rows as TagRow[]).map((row) => {
      if (row.path_display === null || row.path_key === null || row.leaf_key === null || row.depth === null) {
        throw new Error('Tag is missing its required tag_paths row');
      }
      return requireTagRow(row);
    });
  }

  private readCatalogRevision(): bigint {
    const row = this.database.prepare(
      'SELECT catalog_revision FROM app_state WHERE singleton = 1'
    ).get() as AppStateRow | undefined;
    if (!row) {
      throw new Error('Tag creation requires the app_state singleton');
    }
    const revision = row.catalog_revision;
    if (typeof revision === 'bigint') {
      if (revision < 0n) {
        throw new Error('app_state.catalog_revision must not be negative');
      }
      return revision;
    }
    return BigInt(safeInteger(revision, 'catalog_revision'));
  }

  private findSibling(parentTagId: number | null, normalizedKey: string): { tag_id: unknown } | undefined {
    if (parentTagId === null) {
      return this.database.prepare(`
        SELECT tag_id FROM tags WHERE parent_tag_id IS NULL AND normalized_key = ?
      `).get(normalizedKey) as { tag_id: unknown } | undefined;
    }
    return this.database.prepare(`
      SELECT tag_id FROM tags WHERE parent_tag_id = ? AND normalized_key = ?
    `).get(parentTagId, normalizedKey) as { tag_id: unknown } | undefined;
  }

  private readTagDto(tagId: unknown): TagDto {
    const row = this.database.prepare(`
      SELECT t.tag_id, t.parent_tag_id, t.display_name, t.normalized_key,
             t.legacy_flat_only, p.path_display, p.path_key, p.leaf_key, p.depth
      FROM tags AS t
      LEFT JOIN tag_paths AS p ON p.tag_id = t.tag_id
      WHERE t.tag_id = ?
    `).get(safeTagId(tagId)) as TagRow | undefined;
    if (!row || row.path_display === null || row.path_key === null || row.leaf_key === null || row.depth === null) {
      throw new Error('Tag is missing its required tag_paths row');
    }
    return requireTagRow(row);
  }

  private validateExistingNode(
    dto: TagDto,
    priorNodes: PathNode[],
    expectedPathDisplay: string,
    expectedPathKey: string
  ): void {
    if (dto.normalizedKey !== expectedPathKey.slice(expectedPathKey.lastIndexOf('/') + 1)) {
      throw new Error(`Tag ${dto.tagId} has an inconsistent normalized key`);
    }
    if (dto.parentTagId !== (priorNodes.length === 0 ? null : priorNodes[priorNodes.length - 1].tagId)) {
      throw new Error(`Tag ${dto.tagId} has an inconsistent parent`);
    }
    if (
      dto.pathDisplay !== expectedPathDisplay ||
      dto.pathKey !== expectedPathKey ||
      dto.leafKey !== dto.normalizedKey ||
      dto.depth !== priorNodes.length + 1
    ) {
      throw new Error(`Tag ${dto.tagId} has inconsistent tag_paths data`);
    }

    const expectedAncestors = [...priorNodes.map((node) => node.tagId), dto.tagId];
    const closureRows = this.database.prepare(`
      SELECT ancestor_tag_id, depth
      FROM tag_closure
      WHERE descendant_tag_id = ?
      ORDER BY depth
    `).all(dto.tagId) as ClosureRow[];
    if (closureRows.length !== expectedAncestors.length) {
      throw new Error(`Tag ${dto.tagId} has incomplete tag_closure data`);
    }
    for (let index = 0; index < expectedAncestors.length; index += 1) {
      if (
        safeTagId(closureRows[index].ancestor_tag_id, 'ancestor_tag_id') !==
          expectedAncestors[expectedAncestors.length - index - 1] ||
        safeInteger(closureRows[index].depth, 'tag_closure.depth') !== index
      ) {
        throw new Error(`Tag ${dto.tagId} has inconsistent tag_closure data`);
      }
    }
  }

  private validateAffectedNodes(nodes: PathNode[]): void {
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      const dto = this.readTagDto(node.tagId);
      if (
        dto.displayName !== node.displayName ||
        dto.normalizedKey !== node.normalizedKey ||
        dto.pathDisplay !== node.pathDisplay ||
        dto.pathKey !== node.pathKey ||
        dto.depth !== node.depth ||
        dto.legacyFlatOnly
      ) {
        throw new Error(`Tag ${node.tagId} has inconsistent created state`);
      }
      const priorNodes = nodes.slice(0, index);
      this.validateExistingNode(dto, priorNodes, node.pathDisplay, node.pathKey);
    }
  }
}
