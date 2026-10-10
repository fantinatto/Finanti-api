import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import {
  BrapiListItem,
  BrapiListResponse,
  BrapiQuoteResponse,
  BrapiQuoteResult,
} from '../dto/brapi.types';

const BRAPI_BASE_URL = 'https://brapi.dev/api';
const BRAPI_V2_BASE_URL = 'https://brapi.dev/api/v2';
// O plano atual do token só permite 1 ativo por requisição (confirmado via erro 400 da API:
// "Seu plano permite no máximo 1 ativo(s) por requisição"). Batch >1 sempre cai no fallback
// individual, gastando uma chamada extra fadada ao erro em cada lote — por isso 1 aqui.
// Se o plano for atualizado para permitir mais ativos por requisição, subir esse valor.
const BATCH_SIZE = 1;
const MODULES = 'summaryProfile,defaultKeyStatistics,financialData';
// Catálogo de FIIs (ticker+nome+cotação) é estático dentro do dia — não tem fundamento nenhum
// pra justificar refetch a cada autocomplete. 6h é só pra não ficar com dado de fechamento muito
// velho, não por risco de a LISTA de FIIs mudar nesse intervalo.
const CACHE_FIIS_TTL_MS = 6 * 60 * 60 * 1000;

@Injectable()
export class BrapiService {
  private readonly logger = new Logger(BrapiService.name);
  private readonly token: string;

  // Cache isolado da busca de FII — nenhum outro método deste service lê/escreve nesses campos,
  // pra não arriscar efeito colateral no fluxo de ações (buscarFundamentais/listarTickers).
  private cacheFiis: { ticker: string; nome: string; precoFechamento: number | null }[] | null = null;
  private cacheFiisExpiraEm = 0;

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {
    this.token = this.config.getOrThrow<string>('BRAPI_TOKEN');
  }

  async listarTickers(): Promise<BrapiListItem[]> {
    const url = `${BRAPI_BASE_URL}/quote/list?token=${this.token}`;
    const resp = await firstValueFrom(this.http.get<BrapiListResponse>(url));
    return resp.data.stocks;
  }

  /**
   * Search-help pro campo Ticker quando `tipo==='fii'` — caminho 100% separado de
   * `buscarTickers`/Acao (ranking-query.service.ts): não existe ingestão de fundamentos de FII
   * hoje (ver análise de complexidade), então isso é só um catálogo ticker+cotação vindo da
   * listagem pública da brapi (`quote/list?type=fund`), sem nome amigável (a API devolve o
   * próprio ticker como `name` pra fundos) e sem histórico mensal (`anoMes` sempre null).
   */
  async buscarTickersFii(
    query: string,
  ): Promise<{ ticker: string; nome: string; precoFechamento: number | null; anoMes: string | null }[]> {
    const termo = query.trim();
    if (termo.length < 1) return [];

    const fiis = await this.obterCatalogoFiis();
    const termoUpper = termo.toUpperCase();
    const encontrados = fiis.filter((f) => f.ticker.includes(termoUpper));

    encontrados.sort((a, b) => {
      const prioridadeA = a.ticker.startsWith(termoUpper) ? 0 : 1;
      const prioridadeB = b.ticker.startsWith(termoUpper) ? 0 : 1;
      return prioridadeA !== prioridadeB ? prioridadeA - prioridadeB : a.ticker.localeCompare(b.ticker);
    });

    return encontrados.slice(0, 15).map((f) => ({ ...f, anoMes: null }));
  }

  private async obterCatalogoFiis(): Promise<{ ticker: string; nome: string; precoFechamento: number | null }[]> {
    if (this.cacheFiis && Date.now() < this.cacheFiisExpiraEm) {
      return this.cacheFiis;
    }

    const url = `${BRAPI_BASE_URL}/quote/list?token=${this.token}&type=fund&limit=1000`;
    try {
      const resp = await firstValueFrom(this.http.get<BrapiListResponse>(url));
      const catalogo = resp.data.stocks
        .filter((item) => item.subType === 'fii')
        .map((item) => ({ ticker: item.stock, nome: item.name, precoFechamento: item.close ?? null }));

      this.cacheFiis = catalogo;
      this.cacheFiisExpiraEm = Date.now() + CACHE_FIIS_TTL_MS;
      return catalogo;
    } catch (err: any) {
      this.logger.error(`Falha ao buscar catálogo de FIIs: ${err?.response?.status ?? ''} ${(err as Error).message}`);
      return this.cacheFiis ?? []; // dado velho é melhor que quebrar o autocomplete
    }
  }

  async previewTicker(ticker: string): Promise<unknown> {
    const url = `${BRAPI_BASE_URL}/quote/${ticker}?token=${this.token}&modules=${MODULES}`;
    const resp = await firstValueFrom(this.http.get<unknown>(url));
    return resp.data;
  }

