import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { CurrentUser, JwtGuard, type AuthUser } from '../auth/auth.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { UpdateUserProfile, UsersService } from './users.service.js';

@Controller('users')
@UseGuards(JwtGuard)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  getProfile(@CurrentUser() user: AuthUser) {
    return this.users.getProfile(user.id);
  }

  @Patch('me')
  updateProfile(@CurrentUser() user: AuthUser, @Body(new ZodPipe(UpdateUserProfile)) profile: UpdateUserProfile) {
    return this.users.updateProfile(user.id, profile);
  }
}
