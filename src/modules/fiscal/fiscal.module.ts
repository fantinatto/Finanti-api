import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FiscalController } from './fiscal.controller';
import { FiscalService } from './services/fiscal.service';

@Module({
  imports: [AuthModule],
  controllers: [FiscalController],
  providers: [FiscalService],
  exports: [FiscalService],
})
export class FiscalModule {}
