import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { ConfigService } from '@nestjs/config';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly configService: ConfigService,
  ) {}

  @Get()
  getHello(): string {
    // Exemplo de uso do ConfigService
    const envValue = this.configService.get<string>('MY_ENV_VAR');
    return this.appService.getHello() + (envValue ? ` - ${envValue}` : '');
    //return this.appService.getHello();
  }
}
