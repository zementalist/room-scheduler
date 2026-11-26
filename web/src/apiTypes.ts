export type { RoomBody, SemesterBody } from '../../shared/engine.ts';
export type { Diagnostic } from '../../shared/importPlan.ts';
import type { Diagnostic } from '../../shared/importPlan.ts';

export interface Summary {
  rooms: number;
  schedule: number;
  events: number;
}

export interface ImportPreview {
  token: string;
  mode: 'merge' | 'replace';
  semester: { id: string; name: string } | null;
  sheets: number;
  recognisedColumns: Record<string, string>;
  ignoredColumns: string[];
  ignoredSheets: { sheet: string; reason: string }[];
  rooms: { new: number; updated: number };
  reservations: { valid: number; duplicates: number; skipped: number; conflicts: number };
  removal: { rooms: number; reservations: number };
  skipped: Diagnostic[];
  conflicts: Diagnostic[];
  truncated: boolean;
}
