import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, Min, ValidateNested } from 'class-validator';

export class AlocacaoItemDto {
  @IsString()
  nome: string; // setor ou segmento de FII

  @IsNumber()
  @Min(0)
  @Max(100)
  percentual: number;
}

const REGRAS_VALIDAS = ['base80', 'base100', 'base110', 'base120', 'base_di', 'base_custom'] as const;
const TIPOS_RANKING_VALIDOS = ['setor', 'segmento', 'geral', 'hibrido'] as const;

export class UpsertPortfolioConfigDto {
  @IsNumber()
  @Min(0)
  @Max(100)
  percentualRendaFixa: number;

  @IsNumber()
  @Min(0)
  @Max(100)
  percentualFiis: number;

  @IsNumber()
  @Min(0)
  @Max(100)
  percentualAcoes: number;

  @IsNumber()
  @Min(0)
  @Max(100)
  percentualEstouro: number;

  @IsOptional()
  @IsIn(REGRAS_VALIDAS)
  regraSelecionada?: (typeof REGRAS_VALIDAS)[number];

  @IsOptional()
  @IsInt()
  baseRegraCustom?: number;

  @IsOptional()
  @IsIn(TIPOS_RANKING_VALIDOS)
  tipoRankingRecomendacao?: (typeof TIPOS_RANKING_VALIDOS)[number];

  /** false = recomendações e execuções na Simulação só operam em múltiplos de 100 ações. */
  @IsOptional()
  @IsBoolean()
  permiteFracionario?: boolean;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AlocacaoItemDto)
  alocacoesSetor: AlocacaoItemDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AlocacaoItemDto)
  alocacoesSegmentoFii: AlocacaoItemDto[];
}
