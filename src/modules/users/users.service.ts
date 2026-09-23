import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { UpdateProfileDto } from './dto/update-profile.dto';

const ME_SELECT = {
  uuid_usuario: true,
  displayName: true,
  primaryEmail: true,
  avatarUrl: true,
  birthDate: true,
  createdAt: true,
} as const;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async getMe(userId: string) {
    return this.prisma.user.findUniqueOrThrow({
      where: { uuid_usuario: userId },
      select: ME_SELECT,
    });
  }

  async updateMe(userId: string, dto: UpdateProfileDto) {
    return this.prisma.user.update({
      where: { uuid_usuario: userId },
      data: {
        displayName: dto.displayName,
        avatarUrl: dto.avatarUrl,
        birthDate: dto.birthDate ? new Date(dto.birthDate) : undefined,
      },
      select: ME_SELECT,
    });
  }
}
