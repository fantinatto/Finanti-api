import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsDateString, IsIn, IsNumber, IsOptional, IsString, Min, MinLength, ValidateNested } from 'class-validator';

const TIPOS_RENTABILIDADE_VALIDOS = ['cdi', 'prefixado'] as const;

export class CenarioSimulacaoDto {
  @IsString()
  @MinLength(1)
  nome: string;

  @IsNumber()
  @Min(0)
  valorInvestido: number;

  @IsIn(TIPOS_RENTABILIDADE_VALIDOS)
  tipoRentabilidade: (typeof TIPOS_RENTABILIDADE_VALIDOS)[number];

  @IsNumber()
  @Min(0)
  percentualOuTaxa: number;

  @IsDateString()
  dataAplicacao: string;

  @IsDateString()
  dataVencimento: string;

  @IsOptional()
  @IsBoolean()
  isentoIr?: boolean;
}

export class SimularRendaFixaDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CenarioSimulacaoDto)
  cenarios: CenarioSimulacaoDto[];

  /** Default: hoje (server). Permite simular "quanto valeria se eu já tivesse vendido ontem". */
  @IsOptional()
  @IsDateString()
  dataReferencia?: string;
}
