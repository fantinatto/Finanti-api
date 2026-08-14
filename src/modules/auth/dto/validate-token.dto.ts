export class UserDto {
  id: string;
  displayName: string;
  primaryEmail: string;
  avatarUrl?: string;
}

export class AuthResponseDto {
  accessToken: string;
  user: UserDto;
}

export class ValidateTokenResponseDto {
  valid: boolean;
  user?: UserDto;
}
