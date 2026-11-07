import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { FiscalService } from './services/fiscal.service';
import { UpsertOperacaoFiscalDto } from './dto/upsert-operacao-fiscal.dto';
import { UpsertAtivoFiscalDto, UpsertConfigFiscalDto } from './dto/upsert-ativo-fiscal.dto';
import { BensDireitosService } from './services/bens-direitos.service';

@Controller('fiscal')
@UseGuards(JwtAuthGuard)
export class FiscalController {
  constructor(
    private readonly fiscal: FiscalService,
    private readonly bensDireitos: BensDireitosService,
  ) {}

  @Get('operacoes')
  async listar(@Req() req: Request, @Query('ano') ano?: string) {
    return this.fiscal.listar(req['user'].sub, ano ? Number(ano) : undefined);
  }

  @Post('operacoes')
  async criar(@Req() req: Request, @Body() dto: UpsertOperacaoFiscalDto) {
    return this.fiscal.criar(req['user'].sub, dto);
  }

  @Put('operacoes/:id')
  async atualizar(@Req() req: Request, @Param('id') id: string, @Body() dto: UpsertOperacaoFiscalDto) {
    return this.fiscal.atualizar(req['user'].sub, id, dto);
  }

  @Delete('operacoes/:id')
  async remover(@Req() req: Request, @Param('id') id: string) {
    await this.fiscal.remover(req['user'].sub, id);
    return { ok: true };
  }

  @Get('apuracao')
  async apuracao(@Req() req: Request, @Query('ano') ano: string) {
    return this.fiscal.getApuracaoAnual(req['user'].sub, Number(ano));
  }

  @Get('bens-direitos')
  async getBensDireitos(@Req() req: Request, @Query('ano') ano: string) {
    return this.bensDireitos.getBensDireitos(req['user'].sub, Number(ano));
  }

  @Put('ativos/:ticker')
  async upsertAtivo(@Req() req: Request, @Param('ticker') ticker: string, @Body() dto: UpsertAtivoFiscalDto) {
    return this.bensDireitos.upsertAtivo(req['user'].sub, ticker, dto);
  }

  @Get('config')
  async getConfig(@Req() req: Request) {
    return this.bensDireitos.getConfig(req['user'].sub);
  }

  @Put('config')
  async upsertConfig(@Req() req: Request, @Body() dto: UpsertConfigFiscalDto) {
    return this.bensDireitos.upsertConfig(req['user'].sub, dto);
  }
}
