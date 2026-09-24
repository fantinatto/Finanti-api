/** Tamanho do lote-padrão na B3 — usado quando o usuário desativa compra/venda fracionária em
 * PortfolioConfig.permiteFracionario. */
export const TAMANHO_LOTE = 100;

/**
 * Arredonda uma quantidade de ações (calculada a partir de um valor em R$) pro múltiplo de
 * TAMANHO_LOTE mais próximo pra baixo — nunca sugere/executa mais do que caberia no valor
 * disponível, só menos (a sobra fica de fora, quem chama decide o que fazer com ela).
 *
 * `quantidadeDisponivel` só se aplica a VENDAS (null pra compras): é a posição que o investidor
 * já possui. Fechar uma posição que já é menor que um lote (compra fracionária antiga, ou sobra
 * de um lote) é sempre permitido por inteiro — não existe uma forma de "vender em lote" algo
 * menor que um lote, e a alternativa (nunca deixar vender) tornaria essa posição intocável.
 */
export function arredondarParaLote(quantidadeBruta: number, quantidadeDisponivel: number | null): number {
  if (quantidadeDisponivel != null && quantidadeDisponivel <= TAMANHO_LOTE) {
    return quantidadeDisponivel;
  }
  const quantidadeLote = Math.floor(quantidadeBruta / TAMANHO_LOTE) * TAMANHO_LOTE;
  return quantidadeDisponivel != null ? Math.min(quantidadeLote, quantidadeDisponivel) : quantidadeLote;
}
