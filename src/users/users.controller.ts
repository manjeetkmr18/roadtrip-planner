import { Body, Controller, Delete, Get, HttpCode, Patch, UseGuards } from '@nestjs/common';
import { CurrentUser, JwtGuard, type AuthUser } from '../auth/auth.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { ApiEndpoint } from '../common/api-docs.decorator.js';
import { DeleteAccountRequest, UpdateUserProfile, UsersService } from './users.service.js';

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

  @Delete('me')
  @HttpCode(200)
  @ApiEndpoint({ tag: 'Users', summary: 'Delete the signed-in account and all its trips (cancels a web subscription first)', security: 'bearer', errors: [400, 401, 404, 409, 503] })
  deleteAccount(@CurrentUser() user: AuthUser, @Body(new ZodPipe(DeleteAccountRequest)) body: DeleteAccountRequest) {
    return this.users.deleteAccount(user.id, body);
  }
}
