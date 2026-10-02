import { IsNumber, IsOptional, Min } from 'class-validator';

export class VenderInvestimentoDto {
  @IsNumber()
  @Min(0.0001)
  quantidade: number;

  /** Preço unitário efetivo da venda. Obrigatório para calcular e registrar o ganho realizado. */
  @IsNumber()
  @Min(0.0001)
  precoVenda: number;

  /** Corretagem/emolumentos da venda, pra registrarFiscal. Default 0. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  custosFiscais?: number;
}
