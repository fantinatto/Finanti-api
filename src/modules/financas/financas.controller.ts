import { Body, Controller, Delete, Get, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { FinancasService } from './services/financas.service';
import { UpsertGastoDto } from './dto/upsert-gasto.dto';
import { UpsertGanhoDto } from './dto/upsert-ganho.dto';

@Controller('financas')
@UseGuards(JwtAuthGuard)
export class FinancasController {
  constructor(private readonly financas: FinancasService) {}

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
}
