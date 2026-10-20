import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FinancasController } from './financas.controller';
import { FinancasService } from './services/financas.service';
import { ImportacaoFaturaService } from './services/importacao-fatura.service';

@Module({
  imports: [AuthModule],
  controllers: [FinancasController],
  providers: [FinancasService, ImportacaoFaturaService],
})
export class FinancasModule {}
