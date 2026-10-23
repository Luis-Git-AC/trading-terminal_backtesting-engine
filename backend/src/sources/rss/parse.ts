import { XMLParser, XMLValidator } from 'fast-xml-parser';

/** El XML del feed esta roto. Un feed roto no tumba la pasada: se registra y se sigue. */
export class FeedParseError extends Error {
  override readonly name = 'FeedParseError';
}

export interface FeedEntry {
  readonly title: string;
  readonly url: string;
  /** Texto plano: el HTML del feed ya viene saneado por `sanitizeToText`. */
  readonly body: string;
  /** `null` si el feed no la trae; el llamante decide con que rellenarla. */
  readonly publishedAt: number | null;
  readonly lang: string | null;
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * HTML del feed a texto plano. Es dato no confiable: no se guarda markup, se guarda texto, para
 * que nadie pueda renderizarlo mas tarde por descuido. Las entidades se decodifican **despues**
 * de quitar las etiquetas, para que un `&lt;script&gt;` escapado no reaparezca como etiqueta.
 */
export function sanitizeToText(html: string): string {
  return (
    html
      .replace(/<!--[\s\S]*?-->/gu, ' ')
      // Con su contenido: el cuerpo de un <script> no es texto del articulo.
      .replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, ' ')
      // Una etiqueta sin cerrar al final del fragmento se lleva el resto, que es lo prudente.
      .replace(/<[^>]*>|<[^>]*$/gu, ' ')
      .replace(/&#x([0-9a-f]+);/giu, (_match, hex: string) =>
        String.fromCodePoint(Number.parseInt(hex, 16)),
      )
      .replace(/&#(\d+);/gu, (_match, dec: string) =>
        String.fromCodePoint(Number.parseInt(dec, 10)),
      )
      .replace(/&([a-z]+);/giu, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match)
      .replace(/\s+/gu, ' ')
      .trim()
  );
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  trimValues: true,
  // Los numeros aqui estorban: una fecha o un titulo numerico tienen que seguir siendo texto.
  parseTagValue: false,
  parseAttributeValue: false,
});

type Node = Record<string, unknown>;

function asNode(value: unknown): Node | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Node)
    : null;
}

function toArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Un nodo con atributos llega como objeto con `#text`; sin ellos, como cadena. */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  const node = asNode(value);
  if (node === null) return '';
  return typeof node['#text'] === 'string' ? node['#text'] : '';
}

/** RSS trae la URL en `<link>`; Atom, en `<link href>` con varios `rel` posibles. */
function linkOf(value: unknown): string {
  for (const link of toArray(value)) {
    const node = asNode(link);
    if (node === null) {
      if (typeof link === 'string' && link.length > 0) return link;
      continue;
    }
    const rel = node['@rel'];
    if (rel === undefined || rel === 'alternate') {
      const href = node['@href'];
      if (typeof href === 'string') return href;
    }
  }
  return '';
}

function dateOf(...candidates: unknown[]): number | null {
  for (const candidate of candidates) {
    const raw = textOf(candidate);
    if (raw.length === 0) continue;
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function entryOf(item: Node, lang: string | null): FeedEntry {
  return {
    title: sanitizeToText(textOf(item.title)),
    url: linkOf(item.link),
    // `content:encoded` trae el articulo entero y `description` solo el resumen.
    body: sanitizeToText(
      textOf(item['content:encoded']) ||
        textOf(item.content) ||
        textOf(item.description) ||
        textOf(item.summary),
    ),
    publishedAt: dateOf(item.pubDate, item.published, item.updated, item['dc:date']),
    lang,
  };
}

/**
 * RSS 2.0 y Atom en la misma funcion: los dos son listas de entradas con titulo, enlace, cuerpo y
 * fecha, y distinguirlos solo duplicaria el recorrido.
 */
export function parseFeed(xml: string, fallbackLang: string | null = null): FeedEntry[] {
  const valid = XMLValidator.validate(xml);
  if (valid !== true) {
    throw new FeedParseError(`XML invalido: ${valid.err.msg} (linea ${String(valid.err.line)})`);
  }

  const root = asNode(parser.parse(xml));
  if (root === null) throw new FeedParseError('el feed no tiene raiz');

  const channel = asNode(asNode(root.rss)?.channel);
  const feed = asNode(root.feed);

  if (channel !== null) {
    const lang = textOf(channel.language) || fallbackLang;
    return toArray(channel.item)
      .map(asNode)
      .filter((item): item is Node => item !== null)
      .map((item) => entryOf(item, lang === '' ? null : lang));
  }

  if (feed !== null) {
    const lang = textOf(feed['@xml:lang']) || fallbackLang;
    return toArray(feed.entry)
      .map(asNode)
      .filter((entry): entry is Node => entry !== null)
      .map((entry) => entryOf(entry, lang === '' ? null : lang));
  }

  throw new FeedParseError('el feed no es RSS 2.0 ni Atom');
}
