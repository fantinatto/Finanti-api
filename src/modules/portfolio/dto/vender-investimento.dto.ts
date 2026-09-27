import { IsNumber, IsOptional, Min } from 'class-validator';

export class VenderInvestimentoDto {
  @IsNumber()
  @Min(0.0001)
  quantidade: number;

  /** Só lido na venda da carteira REAL (PortfolioController.venderInvestimento). Uma venda nunca
   * é ambígua (é sempre uma operação de hoje) — se vier preenchido, a venda é automaticamente
   * espelhada como uma OperacaoFiscal ('venda'); se omitido, comportamento antigo (sem fiscal).
   * Ver docs/FEATURE_SPEC_FISCAL.md seção 2. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  precoVenda?: number;

  /** Corretagem/emolumentos da venda, pra registrarFiscal. Default 0. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  custosFiscais?: number;
}
