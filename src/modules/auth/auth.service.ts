import {
  Injectable,
  Logger,
  ConflictException,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { AuthResponseDto, UserDto, ValidateTokenResponseDto } from './dto/validate-token.dto';

const BCRYPT_ROUNDS = 12;
const RESET_TOKEN_EXPIRY_MINUTES = 15;

interface JwtPayload {
  sub: string;
  userId: string;
  email: string;
  name: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async register(dto: RegisterDto): Promise<AuthResponseDto> {
    const existing = await this.prisma.user.findUnique({
      where: { primaryEmail: dto.email },
    });

    if (existing) {
      throw new ConflictException('E-mail já cadastrado');
    }

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    const user = await this.prisma.user.create({
      data: {
        displayName: dto.name,
        primaryEmail: dto.email,
        passwordHash,
      },
    });

    this.logger.log(`Usuário registrado: uuid_usuario=${user.uuid_usuario}`);
    const accessToken = await this.generateToken(user);
    return { accessToken, user: this.toUserDto(user) };
  }

  async login(dto: LoginDto): Promise<AuthResponseDto> {
    const user = await this.prisma.user.findUnique({
      where: { primaryEmail: dto.email },
    });

    if (!user || !user.passwordHash) {
      throw new UnauthorizedException('Credenciais inválidas');
    }

    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Credenciais inválidas');
    }

    const accessToken = await this.generateToken(user);
    return { accessToken, user: this.toUserDto(user) };
  }

  async validateToken(token: string): Promise<ValidateTokenResponseDto> {
    try {
      const payload = await this.jwtService.verifyAsync<JwtPayload>(token, {
        secret: process.env.JWT_SECRET || 'change-me',
      });

      const user = await this.prisma.user.findUnique({
        where: { uuid_usuario: payload.userId },
      });

      if (!user) return { valid: false };

      return { valid: true, user: this.toUserDto(user) };
    } catch {
      return { valid: false };
    }
  }

  async forgotPassword(email: string): Promise<{ message: string; resetUrl?: string }> {
    const user = await this.prisma.user.findUnique({ where: { primaryEmail: email } });

    const genericMessage = 'Se este e-mail estiver cadastrado, você receberá um link de redefinição em breve.';

    if (!user || !user.passwordHash) return { message: genericMessage };

    await this.prisma.passwordResetToken.updateMany({
      where: { userId: user.uuid_usuario, usedAt: null },
      data: { usedAt: new Date() },
    });

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + RESET_TOKEN_EXPIRY_MINUTES * 60 * 1000);

    await this.prisma.passwordResetToken.create({
      data: { userId: user.uuid_usuario, token, expiresAt },
    });

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:4200';
    const resetUrl = `${frontendUrl}/reset-password?token=${token}`;

    this.logger.log(`Reset link para ${email}: ${resetUrl}`);

    return {
      message: genericMessage,
      ...(process.env.NODE_ENV !== 'production' && { resetUrl }),
    };
  }

  async resetPassword(token: string, newPassword: string): Promise<{ message: string }> {
    const record = await this.prisma.passwordResetToken.findUnique({
      where: { token },
      include: { user: true },
    });

    if (!record || record.usedAt || record.expiresAt < new Date()) {
      throw new BadRequestException('Link de redefinição inválido ou expirado.');
    }

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

    await this.prisma.user.update({
      where: { uuid_usuario: record.userId },
      data: { passwordHash },
    });

    await this.prisma.passwordResetToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    });

    this.logger.log(`Senha redefinida para userId=${record.userId}`);

    return { message: 'Senha redefinida com sucesso.' };
  }

  private async generateToken(user: { uuid_usuario: string; primaryEmail: string; displayName: string }): Promise<string> {
    const payload: JwtPayload = {
      sub:    user.uuid_usuario,
      userId: user.uuid_usuario,
      email:  user.primaryEmail,
      name:   user.displayName,
    };
    return this.jwtService.signAsync(payload, { expiresIn: '7d' });
  }

  private toUserDto(user: { uuid_usuario: string; displayName: string; primaryEmail: string; avatarUrl: string | null }): UserDto {
    return {
      id: user.uuid_usuario,
      displayName: user.displayName,
      primaryEmail: user.primaryEmail,
      avatarUrl: user.avatarUrl ?? undefined,
    };
  }
}
