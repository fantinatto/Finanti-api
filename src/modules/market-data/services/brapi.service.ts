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

@Injectable()
export class BrapiService {
  private readonly logger = new Logger(BrapiService.name);
  private readonly token: string;

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
