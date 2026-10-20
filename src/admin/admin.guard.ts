import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { JwtGuard, type AuthUser } from '../auth/auth.js';
import { DB, type Db } from '../db/db.module.js';
import { users } from '../db/schema.js';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtGuard,
    @Inject(DB) private readonly db: Db,
  ) {}

  async canActivate(context: ExecutionContext) {
    this.jwt.canActivate(context);
    const request = context.switchToHttp().getRequest<{ user: AuthUser }>();
    const account = await this.db.query.users.findFirst({
      where: eq(users.id, request.user.id),
      columns: { role: true },
    });
    if (account?.role !== 'admin') throw new ForbiddenException('Admin access required');
    return true;
  }
}
