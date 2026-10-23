import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MCP_MAX_RESULTS, MCP_SNIPPET_CHARS, MCP_TOOL_NAMES } from '@tt/shared';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import { createCandlesRepository } from '../db/repositories/candles.repo.js';
import { createDerivativesRepository } from '../db/repositories/derivatives.repo.js';
import { createDocumentsRepository } from '../db/repositories/documents.repo.js';
import { createEventsRepository } from '../db/repositories/events.repo.js';
import { createMacroRepository } from '../db/repositories/macro.repo.js';
import { createNotesRepository } from '../db/repositories/notes.repo.js';
import { createLogger } from '../observability/logger.js';
import { buildMcpDeps } from '../roles/mcp.js';
import { createScratchDatabase, type ScratchDatabase } from '../testing/scratch-db.js';
import { VAULT_FOLDER } from '../brain/export/obsidian.js';
import { buildMcpServer } from './server.js';

/**
 * Datos SINTETICOS, generados aqui a proposito (CLAUDE.md §2: nada de inventar datos de mercado
 * fuera de un fixture explicito).
 *
 * El dia analizado es el 2026-10-20. Lo importante es `AYER`: hay un documento publicado ese mismo
 * dia pero **descargado dos dias despues**, que es lo que un contexto point-in-time no puede ver.
 */
const DIA = Date.UTC(2026, 9, 20);
const DIA_FIN = DIA + 86_399_999;
const AHORA = Date.UTC(2026, 9, 25);

const DOCUMENTOS = [
  {
    source: 'oilprice',
    url: 'https://example.test/crude-build',
    title: 'Crude inventories build as refiners slow',
    body: `Brent slipped after the weekly petroleum report. ${'El informe detalla la acumulacion de crudo. '.repeat(40)}`,
    publishedAt: DIA + 9 * 3_600_000,
    publishedAtEstimated: false,
    fetchedAt: DIA + 10 * 3_600_000,
    lang: 'en',
  },
  {
    source: 'coindesk',
    url: 'https://example.test/bitcoin-etf',
    title: 'Bitcoin ETF inflows continue',
    body: 'Bitcoin spot ETFs took in more cash while funding stayed positive.',
    publishedAt: DIA + 11 * 3_600_000,
    publishedAtEstimated: false,
    fetchedAt: DIA + 12 * 3_600_000,
    lang: 'en',
  },
  {
    // Publicado ese dia, descargado dos dias despues: la trampa del look-ahead.
    source: 'oilprice',
    url: 'https://example.test/revision-posterior',
    title: 'Crude draw revised, oil jumps',
    body: 'A later revision turned the crude build into a draw.',
    publishedAt: DIA + 20 * 3_600_000,
    publishedAtEstimated: false,
    fetchedAt: DIA + 48 * 3_600_000,
    lang: 'en',
  },
] as const;

interface ToolJson {
  readonly isError: boolean;
  readonly text: string;
  readonly data: Record<string, unknown>;
}

/** El resultado del cliente y el del servidor tienen tipos distintos; aqui solo importa el texto. */
type RawToolResult = Record<string, unknown>;

function textOf(result: RawToolResult): string {
  const content: unknown = result.content;
  if (!Array.isArray(content)) return '';
  const [block] = content;
  if (block === null || typeof block !== 'object') return '';
  const text: unknown = Reflect.get(block, 'text');
  return typeof text === 'string' ? text : '';
}

/**
 * El SDK valida el input contra el esquema declarado **antes** de llamar al handler y responde con
 * un error JSON-RPC -32602, que el cliente lanza. No es una excepcion cruda: es el canal de error
 * del protocolo, el servidor sigue vivo y el mensaje dice el campo. Esto lo comprueba.
 */