  async buscarFundamentais(tickers: string[]): Promise<BrapiQuoteResult[]> {
    const resultados: BrapiQuoteResult[] = [];
    const batches = this.chunk(tickers, BATCH_SIZE);

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const batchResultados = await this.buscarLote(batch, i + 1, batches.length);
      resultados.push(...batchResultados);

      if (i < batches.length - 1) {
        await this.sleep(300);
      }
    }

    return resultados;
  }

  private async buscarLote(
    tickers: string[],
    loteNum: number,
    totalLotes: number,
  ): Promise<BrapiQuoteResult[]> {
    const symbols = tickers.join(',');
    const url = `${BRAPI_BASE_URL}/quote/${symbols}?token=${this.token}&modules=${MODULES}`;

    try {
      this.logger.log(`Lote ${loteNum}/${totalLotes}: ${symbols.substring(0, 60)}...`);
      const resp = await firstValueFrom(this.http.get<BrapiQuoteResponse>(url));
      return resp.data.results;
    } catch (err: any) {
      const status = err?.response?.status ?? err?.status;
      if (status === 400 && tickers.length > 1) {
        // Batch rejeitado (ticker inválido/suspenso no grupo) — busca individualmente
        this.logger.warn(`Lote ${loteNum} retornou 400, reprocessando ${tickers.length} tickers individualmente`);
        return this.buscarIndividualmente(tickers);
      }
      const msg = err?.response?.data?.message ?? (err as Error).message;
      this.logger.error(`Falha no lote ${loteNum} (status ${status ?? '?'}): ${msg}`);
      return [];
    }
  }

  private async buscarIndividualmente(tickers: string[]): Promise<BrapiQuoteResult[]> {
    const resultados: BrapiQuoteResult[] = [];
    for (const ticker of tickers) {
      try {
        const url = `${BRAPI_BASE_URL}/quote/${ticker}?token=${this.token}&modules=${MODULES}`;
        const resp = await firstValueFrom(this.http.get<BrapiQuoteResponse>(url));
        if (resp.data.results?.length) {
          resultados.push(resp.data.results[0]);
        }
      } catch (err: any) {
        const status = err?.response?.status ?? err?.status;
        const msg = err?.response?.data?.message ?? (err as Error).message;
        this.logger.warn(`Falha ao buscar ${ticker} individualmente (status ${status ?? '?'}): ${msg}`);
      }
      await this.sleep(150);
    }
    return resultados;
  }

  /**
   * Cotação do contrato de DI futuro (DI1) mais próximo do vencimento — usado na regra
   * de rebalanceamento "dos N ajustada por juros". Endpoint /v2/futures confirmado contra
   * o OpenAPI real da brapi.dev (brapi.dev/openapi.json): usa header `Authorization: Bearer`
   * (não `?token=` como os endpoints v1) e path em inglês (`/futures/list`, `/futures/quote`,
   * não `/futuros`). Exige plano Pro do token — no plano Gratuito retorna
   * code "FEATURE_NOT_AVAILABLE" (verificado em 2026-08-15).
   */
  async getCotacaoDiMaisProximo(): Promise<{ contrato: string; taxa: number }> {
    const headers = { Authorization: `Bearer ${this.token}` };

    try {
      const listaUrl = `${BRAPI_V2_BASE_URL}/futures/list?asset=DI1&includeExpired=false&sortBy=expirationDate&sortOrder=asc&limit=1`;
      const listaResp = await firstValueFrom(
        this.http.get<{ futures: { symbol: string; expirationDate: string }[] }>(listaUrl, { headers }),
      );

      const maisProximo = listaResp.data.futures?.[0];
      if (!maisProximo) {
        throw new Error('Nenhum contrato de DI futuro retornado pela brapi.dev');
      }

      const cotacaoUrl = `${BRAPI_V2_BASE_URL}/futures/quote?symbols=${maisProximo.symbol}`;
      const cotacaoResp = await firstValueFrom(
        this.http.get<{ quotes: { symbol: string; settlementRate: number | null; close: number | null }[] }>(cotacaoUrl, { headers }),
      );

      const quote = cotacaoResp.data.quotes?.[0];
      const taxa = quote?.settlementRate ?? quote?.close;
      if (taxa == null) {
        throw new Error(`Cotação do contrato ${maisProximo.symbol} veio sem taxa (settlementRate/close nulos)`);
      }

      return { contrato: maisProximo.symbol, taxa };
    } catch (err: any) {
      const status = err?.response?.status ?? err?.status;
      const brapiMsg = err?.response?.data?.message;
      const msg = brapiMsg ?? (err as Error).message;
      this.logger.error(`Falha ao buscar cotação do DI futuro (status ${status ?? '?'}): ${msg}`);
      throw new Error(brapiMsg ?? 'Não foi possível obter a cotação do DI futuro na brapi.dev.');
    }
  }

  private chunk<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
