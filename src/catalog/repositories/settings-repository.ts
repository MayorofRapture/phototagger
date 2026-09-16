import { z } from 'zod';
import type { CatalogDatabase } from '../migrations/schema';

const JPEG_QUALITY_KEY = 'conversion.jpegQuality';
const ALPHA_BACKGROUND_KEY = 'conversion.alphaBackground';
const DEFAULT_ORDER_KEY = 'library.defaultOrder';
const WARNING_THRESHOLD_KEY = 'batch.warningThreshold';

const jpegQualitySchema = z.number().int().min(1).max(100);
const alphaBackgroundSchema = z.string().length(7).regex(/^#[0-9a-fA-F]{6}$/);
const defaultOrderSchema = z.enum([
  'newest-imported',
  'oldest-imported',
  'original-filename-asc',
  'original-filename-desc',
]);
const warningThresholdSchema = z.number().int().min(1).max(100000);

export const GeneralSettingsSchema = z.object({
  jpegQuality: jpegQualitySchema,
  alphaBackground: alphaBackgroundSchema,
  defaultOrder: defaultOrderSchema,
  warningThreshold: warningThresholdSchema,
}).strict();

export type GeneralSettings = z.infer<typeof GeneralSettingsSchema>;

export const GeneralSettingsDefaults: GeneralSettings = {
  jpegQuality: 92,
  alphaBackground: '#ffffff',
  defaultOrder: 'newest-imported',
  warningThreshold: 500,
};

export const GeneralSettingsPatchSchema = GeneralSettingsSchema.partial()
  .strict()
  .superRefine((patch, context) => {
    if (Object.keys(patch).length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'At least one general setting must be supplied',
      });
    }

    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: 'Setting values cannot be undefined',
        });
      }
    }
  });

export type GeneralSettingsPatch = z.infer<typeof GeneralSettingsPatchSchema>;

export type SettingsWarningReason = 'missing' | 'invalid value';

export interface SettingsWarning {
  key: string;
  reason: SettingsWarningReason;
}

export interface ReadGeneralSettingsResult {
  settings: GeneralSettings;
  warnings: SettingsWarning[];
}

export interface UpdateGeneralSettingsResult {
  settings: GeneralSettings;
  catalogRevision: bigint;
}

export interface SettingsRepositoryOptions {
  now?: () => string;
}

type GeneralSettingProperty = keyof GeneralSettings;

interface SettingDefinition {
  property: GeneralSettingProperty;
  key: string;
  defaultValue: GeneralSettings[GeneralSettingProperty];
  schema: z.ZodType<unknown>;
}

const settingDefinitions: readonly SettingDefinition[] = [
  {
    property: 'jpegQuality',
    key: JPEG_QUALITY_KEY,
    defaultValue: GeneralSettingsDefaults.jpegQuality,
    schema: jpegQualitySchema,
  },
  {
    property: 'alphaBackground',
    key: ALPHA_BACKGROUND_KEY,
    defaultValue: GeneralSettingsDefaults.alphaBackground,
    schema: alphaBackgroundSchema,
  },
  {
    property: 'defaultOrder',
    key: DEFAULT_ORDER_KEY,
    defaultValue: GeneralSettingsDefaults.defaultOrder,
    schema: defaultOrderSchema,
  },
  {
    property: 'warningThreshold',
    key: WARNING_THRESHOLD_KEY,
    defaultValue: GeneralSettingsDefaults.warningThreshold,
    schema: warningThresholdSchema,
  },
];

const settingKeys = settingDefinitions.map((definition) => definition.key);

interface LoadedSettings {
  result: ReadGeneralSettingsResult;
  stored: Map<GeneralSettingProperty, StoredSetting>;
}

interface StoredSetting {
  valid: boolean;
  value: unknown;
}

interface SettingsRow {
  key: string;
  value_json: string;
}

interface AppStateRow {
  catalog_revision: bigint | number;
}

export class SettingsRepository {
  private readonly now: () => string;

