import { BadRequestException, Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Query, Req, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { FinancasService } from './services/financas.service';
import { UpsertGastoDto } from './dto/upsert-gasto.dto';
import { UpsertGanhoDto } from './dto/upsert-ganho.dto';
import { AtualizarCategoriaTransacaoDto } from './dto/atualizar-categoria-transacao.dto';

const TAMANHO_MAXIMO_FATURA = 10 * 1024 * 1024; // 10MB

@Controller('financas')
@UseGuards(JwtAuthGuard)
export class FinancasController {
  constructor(private readonly financas: FinancasService) {}

  // Rotas literais (ex: 'historico') precisam vir ANTES de ':anoMes' — Nest casa rotas na
  // ordem declarada, e ':anoMes' (1 segmento) casaria com "/financas/historico" primeiro.
  @Get('historico')
  async getHistorico(@Req() req: Request, @Query('meses', new ParseIntPipe({ optional: true })) meses?: number) {
    return this.financas.getHistorico(req['user'].sub, meses ?? 12);
  }

  @Get(':anoMes')
  async getMes(@Req() req: Request, @Param('anoMes') anoMes: string) {
    return this.financas.getMes(req['user'].sub, anoMes);
  }

  @Post(':anoMes/gastos')
  async criarGasto(@Req() req: Request, @Param('anoMes') anoMes: string, @Body() dto: UpsertGastoDto) {
    return this.financas.criarGasto(req['user'].sub, anoMes, dto);
  }

  @Put('gastos/:id')
  async atualizarGasto(@Req() req: Request, @Param('id') id: string, @Body() dto: UpsertGastoDto) {
    return this.financas.atualizarGasto(req['user'].sub, id, dto);
  }

  @Delete('gastos/:id')
  async removerGasto(@Req() req: Request, @Param('id') id: string): Promise<{ ok: boolean }> {
    await this.financas.removerGasto(req['user'].sub, id);
    return { ok: true };
  }

  @Post(':anoMes/ganhos')
  async criarGanho(@Req() req: Request, @Param('anoMes') anoMes: string, @Body() dto: UpsertGanhoDto) {
    return this.financas.criarGanho(req['user'].sub, anoMes, dto);
  }

  @Put('ganhos/:id')
  async atualizarGanho(@Req() req: Request, @Param('id') id: string, @Body() dto: UpsertGanhoDto) {
    return this.financas.atualizarGanho(req['user'].sub, id, dto);
  }

  @Delete('ganhos/:id')
  async removerGanho(@Req() req: Request, @Param('id') id: string): Promise<{ ok: boolean }> {
    await this.financas.removerGanho(req['user'].sub, id);
    return { ok: true };
  }

  @Post(':anoMes/fechar')
  async fecharMes(@Req() req: Request, @Param('anoMes') anoMes: string): Promise<{ ok: boolean }> {
    await this.financas.fecharMes(req['user'].sub, anoMes);
    return { ok: true };
  }

  @Delete(':anoMes/fechar')
  async reabrirMes(@Req() req: Request, @Param('anoMes') anoMes: string): Promise<{ ok: boolean }> {
    await this.financas.reabrirMes(req['user'].sub, anoMes);
    return { ok: true };
  }

  @Post(':anoMes/importar-fatura')
  @UseInterceptors(FileInterceptor('arquivo', { limits: { fileSize: TAMANHO_MAXIMO_FATURA } }))
  async importarFatura(@Req() req: Request, @Param('anoMes') anoMes: string, @UploadedFile() arquivo?: Express.Multer.File) {
    if (!arquivo) throw new BadRequestException('Nenhum arquivo enviado.');
    if (arquivo.mimetype !== 'application/pdf') throw new BadRequestException('Só é aceito arquivo PDF.');
    return this.financas.importarFatura(req['user'].sub, anoMes, arquivo.buffer, arquivo.originalname);
  }

  @Get(':anoMes/transacoes-cartao')
  async listarTransacoesCartao(@Req() req: Request, @Param('anoMes') anoMes: string) {
    return this.financas.listarTransacoesCartao(req['user'].sub, anoMes);
  }

  @Get(':anoMes/transacoes-cartao/resumo-categoria')
  async getResumoCategoria(@Req() req: Request, @Param('anoMes') anoMes: string) {
    return this.financas.getResumoCategoria(req['user'].sub, anoMes);
  }

  // Rota literal — precisa vir antes de 'transacoes-cartao/:id' por consistência (mesmo
  // princípio de 'historico' antes de ':anoMes'), mesmo não havendo POST em ':id' hoje.
  @Post('transacoes-cartao/recalcular-previsoes')
  async recalcularPrevisoesParcelas(@Req() req: Request) {
    return this.financas.recalcularPrevisoesParcelas(req['user'].sub);
  }

  @Put('transacoes-cartao/:id')
  async atualizarCategoriaTransacao(@Req() req: Request, @Param('id') id: string, @Body() dto: AtualizarCategoriaTransacaoDto) {
    return this.financas.atualizarCategoriaTransacao(req['user'].sub, id, dto);
  }

  @Delete('transacoes-cartao/:id')
  async removerTransacaoCartao(@Req() req: Request, @Param('id') id: string): Promise<{ ok: boolean }> {
    await this.financas.removerTransacaoCartao(req['user'].sub, id);
    return { ok: true };
  }

  @Post('transacoes-cartao/:id/nao-reconhecida')
  async marcarNaoReconhecida(@Req() req: Request, @Param('id') id: string) {
    return this.financas.marcarNaoReconhecida(req['user'].sub, id, true);
  }

  @Delete('transacoes-cartao/:id/nao-reconhecida')
  async desmarcarNaoReconhecida(@Req() req: Request, @Param('id') id: string) {
    return this.financas.marcarNaoReconhecida(req['user'].sub, id, false);
  }
}
