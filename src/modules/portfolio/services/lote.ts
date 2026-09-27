/** Tamanho do lote-padrão na B3 — usado quando o usuário desativa compra/venda fracionária em
 * PortfolioConfig.permiteFracionario. */
export const TAMANHO_LOTE = 100;

/** Unidade mínima do mercado fracionário da B3 — 1 ação inteira. A B3 nunca negocia fração de
 * ação em NENHUM mercado: o fracionário permite 1 a 99 ações (em vez de exigir múltiplos de
 * 100), mas sempre em unidades inteiras. `permiteFracionario=true` deve arredondar pra isso, não
 * deixar de arredondar. */
export const TAMANHO_FRACIONARIO = 1;

/**
 * Arredonda uma quantidade de ações (calculada a partir de um valor em R$) pro múltiplo de
 * `tamanhoUnidade` mais próximo pra baixo — nunca sugere/executa mais do que caberia no valor
 * disponível, só menos (a sobra fica de fora, quem chama decide o que fazer com ela: geralmente
 * creditar em caixa). Chamar SEMPRE antes de persistir uma quantidade de ação — nunca existe
 * cenário em que uma fração de ação (tipo 0,2857) seja uma quantidade válida pra negociar.
 *
 * `tamanhoUnidade` é TAMANHO_LOTE (100) quando o usuário desativou fracionário, ou
 * TAMANHO_FRACIONARIO (1) quando permite — a diferença entre os dois é só a granularidade do
 * arredondamento, nunca "arredondar ou não".
 *
 * `quantidadeDisponivel` só se aplica a VENDAS (null pra compras): é a posição que o investidor
 * já possui. Fechar uma posição que já é menor que 1 unidade de negociação (compra antiga com
 * quantidade fracionada, de antes desse arredondamento existir, ou sobra de um lote) é sempre
 * permitido por inteiro — não existe uma forma de "vender em lote/fracionário" algo menor que
 * 1 unidade, e a alternativa (nunca deixar vender) tornaria essa posição intocável.
 */
export function arredondarParaLote(quantidadeBruta: number, quantidadeDisponivel: number | null, tamanhoUnidade: number = TAMANHO_LOTE): number {
  if (quantidadeDisponivel != null && quantidadeDisponivel <= tamanhoUnidade) {
    return quantidadeDisponivel;
  }
  const quantidadeArredondada = Math.floor(quantidadeBruta / tamanhoUnidade) * tamanhoUnidade;
  return quantidadeDisponivel != null ? Math.min(quantidadeArredondada, quantidadeDisponivel) : quantidadeArredondada;
}
