import { z } from 'zod';

export const getBootstrapSchema = z.object({}).strict().optional();

export const getVersionSchema = z.object({}).strict().optional();

export const openFolderSchema = z.object({
  folderName: z.enum(['Inbox', 'Storage', 'Trash', 'Failed', 'Recovery', 'Logs', 'Backups']),
});

export type OpenFolderInput = z.infer<typeof openFolderSchema>;
