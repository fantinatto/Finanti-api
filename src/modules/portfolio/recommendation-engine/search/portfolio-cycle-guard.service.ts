import { Injectable } from '@nestjs/common';
import { PortfolioMove } from '../domain/portfolio-move';

/**
 * Bloqueia reversão imediata do ÚLTIMO move da linha (não a história inteira) — sem isso a busca
 * poderia explorar `BUY A → SELL A` ou `SELL A → BUY A` como se fossem descobertas novas, sem
 * nenhum benefício econômico. Helper formal (não string solta), sem exceção fiscal nesta fase
 * (mencionada pelo usuário como possível futuro, não agora).
 */
@Injectable()
export class PortfolioCycleGuardService {
  isImmediateReversal(history: PortfolioMove[], candidato: PortfolioMove): boolean {
    const ultimo = history[history.length - 1];
    if (!ultimo) return false;

    const desfazVenda =
      (ultimo.type === 'SELL' || ultimo.type === 'REDUCE') &&
      (candidato.type === 'BUY' || candidato.type === 'ADD_NEW_POSITION') &&
      ultimo.sourceTicker === candidato.targetTicker;

    const desfazCompra =
      (ultimo.type === 'BUY' || ultimo.type === 'ADD_NEW_POSITION') &&
      (candidato.type === 'SELL' || candidato.type === 'REDUCE') &&
      ultimo.targetTicker === candidato.sourceTicker;

    const desfazRotacao =
      ultimo.type === 'ROTATE_WITHIN_SECTOR' &&
      candidato.type === 'ROTATE_WITHIN_SECTOR' &&
      ultimo.targetTicker === candidato.sourceTicker &&
      ultimo.sourceTicker === candidato.targetTicker;

    return desfazVenda || desfazCompra || desfazRotacao;
  }
}
