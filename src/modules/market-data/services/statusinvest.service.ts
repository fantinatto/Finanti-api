import { Injectable, Logger } from '@nestjs/common';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { StatusInvestItem, StatusInvestResponse } from '../dto/statusinvest.types';

chromium.use(StealthPlugin());

const BASE_URL = 'https://statusinvest.com.br/category/advancedsearchresultpaginated';
const BUSCA_AVANCADA_URL = 'https://statusinvest.com.br/acoes/busca-avancada';
const TAKE = 1000;
const CATEGORY_TYPE_ACOES = 1;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Query sem nenhum filtro de faixa (dy/p_l/roe/liquidez) — precisa ser assim pra trazer o
 * universo inteiro de ações. As URLs de exemplo do Status Invest que circulam por aí têm
 * filtros pessoais de screening embutidos no "search" (ex: dy 5-25%, p_l 0-7); usar isso
 * aqui filtraria a base ANTES da ingestão e enviesaria as médias por setor.
 */
const SEARCH_SEM_FILTRO = {
  Sector: '',
  SubSector: '',
  Segment: '',
  my_range: '-20;100',
  forecast: {
    upsidedownside: { Item1: null, Item2: null },
    estimatesnumber: { Item1: null, Item2: null },
    revisedup: true,
    reviseddown: true,
    consensus: [],
  },
  dy: { Item1: null, Item2: null },
  p_l: { Item1: null, Item2: null },
  peg_ratio: { Item1: null, Item2: null },
  p_vp: { Item1: null, Item2: null },
  p_ativo: { Item1: null, Item2: null },
  margembruta: { Item1: null, Item2: null },
  margemebit: { Item1: null, Item2: null },
  margemliquida: { Item1: null, Item2: null },
  p_ebit: { Item1: null, Item2: null },
  ev_ebit: { Item1: null, Item2: null },
  dividaliquidaebit: { Item1: null, Item2: null },
  dividaliquidapatrimonioliquido: { Item1: null, Item2: null },
  p_sr: { Item1: null, Item2: null },
  p_capitalgiro: { Item1: null, Item2: null },
  p_ativocirculante: { Item1: null, Item2: null },
  roe: { Item1: null, Item2: null },
  roic: { Item1: null, Item2: null },
  roa: { Item1: null, Item2: null },
  liquidezcorrente: { Item1: null, Item2: null },
  pl_ativo: { Item1: null, Item2: null },
  passivo_ativo: { Item1: null, Item2: null },
  giroativos: { Item1: null, Item2: null },
  receitas_cagr5: { Item1: null, Item2: null },
  lucros_cagr5: { Item1: null, Item2: null },
  liquidezmediadiaria: { Item1: null, Item2: null },
  vpa: { Item1: null, Item2: null },
  lpa: { Item1: null, Item2: null },
  valormercado: { Item1: null, Item2: null },
};

@Injectable()
export class StatusInvestService {
  private readonly logger = new Logger(StatusInvestService.name);

  /**
   * O Status Invest passou a bloquear requisições HTTP simples (axios) com um Managed
   * Challenge do Cloudflare — 403, header `cf-mitigated: challenge`, mesmo com User-Agent de
   * navegador. Chromium headless comum (Playwright puro) também foi detectado e bloqueado
   * especificamente nesse endpoint de dados, mesmo já tendo passado pelo challenge da página
   * HTML normal do site. O plugin de stealth (puppeteer-extra-plugin-stealth, reaproveitado
   * via playwright-extra) mascara os sinais de automação (navigator.webdriver etc.) o
   * suficiente pro challenge resolver sozinho — confirmado em 2026-08-28 (617 tickers, JSON
   * válido). Por isso a coleta roda dentro de um browser real em vez de uma chamada HTTP direta.
   */
  async buscarTodas(): Promise<StatusInvestItem[]> {
    const browser = await chromium.launch({ headless: true });

    try {
      const context = await browser.newContext({ userAgent: USER_AGENT });
      const page = await context.newPage();

      // "Aquece" o clearance do Cloudflare navegando numa página normal do site antes de
      // chamar o endpoint de dados diretamente.
      await page.goto(BUSCA_AVANCADA_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

      const resultado: StatusInvestItem[] = [];
      let paginaAtual = 0;

      while (true) {
        const search = encodeURIComponent(JSON.stringify(SEARCH_SEM_FILTRO));
        const url = `${BASE_URL}?search=${search}&orderColumn=&isAsc=&page=${paginaAtual}&take=${TAKE}&CategoryType=${CATEGORY_TYPE_ACOES}`;

        // fetch same-origin de dentro da página — reusa os cookies/fingerprint que já
        // passaram pelo challenge, ao contrário de uma chamada HTTP externa nova.
        const resp = await page.evaluate(async (u) => {
          const r = await fetch(u, { headers: { Accept: 'application/json' } });
          return { status: r.status, body: await r.text() };
        }, url);

        if (resp.status !== 200) {
          this.logger.error(
            `Falha ao buscar página ${paginaAtual} do Status Invest (status ${resp.status}): ${resp.body.slice(0, 200)}`,
          );
          throw new Error(`Status Invest retornou ${resp.status} na página ${paginaAtual}`);
        }

        const data = JSON.parse(resp.body) as StatusInvestResponse;
        const lista = data.list ?? [];
        resultado.push(...lista);
        this.logger.log(`Página ${paginaAtual}: ${lista.length} tickers (${resultado.length}/${data.totalResults} coletados)`);

        if (resultado.length >= data.totalResults || lista.length < TAKE) break;
        paginaAtual++;
      }

      return resultado;
    } finally {
      await browser.close();
    }
  }
}
