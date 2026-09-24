import { IsNumber, Min } from 'class-validator';

export class UpsertSimulacaoConfigDto {
  @IsNumber()
  @Min(0)
  aporteSemanalValor: number;
}
