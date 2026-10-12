import {
  CanActivate,
  ConflictException,
  Controller,
  createParamDecorator,
  ExecutionContext,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Module,
  Post,
  Body,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { DB, type Db } from '../db/db.module.js';
import { users } from '../db/schema.js';
import { ENV, type Env } from '../config/env.js';
import { ZodPipe } from '../common/zod.pipe.js';

export interface AuthUser {
  id: string;
  email: string;
  plan: string;
}

const Credentials = z.object({
  email: z.email().transform((e) => e.toLowerCase()),
  password: z.string().min(8).max(200),
  name: z.string().max(80).optional(),
});
type Credentials = z.infer<typeof Credentials>;

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly jwt: JwtService,
  ) {}

  private token(u: { id: string; email: string; plan: string }) {
    return this.jwt.sign({ sub: u.id, email: u.email, plan: u.plan });
  }

  async register(c: Credentials) {
    const existing = await this.db.query.users.findFirst({ where: eq(users.email, c.email) });
    if (existing) throw new ConflictException('An account with this email already exists');
    const [u] = await this.db
      .insert(users)
      .values({ email: c.email, name: c.name, passwordHash: await bcrypt.hash(c.password, 10) })
      .returning();
    return { token: this.token(u), user: { id: u.id, email: u.email, name: u.name, plan: u.plan } };
  }

  async login(c: Credentials) {
    const u = await this.db.query.users.findFirst({ where: eq(users.email, c.email) });
    if (!u || !(await bcrypt.compare(c.password, u.passwordHash))) throw new UnauthorizedException('Wrong email or password');
    return { token: this.token(u), user: { id: u.id, email: u.email, name: u.name, plan: u.plan } };
  }

  verify(token: string): AuthUser {
    const p = this.jwt.verify<{ sub: string; email: string; plan: string }>(token);
    return { id: p.sub, email: p.email, plan: p.plan };
  }
}

@Injectable()
export class JwtGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers['authorization'];
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Sign in required');
    try {
      req.user = this.auth.verify(header.slice(7));
      return true;
    } catch {
      throw new UnauthorizedException('Session expired, please sign in again');
    }
  }
}

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user);

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  register(@Body(new ZodPipe(Credentials)) body: Credentials) {
    return this.auth.register(body);
  }

  @Post('login')
  @HttpCode(200)
  login(@Body(new ZodPipe(Credentials.omit({ name: true }))) body: Credentials) {
    return this.auth.login(body);
  }

  @Get('me')
  @UseGuards(JwtGuard)
  me(@CurrentUser() user: AuthUser) {
    return user;
  }
}

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({ secret: env.JWT_SECRET, signOptions: { expiresIn: env.JWT_EXPIRES_IN as never } }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtGuard],
  exports: [AuthService, JwtGuard],
})
export class AuthModule {}
