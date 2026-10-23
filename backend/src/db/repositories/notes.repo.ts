import type { Queryable } from './candles.repo.js';

export const NOTE_AUTHORS = ['claude', 'user'] as const;

export type NoteAuthor = (typeof NOTE_AUTHORS)[number];

export const MAX_NOTES_LIMIT = 500;

export interface NoteInput {
  author: NoteAuthor;
  assetTags: readonly string[];
  bodyMd: string;
  sourceDocumentIds: readonly string[];
}

export interface StoredNote extends NoteInput {
  id: string;
  createdAt: number;
  updatedAt: number;
}

export interface NotesQuery {
  /** Solo notas con alguna de estas etiquetas. Sin ellas, todas. */
  assets?: readonly string[] | undefined;
  author?: NoteAuthor | undefined;
  limit?: number | undefined;
}

export interface NotesRepository {
  createNote(note: NoteInput): Promise<StoredNote>;
  getNotes(query?: NotesQuery): Promise<StoredNote[]>;
}

const INSERT_SQL = `
  INSERT INTO notes (author, asset_tags, body_md, source_document_ids)
  VALUES ($1, $2::text[], $3, $4::uuid[])
  RETURNING id::text AS id, author, asset_tags, body_md, source_document_ids::text[],
            created_at, updated_at
`;

const SELECT_SQL = `
  SELECT id::text AS id, author, asset_tags, body_md, source_document_ids::text[],
         created_at, updated_at
  FROM notes
  WHERE ($1::text[] IS NULL OR asset_tags && $1::text[])
    AND ($2::text IS NULL OR author = $2)
  ORDER BY created_at DESC, id
  LIMIT $3
`;

interface Row {
  id: string;
  author: string;
  asset_tags: string[];
  body_md: string;
  source_document_ids: string[];
  created_at: Date;
  updated_at: Date;
}

function toStoredNote(row: Row): StoredNote {
  return {
    id: row.id,
    // El CHECK de la tabla garantiza que solo puede ser uno de los dos.
    author: row.author as NoteAuthor,
    assetTags: row.asset_tags,
    bodyMd: row.body_md,
    sourceDocumentIds: row.source_document_ids,
    createdAt: row.created_at.getTime(),
    updatedAt: row.updated_at.getTime(),
  };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return MAX_NOTES_LIMIT;
  return Math.min(Math.max(1, Math.trunc(limit)), MAX_NOTES_LIMIT);
}

export function createNotesRepository(db: Queryable): NotesRepository {
  return {
    async createNote(note: NoteInput): Promise<StoredNote> {
      const { rows } = await db.query<Row>(INSERT_SQL, [
        note.author,
        [...note.assetTags],
        note.bodyMd,
        [...note.sourceDocumentIds],
      ]);

      const row = rows[0];
      if (row === undefined) throw new Error('el INSERT de la nota no devolvio fila');
      return toStoredNote(row);
    },

    async getNotes(query: NotesQuery = {}): Promise<StoredNote[]> {
      const { rows } = await db.query<Row>(SELECT_SQL, [
        query.assets === undefined || query.assets.length === 0 ? null : [...query.assets],
        query.author ?? null,
        clampLimit(query.limit),
      ]);
      return rows.map(toStoredNote);
    },
  };
}
