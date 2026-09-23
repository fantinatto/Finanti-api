import { IsBoolean, IsNumber, IsObject, IsOptional, IsString } from 'class-validator';

/** min/max de um indicador — mesmo formato Item1/Item2 da Status Invest, só que já resolvido. */
export interface RangeFiltro {
  min?: number;
  max?: number;
}

export class IngestionFiltroDto {
  @IsOptional()
  @IsBoolean()
  soAcoes?: boolean;

  @IsOptional()
  @IsBoolean()
  excluirFiis?: boolean;

  @IsOptional()
  @IsBoolean()
  excluirBdrs?: boolean;

  @IsOptional()
  @IsString()
  setor?: string;

  @IsOptional()
  @IsNumber()
  marketCapMin?: number;

  /**
   * Filtros de faixa espelhando os campos da busca avançada da Status Invest (dy, p_l, roe,
   * roic, roa, peg_ratio, p_vp, margens, endividamento, liquidez etc — ver
   * FILTROS_AVANCADOS_CONFIG). Chave = mesmo nome do campo em StatusInvestItem.
   * Objeto solto (não uma classe com @Type) de propósito — são ~26 campos opcionais,
   * uma classe com um @IsOptional/@IsNumber por campo seria só ruído.
   */
  @IsOptional()
  @IsObject()
  filtrosAvancados?: Record<string, RangeFiltro>;
}
