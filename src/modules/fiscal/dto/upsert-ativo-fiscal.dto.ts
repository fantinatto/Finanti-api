import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Campos vazios/omitidos gravam null. CNPJ aceita com ou sem pontuação (validado no service). */
export class UpsertAtivoFiscalDto {
  @IsOptional()
  @IsString()
  @MaxLength(20)
  cnpj?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  razaoSocial?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  administrador?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  cnpjAdministrador?: string;
}

export class UpsertConfigFiscalDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  corretoraNome?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  corretoraCnpj?: string;
}