async function invalidInput(call: Promise<unknown>): Promise<string> {
  try {
    const result = await call;
    const parsed: RawToolResult =
      result !== null && typeof result === 'object' ? { ...result } : {};
    // Si no lanzo, tiene que haber vuelto como error de tool con texto legible.
    if (parsed.isError !== true) {
      throw new Error(`se esperaba un error de input, llego: ${JSON.stringify(result)}`);
    }
    return textOf(parsed);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function unwrap(result: RawToolResult): ToolJson {
  const text = textOf(result);
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object') data = parsed as Record<string, unknown>;
  } catch {
    // Un error de tool devuelve texto plano, no JSON.
  }
  return { isError: result.isError === true, text, data };
}

describe('MCP server: tools de datos', () => {
  let db: ScratchDatabase;
  let vault: string;
  let client: Client;
  /** Ids por url, para no depender del orden del ranking. */
  const ids = new Map<string, string>();

  beforeAll(async () => {
    db = await createScratchDatabase({ applicationName: 'tt-itest-mcp' });
    await runMigrations({ pool: db.pool });
    vault = await mkdtemp(join(tmpdir(), 'tt-mcp-vault-'));

    const documents = createDocumentsRepository(db.pool);
    await documents.insertDocuments([...DOCUMENTOS]);

    for (const stored of await documents.getDocuments({ from: 0, to: AHORA })) {
      ids.set(stored.url, stored.id);
      const asset = stored.source === 'oilprice' ? 'oil' : 'btc';
      await documents.replaceTags({
        documentId: stored.id,
        ruleIds: [`${asset}-nombres-v1`],
        tags: [{ asset, ruleId: `${asset}-nombres-v1` }],
      });
    }

    await createEventsRepository(db.pool).upsertEvents([
      {
        source: 'eia',
        type: 'eia-wpsr',
        assetTags: ['oil'],
        scheduledAt: DIA + 14 * 3_600_000 + 1_800_000,
        publishedAt: DIA + 14 * 3_600_000 + 1_800_000,
        fetchedAt: DIA + 15 * 3_600_000,
        payload: { report: 'weekly-petroleum-status' },
      },
      {
        // Evento del mismo dia descargado despues: tampoco puede verse.
        source: 'fomc',
        type: 'fomc-statement',
        assetTags: ['macro'],
        scheduledAt: DIA + 18 * 3_600_000,
        publishedAt: DIA + 18 * 3_600_000,
        fetchedAt: DIA + 72 * 3_600_000,
        payload: { decision: 'hold' },
      },
    ]);

    await createMacroRepository(db.pool).upsertPoints({
      source: 'eia',
      seriesId: 'WCESTUS1',
      points: [
        // Punto viejo de la misma serie: con `from` por defecto no debe salir.
        {
          t: Date.UTC(2020, 0, 1),
          value: 300,
          revision: 0,
          publishedAt: DIA + 72 * 3_600_000,
          fetchedAt: DIA + 72 * 3_600_000,
        },
        {
          t: DIA,
          value: 420.5,
          revision: 0,
          publishedAt: DIA + 15 * 3_600_000,
          fetchedAt: DIA + 15 * 3_600_000,
        },
        // Revision posterior del mismo punto: con `asOf` del dia no se ve.
        {
          t: DIA,
          value: 418.2,
          revision: 1,
          publishedAt: DIA + 72 * 3_600_000,
          fetchedAt: DIA + 72 * 3_600_000,
        },
      ],
    });

    await createCandlesRepository(db.pool).upsertCandles({
      exchange: 'binance',
      symbol: 'BTCUSDT',
      timeframe: '1h',
      source: 'rest',
      candles: [
        { t: DIA + 10 * 3_600_000, o: 60_000, h: 60_500, l: 59_800, c: 60_400, v: 120 },
        { t: DIA + 11 * 3_600_000, o: 60_400, h: 60_900, l: 60_300, c: 60_800, v: 95 },
        // Vela del dia siguiente: fuera del contexto de ese dia.
        { t: DIA + 30 * 3_600_000, o: 61_000, h: 61_500, l: 60_900, c: 61_400, v: 80 },
      ],
    });

    await createDerivativesRepository(db.pool).upsertFundingRates({
      exchange: 'binance',
      symbol: 'BTCUSDT',
      source: 'rest',
      rates: [{ t: DIA + 8 * 3_600_000, rate: 0.0001, intervalHours: 8 }],
    });

    const deps = buildMcpDeps({
      pool: db.pool,
      logger: createLogger({ role: 'mcp', level: 'silent' }),
      vaultPath: vault,
    });
    const server = buildMcpServer({ ...deps, now: () => AHORA });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'itest', version: '0.0.0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });

  afterAll(async () => {
    await client.close();
    await rm(vault, { recursive: true, force: true });
    await db.drop();
  });

  it('un cliente lista las 6 tools con su esquema de input', async () => {
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());
    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
    }

    const search = tools.find((tool) => tool.name === 'search_documents');
    expect(Object.keys(search?.inputSchema.properties ?? {})).toContain('asOf');
    expect(search?.inputSchema.required).toEqual(['q']);
  });

  describe('search_documents', () => {
    it('encuentra un documento y recorta el cuerpo', async () => {
      const { data } = unwrap(
        await client.callTool({ name: 'search_documents', arguments: { q: 'crude inventories' } }),
      );

      expect(data.count).toBeGreaterThan(0);
      const results = data.results as { snippet: string; truncated: boolean; id: string }[];
      expect(results[0]?.id).toBe(ids.get('https://example.test/crude-build'));
      for (const result of results) {
        expect(result.snippet.length).toBeLessThanOrEqual(MCP_SNIPPET_CHARS);
      }
    });

    it('pagina con offset y dice si hay mas', async () => {
      const primera = unwrap(
        await client.callTool({
          name: 'search_documents',
          arguments: { q: 'crude', limit: 1, offset: 0 },
        }),
      ).data;
      const segunda = unwrap(
        await client.callTool({
          name: 'search_documents',
          arguments: { q: 'crude', limit: 1, offset: 1 },
        }),
      ).data;

      expect(primera.count).toBe(1);
      expect(primera.hasMore).toBe(true);
      expect(primera.limit).toBe(1);
      const unos = primera.results as { id: string }[];
      const dos = segunda.results as { id: string }[];
      expect(dos[0]?.id).not.toBe(unos[0]?.id);
    });

    it('un input invalido devuelve un error legible, no una excepcion cruda', async () => {
      const message = await invalidInput(
        client.callTool({ name: 'search_documents', arguments: { q: 'a' } }),
      );

      expect(message).toMatch(/validation|invalido/iu);
      expect(message).toContain('q');
    });

    it('un limite por encima del tope se rechaza con el tope en el mensaje', async () => {
      const { isError, text } = unwrap(
        await client.callTool({
          name: 'search_documents',
          arguments: { q: 'crude', limit: MCP_MAX_RESULTS + 1 },
        }),
      );

      expect(isError).toBe(true);
      expect(text).toContain(String(MCP_MAX_RESULTS));
    });

    it('una busqueda sin resultados devuelve una lista vacia, no un error', async () => {
      const { isError, data } = unwrap(
        await client.callTool({
          name: 'search_documents',
          arguments: { q: 'zanahorias', source: ['inexistente'] },
        }),
      );

      expect(isError).toBe(false);
      expect(data.count).toBe(0);
      expect(data.results).toEqual([]);
    });
  });

  describe('get_document', () => {
    it('devuelve el documento con sus etiquetas y la regla que las puso', async () => {
      const id = ids.get('https://example.test/bitcoin-etf');
      const { data } = unwrap(await client.callTool({ name: 'get_document', arguments: { id } }));

      expect(data.id).toBe(id);
      expect(data.assets).toEqual(['btc']);
      expect(data.tags).toEqual([{ asset: 'btc', ruleId: 'btc-nombres-v1' }]);
      expect(data.truncated).toBe(false);
    });

    it('un id que no es uuid da error de input', async () => {
      const message = await invalidInput(
        client.callTool({ name: 'get_document', arguments: { id: 'no-soy-un-uuid' } }),
      );

      expect(message).toMatch(/validation|invalido/iu);
      expect(message).toContain('id');
    });

    it('un uuid que no existe da un error claro y no un hueco', async () => {
      const { isError, text } = unwrap(
        await client.callTool({
          name: 'get_document',
          arguments: { id: '00000000-0000-4000-8000-000000000000' },
        }),
      );

      expect(isError).toBe(true);
      expect(text.toLowerCase()).toContain('documento');
    });
  });

  describe('get_macro_series', () => {
    it('devuelve los puntos de la serie', async () => {
      const { data } = unwrap(
        await client.callTool({
          name: 'get_macro_series',
          arguments: { seriesId: 'WCESTUS1', from: 0 },
        }),
      );

      expect(data.seriesId).toBe('WCESTUS1');
      expect((data.points as unknown[]).length).toBeGreaterThan(0);
    });

    it('con asOf del dia da el valor que se conocia entonces, no la revision posterior', async () => {
      const { data } = unwrap(
        await client.callTool({
          name: 'get_macro_series',
          arguments: { seriesId: 'WCESTUS1', from: 0, asOf: DIA_FIN },
        }),
      );

      const points = data.points as { t: number; value: number; revision: number }[];
      expect(points).toHaveLength(1);
      expect(points[0]?.value).toBe(420.5);
      expect(points[0]?.revision).toBe(0);
      expect(points[0]?.t).toBe(DIA);
    });

    it('sin from devuelve la ventana reciente, no el arranque de la serie', async () => {
      const { data } = unwrap(
        await client.callTool({
          name: 'get_macro_series',
          arguments: { seriesId: 'WCESTUS1' },
        }),
      );

      const points = data.points as { t: number }[];
      expect(points.length).toBeGreaterThan(0);
      expect(points.every((point) => point.t >= DIA - 90 * 86_400_000)).toBe(true);
    });

    it('una serie inexistente da un error claro', async () => {
      const { isError, text } = unwrap(
        await client.callTool({
          name: 'get_macro_series',
          arguments: { seriesId: 'NO_EXISTE', from: 0 },
        }),
      );

      expect(isError).toBe(true);
      expect(text).toContain('NO_EXISTE');
    });

    it('un seriesId con caracteres raros se rechaza en el borde', async () => {
      const message = await invalidInput(
        client.callTool({
          name: 'get_macro_series',
          arguments: { seriesId: "WCESTUS1'; DROP TABLE notes; --", from: 0 },
        }),
      );

      expect(message).toMatch(/validation|invalido/iu);
      // Y la tabla sigue ahi.
      const { rows } = await db.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM information_schema.tables WHERE table_name = 'notes'`,
      );
      expect(rows[0]?.count).toBe('1');
    });
  });

  describe('list_events', () => {
    it('filtra por activo', async () => {
      const { data } = unwrap(
        await client.callTool({ name: 'list_events', arguments: { from: 0, asset: ['oil'] } }),
      );

      const events = data.events as { type: string }[];
      expect(events.map((event) => event.type)).toEqual(['eia-wpsr']);
    });

    it('un rango sin eventos devuelve lista vacia', async () => {
      const { isError, data } = unwrap(
        await client.callTool({
          name: 'list_events',
          arguments: { from: Date.UTC(2020, 0, 1), to: Date.UTC(2020, 0, 2) },
        }),
      );

      expect(isError).toBe(false);
      expect(data.count).toBe(0);
    });

    it('un asset vacio se rechaza', async () => {
      const message = await invalidInput(
        client.callTool({ name: 'list_events', arguments: { from: 0, asset: [] } }),
      );

      expect(message).toMatch(/validation|invalido/iu);
    });
  });

  describe('get_market_context', () => {
    it('compone velas, funding, eventos y documentos del dia', async () => {
      const { data } = unwrap(
        await client.callTool({
          name: 'get_market_context',
          arguments: { asset: 'btc', date: '2026-10-20' },
        }),
      );

      expect(data.asOf).toBe(new Date(DIA_FIN).toISOString());
      expect(data.market).toEqual({ exchange: 'binance', symbol: 'BTCUSDT', timeframe: '1h' });
      expect((data.candles as unknown[]).length).toBe(2);
      expect((data.funding as unknown[]).length).toBe(1);
      const documents = data.documents as { title: string }[];
      expect(documents.map((document) => document.title)).toEqual(['Bitcoin ETF inflows continue']);
    });

    it('un activo sin perpetuo lo dice en vez de devolver huecos vacios', async () => {
      const { data } = unwrap(
        await client.callTool({
          name: 'get_market_context',
          arguments: { asset: 'oil', date: '2026-10-20' },
        }),
      );

      expect(data.market).toBeNull();
      expect(data.candles).toEqual([]);
      expect((data.notes as string[]).join(' ')).toContain('no tiene mercado de perpetuos');
      const documents = data.documents as { title: string }[];
      expect(documents.map((document) => document.title)).toEqual([
        'Crude inventories build as refiners slow',
      ]);
    });

    it('nada con fetched_at posterior al dia entra: garantia anti-look-ahead', async () => {
      const { data } = unwrap(
        await client.callTool({
          name: 'get_market_context',
          arguments: { asset: 'oil', date: '2026-10-20' },
        }),
      );

      const documents = data.documents as { id: string; title: string }[];
      // Publicado ese dia, pero descargado dos dias despues.
      expect(documents.map((document) => document.title)).not.toContain(
        'Crude draw revised, oil jumps',
      );
      expect(documents.map((document) => document.id)).not.toContain(
        ids.get('https://example.test/revision-posterior'),
      );

      const events = data.events as { type: string; fetchedAt: number }[];
      expect(events.map((event) => event.type)).not.toContain('fomc-statement');
      for (const event of events) {
        expect(event.fetchedAt).toBeLessThanOrEqual(DIA_FIN);
      }

      // Y ninguna vela posterior al corte.
      const candles = data.candles as { t: string }[];
      for (const candle of candles) {
        expect(Date.parse(candle.t)).toBeLessThanOrEqual(DIA_FIN);
      }
    });

    it('una fecha mal escrita se rechaza en el borde', async () => {
      const { isError, text } = unwrap(
        await client.callTool({
          name: 'get_market_context',
          arguments: { asset: 'btc', date: '20/10/2026' },
        }),
      );

      expect(isError).toBe(true);
      expect(text).toContain('YYYY-MM-DD');
    });

    it('un dia sin nada devuelve el contexto vacio, no un error', async () => {
      const { isError, data } = unwrap(
        await client.callTool({
          name: 'get_market_context',
          arguments: { asset: 'btc', date: '2020-01-01' },
        }),
      );

      expect(isError).toBe(false);
      expect(data.candles).toEqual([]);
      expect(data.documents).toEqual([]);
    });
  });

  describe('write_note', () => {
    it('persiste la nota y la exporta al vault en la misma operacion', async () => {
      const id = ids.get('https://example.test/crude-build');
      const { isError, data } = unwrap(
        await client.callTool({
          name: 'write_note',
          arguments: {
            bodyMd: 'Los inventarios de crudo llevan tres semanas subiendo.',
            assets: ['oil'],
            sourceDocumentIds: [id],
          },
        }),
      );

      expect(isError).toBe(false);
      expect(data.author).toBe('claude');

      const stored = await createNotesRepository(db.pool).getNotes({ author: 'claude' });
      expect(stored.map((note) => note.id)).toContain(data.id);

      const exportadas = await readdir(join(vault, VAULT_FOLDER, 'notes'));
      expect(exportadas).toHaveLength(1);
      const vault_ = data.vault as { written: string[] };
      expect(vault_.written.some((path) => path.startsWith('notes/'))).toBe(true);
    });

    it('un cuerpo vacio se rechaza y no deja nota', async () => {
      const antes = await createNotesRepository(db.pool).getNotes({});
      const message = await invalidInput(
        client.callTool({ name: 'write_note', arguments: { bodyMd: '   ' } }),
      );

      expect(message).toMatch(/validation|invalido/iu);
      expect(await createNotesRepository(db.pool).getNotes({})).toHaveLength(antes.length);
    });
  });

  describe('solo write_note escribe', () => {
    it('las 5 tools de lectura funcionan contra un pool de solo lectura y write_note falla', async () => {
      // `default_transaction_read_only` lo aplica PostgreSQL, no el codigo: si alguna tool colara un
      // INSERT o un UPDATE, la transaccion revienta aqui.
      const readOnly = new Pool({
        connectionString: db.connectionString,
        options: '-c default_transaction_read_only=on',
        max: 2,
      });

      try {
        const deps = buildMcpDeps({
          pool: readOnly,
          logger: createLogger({ role: 'mcp', level: 'silent' }),
          vaultPath: vault,
        });
        const server = buildMcpServer({ ...deps, now: () => AHORA });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const soloLectura = new Client({ name: 'itest-ro', version: '0.0.0' });
        await Promise.all([soloLectura.connect(clientTransport), server.connect(serverTransport)]);

        try {
          const lecturas: { name: string; arguments: Record<string, unknown> }[] = [
            { name: 'search_documents', arguments: { q: 'crude' } },
            {
              name: 'get_document',
              arguments: { id: ids.get('https://example.test/crude-build') },
            },
            { name: 'get_macro_series', arguments: { seriesId: 'WCESTUS1', from: 0 } },
            { name: 'list_events', arguments: { from: 0 } },
            { name: 'get_market_context', arguments: { asset: 'btc', date: '2026-10-20' } },
          ];

          for (const call of lecturas) {
            const { isError, text } = unwrap(await soloLectura.callTool(call));
            expect(isError, `${call.name}: ${text}`).toBe(false);
          }

          const escritura = unwrap(
            await soloLectura.callTool({
              name: 'write_note',
              arguments: { bodyMd: 'esto no deberia poder guardarse' },
            }),
          );
          expect(escritura.isError).toBe(true);
          expect(escritura.text).toMatch(/read-only|solo lectura/iu);
        } finally {
          await soloLectura.close();
        }
      } finally {
        await readOnly.end();
      }
    });
  });
});
