import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { CurrentUser, JwtGuard, type AuthUser } from '../auth/auth.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { ApiEndpoint } from '../common/api-docs.decorator.js';
import { UpdateUserProfile, UsersService } from './users.service.js';

@Controller('users')
@UseGuards(JwtGuard)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  @ApiEndpoint({ tag: 'Users', summary: 'Get the signed-in user profile', security: 'bearer', errors: [401, 404] })
  getProfile(@CurrentUser() user: AuthUser) {
    return this.users.getProfile(user.id);
  }

  @Patch('me')
  @ApiEndpoint({ tag: 'Users', summary: 'Update the signed-in user name', security: 'bearer', errors: [400, 401, 404] })
  updateProfile(@CurrentUser() user: AuthUser, @Body(new ZodPipe(UpdateUserProfile)) profile: UpdateUserProfile) {
    return this.users.updateProfile(user.id, profile);
  }
}
