import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { BolsaiFundamentals } from '../dto/bolsai.types';

const BOLSAI_BASE_URL = 'https://api.usebolsai.com/api/v1';

@Injectable()
export class BolsaiService {
  private readonly logger = new Logger(BolsaiService.name);
  private readonly apiKey: string;

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {
    this.apiKey = this.config.getOrThrow<string>('BOLSAI_API_KEY');
  }

  /**
   * A bolsai não tem endpoint de batch — busca ticker a ticker (tier free: 200 req).
   * Chamar só com a lista já filtrada da ingestão, nunca com o universo completo da B3.
   */
  async buscarFundamentais(tickers: string[]): Promise<Map<string, BolsaiFundamentals>> {
    const resultado = new Map<string, BolsaiFundamentals>();

    for (const ticker of tickers) {
      try {
        const url = `${BOLSAI_BASE_URL}/fundamentals/${ticker}`;
        const resp = await firstValueFrom(
          this.http.get<BolsaiFundamentals>(url, {
            headers: { Authorization: `Bearer ${this.apiKey}` },
          }),
        );
        resultado.set(ticker, resp.data);
      } catch (err: any) {
        const status = err?.response?.status ?? err?.status;
        if (status === 429) {
          // Cota diária estourada — não se recupera no meio da mesma execução, então
          // não adianta continuar tentando os tickers restantes (só spam de log e espera).
          this.logger.warn(
            `Cota da bolsai esgotada (429) em ${ticker} — abortando fallback bolsai pro resto desta ingestão (${resultado.size}/${tickers.length} obtidos).`,
          );
          break;
        }
        this.logger.warn(`Falha ao buscar fundamentos bolsai de ${ticker} (status ${status ?? '?'})`);
      }
      await this.sleep(150);
    }

    return resultado;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
