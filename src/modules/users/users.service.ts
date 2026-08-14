import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async getMe(userId: string) {
    return this.prisma.user.findUniqueOrThrow({
      where: { uuid_usuario: userId },
      select: {
        uuid_usuario: true,
        displayName: true,
        primaryEmail: true,
        avatarUrl: true,
        createdAt: true,
      },
    });
  }
}
