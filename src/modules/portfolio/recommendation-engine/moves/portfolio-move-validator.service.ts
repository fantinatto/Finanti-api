import { Injectable } from '@nestjs/common';
import { PortfolioState } from '../domain/portfolio-state';
import { PortfolioMove } from '../domain/portfolio-move';

/**
 * Rede de segurança sobre os moves que o Generator já produziu — a maior parte das restrições
 * (quantidade disponível, lote/fracionário, cotação existente) já é aplicada NO Generator (ver
 * PortfolioMoveGeneratorService), porque afeta o TAMANHO do candidato, não só se ele é
 * aceitável. O Validator existe pra pegar o que ainda seria possível escapar (posição de origem
 * já não existe mais no estado — relevante sobretudo em profundidade >1, Fase C — ou valores
 * degenerados).
 */
@Injectable()
export class PortfolioMoveValidatorService {
  validate(state: PortfolioState, move: PortfolioMove): boolean {
    if (move.amount <= 0) return false;
    if (move.quantity != null && move.quantity <= 0) return false;

    if (move.sourcePositionId) {
      const posicao = state.positions.find((p) => p.id === move.sourcePositionId);
      if (!posicao) return false;
      if (move.quantity != null && move.quantity > posicao.quantidade + 0.0001) return false;
    }

    if ((move.type === 'BUY' || move.type === 'ADD_NEW_POSITION') && !move.targetTicker) return false;
    if (move.type === 'ROTATE_WITHIN_SECTOR' && (!move.sourceTicker || !move.targetTicker)) return false;

    return true;
  }
}
