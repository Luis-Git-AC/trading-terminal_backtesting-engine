import { RULES, type Asset, type TagRule } from './rules.js';

export interface DocumentTag {
  readonly asset: Asset;
  readonly ruleId: string;
}

export interface TaggableDocument {
  readonly title: string;
  readonly body: string;
}

/**
 * Palabra completa y sin distinguir mayusculas. `\b` no sirve para terminos que acaban en algo que
 * no es letra (`xau/usd`), asi que el limite se escribe a mano: delante y detras no puede haber
 * letra ni numero. Asi `oil` dentro de `toilet` no etiqueta nada.
 */
function patternFor(terms: readonly string[]): RegExp {
  const escaped = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${escaped.join('|')})(?![\\p{L}\\p{N}])`, 'iu');
}

/** Un patron por regla, compilado una vez: las reglas son constantes. */
const patterns = new WeakMap<readonly TagRule[], Map<string, RegExp>>();

function patternsFor(rules: readonly TagRule[]): Map<string, RegExp> {
  const cached = patterns.get(rules);
  if (cached !== undefined) return cached;

  const compiled = new Map(rules.map((rule) => [rule.id, patternFor(rule.terms)]));
  patterns.set(rules, compiled);
  return compiled;
}

/**
 * Etiquetas de un documento: determinista y ordenado, para que reetiquetar dos veces con las
 * mismas reglas de exactamente el mismo resultado.
 */
export function tagDocument(
  document: TaggableDocument,
  rules: readonly TagRule[] = RULES,
): DocumentTag[] {
  const text = `${document.title}\n${document.body}`;
  const compiled = patternsFor(rules);

  return rules
    .filter((rule) => {
      const pattern = compiled.get(rule.id);
      return pattern !== undefined && rule.terms.length > 0 && pattern.test(text);
    })
    .map((rule) => ({ asset: rule.asset, ruleId: rule.id }))
    .sort((a, b) =>
      a.asset === b.asset ? a.ruleId.localeCompare(b.ruleId) : a.asset < b.asset ? -1 : 1,
    );
}