  constructor(
    private readonly database: CatalogDatabase,
    options: SettingsRepositoryOptions = {}
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public readGeneralSettings(): ReadGeneralSettingsResult {
    return this.loadSettings().result;
  }

  public updateGeneralSettings(patch: unknown): UpdateGeneralSettingsResult {
    const parsedPatch = GeneralSettingsPatchSchema.safeParse(patch);
    if (!parsedPatch.success) {
      throw new Error(`Invalid general settings patch: ${parsedPatch.error.message}`);
    }

    const update = this.database.transaction(() => {
      const catalogRevision = this.readCatalogRevision();
      const loaded = this.loadSettings();
      const changedDefinitions = settingDefinitions.filter((definition) => {
        if (!Object.prototype.hasOwnProperty.call(parsedPatch.data, definition.property)) {
          return false;
        }

        const stored = loaded.stored.get(definition.property);
        const proposedValue = parsedPatch.data[definition.property];
        return !stored?.valid || !Object.is(stored.value, proposedValue);
      });

      if (changedDefinitions.length === 0) {
        return {
          settings: loaded.result.settings,
          catalogRevision,
        };
      }

      const updatedAt = this.now();
      const upsertSetting = this.database.prepare(`
        INSERT INTO settings (key, value_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
      `);

      for (const definition of changedDefinitions) {
        const value = parsedPatch.data[definition.property];
        const valueJson = JSON.stringify(value);
        if (valueJson === undefined) {
          throw new Error(`Setting ${definition.key} cannot be serialized`);
        }
        upsertSetting.run(definition.key, valueJson, updatedAt);
      }

      const revisionUpdate = this.database
        .prepare(`UPDATE app_state
          SET catalog_revision = catalog_revision + 1
          WHERE singleton = 1`)
        .run();
      if (revisionUpdate.changes !== 1) {
        throw new Error('Settings update requires the app_state singleton');
      }

      const updatedSettings = this.loadSettings().result.settings;
      return {
        settings: updatedSettings,
        catalogRevision: catalogRevision + 1n,
      };
    });

    return update.immediate();
  }

  private readCatalogRevision(): bigint {
    const row = this.database
      .prepare('SELECT catalog_revision FROM app_state WHERE singleton = 1')
      .get() as AppStateRow | undefined;
    if (!row) {
      throw new Error('Settings update requires the app_state singleton');
    }
    return BigInt(row.catalog_revision);
  }

  private loadSettings(): LoadedSettings {
    const rows = this.database
      .prepare(`SELECT key, value_json FROM settings
        WHERE key IN (?, ?, ?, ?)`)
      .all(...settingKeys) as SettingsRow[];
    const rowByKey = new Map(rows.map((row) => [row.key, row.value_json]));
    const settings: Record<GeneralSettingProperty, unknown> = {} as Record<
      GeneralSettingProperty,
      unknown
    >;
    const warnings: SettingsWarning[] = [];
    const stored = new Map<GeneralSettingProperty, StoredSetting>();

    for (const definition of settingDefinitions) {
      const valueJson = rowByKey.get(definition.key);
      if (valueJson === undefined) {
        settings[definition.property] = definition.defaultValue;
        stored.set(definition.property, { valid: false, value: undefined });
        warnings.push({ key: definition.key, reason: 'missing' });
        continue;
      }

      let decodedValue: unknown;
      try {
        decodedValue = JSON.parse(valueJson);
      } catch {
        decodedValue = undefined;
      }

      const parsedValue = definition.schema.safeParse(decodedValue);
      if (!parsedValue.success) {
        settings[definition.property] = definition.defaultValue;
        stored.set(definition.property, { valid: false, value: undefined });
        warnings.push({ key: definition.key, reason: 'invalid value' });
        continue;
      }

      settings[definition.property] = parsedValue.data;
      stored.set(definition.property, { valid: true, value: parsedValue.data });
    }

    return {
      result: {
        settings: settings as GeneralSettings,
        warnings,
      },
      stored,
    };
  }
}
