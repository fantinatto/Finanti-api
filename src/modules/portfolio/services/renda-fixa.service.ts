import { Injectable } from '@nestjs/common';
import { TAXA_DI_FIXA } from '../rebalancing.config';

/** "cdi" | "prefixado" — ipca+ fora desta 1ª versão (sem série histórica do IPCA coletada). */
export type TipoRentabilidadeRendaFixa = 'cdi' | 'prefixado';

export interface DetalheRendaFixaInput {
  tipoRentabilidade: TipoRentabilidadeRendaFixa;
  /** % do CDI (ex: 100) pra 'cdi'; taxa anual fixa em % (ex: 12.5) pra 'prefixado'. */
  percentualOuTaxa: number;
  dataAplicacao: Date;
  dataVencimento: Date;
  isentoIr: boolean;
}

export interface ResultadoRendaFixa {
  valorInvestido: number;
  dias: number;
  taxaAnualEquivalente: number;
  valorBruto: number;
  rendimentoBruto: number;
  aliquotaIr: number;
  ir: number;
  valorLiquido: number;
  rendimentoLiquido: number;
  rentabilidadeLiquidaPercentual: number;
}

export interface CenarioSimulacao extends DetalheRendaFixaInput {
  nome: string;
  valorInvestido: number;
}

export interface ResultadoSimulacaoCenario extends ResultadoRendaFixa {
  nome: string;
  melhor: boolean;
}

const MS_POR_DIA = 1000 * 60 * 60 * 24;

/**
 * Tabela regressiva de IR sobre renda fixa (Lei 11.033/2004) — alíquota cai conforme o prazo de
 * aplicação, só se aplica ao RENDIMENTO (não ao principal). `isentoIr` (LCI/LCA/CRI/CRA/
 * poupança) zera isso fora desta tabela, ver calcularResultado.
 */
const TABELA_IR_REGRESSIVA = [
  { ateDias: 180, aliquota: 0.225 },
  { ateDias: 360, aliquota: 0.2 },
  { ateDias: 720, aliquota: 0.175 },
  { ateDias: Infinity, aliquota: 0.15 },
];

@Injectable()
export class RendaFixaService {
  calcularAliquotaIr(dias: number): number {
    return TABELA_IR_REGRESSIVA.find((faixa) => dias <= faixa.ateDias)!.aliquota;
  }

  /**
   * Projeta o valor bruto por juros compostos simples (base 365 dias — aproximação didática pra
   * comparação entre títulos, não é o cálculo exato de um banco com base 252 dias úteis) e aplica
   * a tabela regressiva de IR sobre o rendimento. taxaAnualEquivalente pra 'cdi' usa TAXA_DI_FIXA
   * (mesma taxa cadastrada manualmente já usada em regras/sugestao-di — ver rebalancing.config.ts
   * — na ausência de uma API de futuros acessível no plano atual da brapi).
   */
  calcularResultado(valorInvestido: number, detalhe: DetalheRendaFixaInput, dataReferencia: Date): ResultadoRendaFixa {
    const dataFinal = dataReferencia < detalhe.dataVencimento ? dataReferencia : detalhe.dataVencimento;
    const dias = Math.max(0, Math.round((dataFinal.getTime() - detalhe.dataAplicacao.getTime()) / MS_POR_DIA));

    const taxaAnualEquivalente =
      detalhe.tipoRentabilidade === 'cdi' ? TAXA_DI_FIXA * (detalhe.percentualOuTaxa / 100) : detalhe.percentualOuTaxa;

    const valorBruto = valorInvestido * Math.pow(1 + taxaAnualEquivalente / 100, dias / 365);
    const rendimentoBruto = valorBruto - valorInvestido;

    const aliquotaIr = detalhe.isentoIr ? 0 : this.calcularAliquotaIr(dias);
    const ir = rendimentoBruto > 0 ? rendimentoBruto * aliquotaIr : 0;

    const valorLiquido = valorBruto - ir;
    const rendimentoLiquido = valorLiquido - valorInvestido;

    return {
      valorInvestido,
      dias,
      taxaAnualEquivalente,
      valorBruto,
      rendimentoBruto,
      aliquotaIr,
      ir,
      valorLiquido,
      rendimentoLiquido,
      rentabilidadeLiquidaPercentual: valorInvestido > 0 ? (rendimentoLiquido / valorInvestido) * 100 : 0,
    };
  }

  /** Compara N cenários (não precisam ser posições salvas) e marca o de maior rendimento líquido. */
  simular(cenarios: CenarioSimulacao[], dataReferencia: Date): ResultadoSimulacaoCenario[] {
    const resultados = cenarios.map((c) => ({ nome: c.nome, ...this.calcularResultado(c.valorInvestido, c, dataReferencia), melhor: false }));
    if (!resultados.length) return resultados;

    const melhor = resultados.reduce((a, b) => (b.rendimentoLiquido > a.rendimentoLiquido ? b : a));
    melhor.melhor = true;

    return resultados;
  }
}
