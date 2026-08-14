import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));

  // CORS
  app.enableCors({
    origin: [
      'http://localhost:4200',
      'https://fantinatto.net',
      'https://www.fantinatto.net',
      'https://fantiup.com',
      'https://www.fantiup.com',
      /^https:\/\/.*\.vercel\.app$/,
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  });

  await app.init();
  return app;
}

// Para desenvolvimento local
if (require.main === module) {
  bootstrap().then(app => {
    const port = process.env.PORT || 3000;
    app.listen(port);
    console.log(`Application running on port ${port}`);
  });
}

// Para Vercel (serverless)
export default async (req, res) => {
  const app = await bootstrap();
  const server = app.getHttpAdapter().getInstance();
  return server(req, res);
};
