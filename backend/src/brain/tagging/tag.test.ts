import { describe, expect, it } from 'vitest';
import { ASSETS, RULES, type TagRule } from './rules.js';
import { rulesHash, tagDocument } from './tag.js';

/** Casos fijos: un documento por activo, con su texto y lo que tiene que salir. */
const CASOS: readonly { nombre: string; doc: { title: string; body: string }; assets: string[] }[] =
  [
    {
      nombre: 'oro',
      doc: {
        title: 'Gold holds above $4,000',
        body: 'Spot gold rose as bullion demand picked up. XAU/USD traded near its record.',
      },
      assets: ['gold'],
    },
    {
      nombre: 'plata',
      doc: { title: 'Silver squeeze', body: 'SLV saw inflows as silver lease rates spiked.' },
      assets: ['silver'],
    },
    {
      nombre: 'petroleo',
      doc: {
        title: 'OPEC+ keeps quotas',
        body: 'Brent settled lower while crude inventories built. Gasoline stocks fell.',
      },
      assets: ['oil'],
    },
    {
      nombre: 'bitcoin',
      doc: { title: 'Bitcoin near 120k', body: 'BTC funding turned positive on perps.' },
      assets: ['btc'],
    },
    {
      nombre: 'ether',
      doc: { title: 'Ethereum upgrade ships', body: 'ETH staking yields compressed.' },
      assets: ['eth'],
    },
    {
      nombre: 'macro',
      doc: {
        title: 'FOMC holds rates',
        body: 'The Federal Reserve left the target range unchanged as inflation cooled.',
      },
      assets: ['macro'],
    },
  ];

describe('tagDocument con las reglas versionadas', () => {
  for (const caso of CASOS) {
    it(`etiqueta el documento de ${caso.nombre} como ${caso.assets.join(', ')} y nada mas`, () => {
      const assets = [...new Set(tagDocument(caso.doc).map((tag) => tag.asset))];
      expect(assets).toEqual(caso.assets);
    });
  }

  it('el documento del oro no queda etiquetado como plata', () => {
    const tags = tagDocument(CASOS[0]!.doc);
    expect(tags.map((tag) => tag.asset)).not.toContain('silver');
    expect(tags).toEqual([
      { asset: 'gold', ruleId: 'gold-nombres-v1' },
      { asset: 'gold', ruleId: 'gold-tickers-v1' },
    ]);
  });

  it('un documento sin ninguno de los terminos no se etiqueta', () => {
    expect(tagDocument({ title: 'Quarterly results', body: 'Revenue grew.' })).toEqual([]);
  });

  it('cada etiqueta guarda la regla que la puso, para poder reetiquetar solo esa', () => {
    const tags = tagDocument({ title: 'XAU and bullion', body: 'gold' });
    expect(tags.map((tag) => tag.ruleId)).toEqual(['gold-nombres-v1', 'gold-tickers-v1']);
    expect(RULES.map((rule) => rule.id)).toEqual([...new Set(RULES.map((rule) => rule.id))]);
    expect(RULES.every((rule) => ASSETS.includes(rule.asset))).toBe(true);
  });
});

describe('falsos positivos de subcadena', () => {
  const trampas: readonly { texto: string; razon: string }[] = [
    { texto: 'The toilet was blocked', razon: 'oil dentro de toilet' },
    { texto: 'Golden age of streaming', razon: 'gold dentro de golden' },
    { texto: 'He was fed up with the queue', razon: 'fed no es una regla' },
    { texto: 'A new ethos emerged', razon: 'eth dentro de ethos' },
    { texto: 'The btcusdtx pair does not exist', razon: 'btcusdt dentro de btcusdtx' },
    { texto: 'Bitcoinish takes', razon: 'bitcoin dentro de bitcoinish' },
    { texto: 'Silverware sales', razon: 'silver dentro de silverware' },
    { texto: 'Oils and vinegars', razon: 'oil dentro de oils, que no es termino' },
    { texto: 'Precessionary motion', razon: 'recession dentro de precessionary' },
  ];

  for (const trampa of trampas) {
    it(`no etiqueta "${trampa.texto}" (${trampa.razon})`, () => {
      expect(tagDocument({ title: '', body: trampa.texto })).toEqual([]);
    });
  }

  it('si etiqueta la misma palabra cuando va suelta o con puntuacion alrededor', () => {
    for (const texto of ['oil', 'Oil.', '(oil)', 'oil-price', 'crude oil, again', 'XAU/USD']) {
      expect(tagDocument({ title: '', body: texto })).not.toEqual([]);
    }
  });
});

describe('determinismo e idempotencia', () => {
  it('el mismo documento da exactamente el mismo resultado, en el mismo orden', () => {
    const doc = { title: 'Gold, oil and the Fed', body: 'FOMC, Brent, bullion, BTC' };
    expect(tagDocument(doc)).toEqual(tagDocument(doc));
    expect(tagDocument(doc).map((tag) => `${tag.asset}:${tag.ruleId}`)).toEqual([
      'btc:btc-tickers-v1',
      'gold:gold-nombres-v1',
      'macro:macro-nombres-v1',
      'oil:oil-nombres-v1',
    ]);
  });

  it('cambiar una regla solo cambia las etiquetas de ese rule_id', () => {
    const doc = { title: 'Palladium and gold', body: 'bullion demand' };
    const v2: readonly TagRule[] = [
      ...RULES.filter((rule) => rule.id !== 'gold-nombres-v1'),
      { id: 'gold-nombres-v2', asset: 'gold', terms: ['gold', 'bullion', 'palladium'] },
    ];

    expect(tagDocument(doc).map((tag) => tag.ruleId)).toEqual(['gold-nombres-v1']);
    expect(tagDocument(doc, v2).map((tag) => tag.ruleId)).toEqual(['gold-nombres-v2']);
  });

  it('una regla sin terminos no etiqueta nada', () => {
    const vacia: readonly TagRule[] = [{ id: 'vacia-v1', asset: 'gold', terms: [] }];
    expect(tagDocument({ title: 'gold', body: 'gold' }, vacia)).toEqual([]);
  });

  describe('rulesHash', () => {
    it('es estable y no depende del orden de reglas ni de terminos', () => {
      const unas: readonly TagRule[] = [
        { id: 'a-v1', asset: 'gold', terms: ['gold', 'bullion'] },
        { id: 'b-v1', asset: 'oil', terms: ['crude'] },
      ];
      const otras: readonly TagRule[] = [
        { id: 'b-v1', asset: 'oil', terms: ['crude'] },
        { id: 'a-v1', asset: 'gold', terms: ['bullion', 'gold'] },
      ];
      expect(rulesHash(unas)).toBe(rulesHash(otras));
    });

    it('cambia al cambiar un termino, que es lo que dispara el reetiquetado', () => {
      const antes: readonly TagRule[] = [{ id: 'a-v1', asset: 'gold', terms: ['gold'] }];
      const despues: readonly TagRule[] = [{ id: 'a-v2', asset: 'gold', terms: ['gold', 'gld'] }];
      expect(rulesHash(antes)).not.toBe(rulesHash(despues));
      expect(rulesHash()).toHaveLength(16);
    });
  });
});
