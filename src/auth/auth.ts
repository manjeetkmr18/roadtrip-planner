import {
  BadRequestException,
  CanActivate,
  ConflictException,
  Controller,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  Module,
  Post,
  Body,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DB, type Db } from '../db/db.module.js';
import { authCodes, users } from '../db/schema.js';
import { ENV, type Env } from '../config/env.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { clientIp, RateLimiter } from '../common/rate-limit.js';
import { ensureAuthSchema } from './auth-schema.js';
import { codeEmail, Mailer } from './mailer.js';

export interface AuthUser {
  id: string;
  email: string;
  plan: string;
  /** From the token; may be stale (false) right after the user verifies on another device. */
  emailVerified?: boolean;
}

const email = z.email().transform((e) => e.toLowerCase().trim());
const password = z.string().min(8, 'Use at least 8 characters').max(200);
const code = z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code');

const Credentials = z.object({ email, password, name: z.string().max(80).optional() });
type Credentials = z.infer<typeof Credentials>;
const VerifyBody = z.object({ code });
const ForgotBody = z.object({ email });
const ResetBody = z.object({ email, code, password });

type Purpose = 'verify_email' | 'reset_password';
const CODE_MINUTES: Record<Purpose, number> = { verify_email: 30, reset_password: 15 };
const MAX_ATTEMPTS = 5;
/** A new code can be sent at most once a minute per account (checked in the database, so it holds across instances). */
const RESEND_SECONDS = 60;

type UserRow = typeof users.$inferSelect;
const publicUser = (u: UserRow) => ({ id: u.id, email: u.email, name: u.name, plan: u.plan, emailVerified: !!u.emailVerifiedAt });

@Injectable()
export class AuthService {
  private readonly log = new Logger(AuthService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
    private readonly jwt: JwtService,
    private readonly mailer: Mailer,
  ) {}

  private token(u: UserRow) {
    return this.jwt.sign({ sub: u.id, email: u.email, plan: u.plan, ev: !!u.emailVerifiedAt });
  }

  private session(u: UserRow) {
    return { token: this.token(u), user: publicUser(u) };
  }

  private hash(purpose: Purpose, userId: string, c: string) {
    return createHmac('sha256', this.env.JWT_SECRET).update(`${purpose}:${userId}:${c}`).digest('hex');
  }

  private async findByEmail(e: string) {
    await ensureAuthSchema(this.db);
    return this.db.query.users.findFirst({ where: eq(users.email, e) });
  }

  /** Emails a fresh code (replacing any earlier one). Returns false when one was sent under a minute ago. */
  private async sendCode(u: UserRow, purpose: Purpose): Promise<boolean> {
    const c = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`auth-code:${u.id}:${purpose}`}, 0))`);
      const recent = await tx.query.authCodes.findFirst({
        where: and(
          eq(authCodes.userId, u.id),
          eq(authCodes.purpose, purpose),
          gt(authCodes.createdAt, new Date(Date.now() - RESEND_SECONDS * 1000)),
        ),
      });
      if (recent) return null;
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      const minutes = CODE_MINUTES[purpose];
      await tx.delete(authCodes).where(and(eq(authCodes.userId, u.id), eq(authCodes.purpose, purpose)));
      await tx.insert(authCodes).values({
        userId: u.id,
        purpose,
        codeHash: this.hash(purpose, u.id, code),
        expiresAt: new Date(Date.now() + minutes * 60_000),
      });
      return code;
    });
    if (!c) return false;
    const minutes = CODE_MINUTES[purpose];
    await this.mailer.send(codeEmail(purpose === 'verify_email' ? 'verify' : 'reset', u.email, c, minutes));
    return true;
  }

  /** Checks a code; each wrong guess counts, and a code dies after 5 wrong guesses or when it expires. */
  private async useCode(u: UserRow, purpose: Purpose, c: string) {
    const row = await this.db.query.authCodes.findFirst({ where: and(eq(authCodes.userId, u.id), eq(authCodes.purpose, purpose)) });
    const bad = (msg: string) => new BadRequestException({ message: msg, code: 'BAD_CODE' });
    if (!row || row.expiresAt < new Date() || row.attempts >= MAX_ATTEMPTS) throw bad('That code has expired. Send a new one.');
    const a = Buffer.from(row.codeHash, 'hex');
    const b = Buffer.from(this.hash(purpose, u.id, c), 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      const [updated] = await this.db
        .update(authCodes)
        .set({ attempts: sql`${authCodes.attempts} + 1` })
        .where(and(eq(authCodes.id, row.id), lt(authCodes.attempts, MAX_ATTEMPTS), gt(authCodes.expiresAt, new Date())))
        .returning({ attempts: authCodes.attempts });
      if (!updated) throw bad('That code has expired. Send a new one.');
      const left = MAX_ATTEMPTS - updated.attempts;
      throw bad(left > 0 ? `That code isn't right. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Too many wrong codes. Send a new one.');
    }
    const [consumed] = await this.db
      .delete(authCodes)
      .where(and(eq(authCodes.id, row.id), lt(authCodes.attempts, MAX_ATTEMPTS), gt(authCodes.expiresAt, new Date())))
      .returning({ id: authCodes.id });
    if (!consumed) throw bad('That code has expired. Send a new one.');
  }

  /** Verification is enabled whenever email is deliverable, including local console-based development. */
  get verificationOn() {
    return this.mailer.configured || (!this.env.VERCEL && this.env.NODE_ENV !== 'production');
  }

  async register(c: Credentials) {
    if (!this.verificationOn) {
      throw new ServiceUnavailableException('Email verification is unavailable. Please try again later.');
    }
    if (await this.findByEmail(c.email)) throw new ConflictException('An account with this email already exists');
    const [u] = await this.db
      .insert(users)
      .values({ email: c.email, name: c.name, passwordHash: await bcrypt.hash(c.password, 10), emailVerifiedAt: null })
      .returning();
    let codeSent = true;
    try {
      await this.sendCode(u, 'verify_email');
    } catch (e) {
      // The account exists either way; the verify screen offers "Send a new code".
      codeSent = false;
      this.log.error(`verification email to ${u.email} failed: ${(e as Error).message}`);
    }
    return { ...this.session(u), codeSent };
  }

  async login(c: Credentials) {
    const u = await this.findByEmail(c.email);
    if (!u || !(await bcrypt.compare(c.password, u.passwordHash))) throw new UnauthorizedException('Wrong email or password');
    return this.session(u);
  }

  async me(id: string) {
    await ensureAuthSchema(this.db);
    const u = await this.db.query.users.findFirst({ where: eq(users.id, id) });
    if (!u) throw new UnauthorizedException('Session expired, please sign in again');
    return publicUser(u);
  }

  async isVerified(id: string) {
    await ensureAuthSchema(this.db);
    const u = await this.db.query.users.findFirst({ where: eq(users.id, id), columns: { emailVerifiedAt: true } });
    return !!u?.emailVerifiedAt;
  }

  async verifyEmail(id: string, c: string) {
    await ensureAuthSchema(this.db);
    const u = await this.db.query.users.findFirst({ where: eq(users.id, id) });
    if (!u) throw new UnauthorizedException('Session expired, please sign in again');
    if (u.emailVerifiedAt) return this.session(u);
    await this.useCode(u, 'verify_email', c);
    const [v] = await this.db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, id)).returning();
    return this.session(v);
  }

  async resendVerification(id: string) {
    await ensureAuthSchema(this.db);
    const u = await this.db.query.users.findFirst({ where: eq(users.id, id) });
    if (!u) throw new UnauthorizedException('Session expired, please sign in again');
    if (u.emailVerifiedAt) return { sent: false, alreadyVerified: true };
    if (!(await this.sendCode(u, 'verify_email'))) throw new HttpException({ statusCode: 429, message: 'A code was just sent. Wait a minute before asking for another.' }, HttpStatus.TOO_MANY_REQUESTS);
    return { sent: true };
  }

  /** Always answers the same way, so it can't be used to find out which emails have accounts. */
  async forgotPassword(e: string) {
    // Without email delivery there's nothing to send (the same answer for every address).
    if (!this.verificationOn) throw new ServiceUnavailableException('Password reset by email isn\'t available yet. Please try again later.');
    const u = await this.findByEmail(e);
    if (u) {
      try {
        await this.sendCode(u, 'reset_password');
      } catch (err) {
        // Same answer either way, so a failure can't reveal that the account exists.
        this.log.error(`reset email to ${e} failed: ${(err as Error).message}`);
      }
    }
    return { sent: true };
  }

  async resetPassword(b: z.infer<typeof ResetBody>) {
    const u = await this.findByEmail(b.email);
    if (!u) throw new BadRequestException({ message: 'That code has expired. Send a new one.', code: 'BAD_CODE' });
    await this.useCode(u, 'reset_password', b.code);
    // The code proves they own the address, so this also verifies it.
    const [v] = await this.db
      .update(users)
      .set({ passwordHash: await bcrypt.hash(b.password, 10), emailVerifiedAt: u.emailVerifiedAt ?? new Date() })
      .where(eq(users.id, u.id))
      .returning();
    return this.session(v);
  }

  /** A verified throwaway account for the deployment check script (behind the docs login). */
  async testAccount() {
    await ensureAuthSchema(this.db);
    const e = `check-${Date.now()}-${randomInt(0, 1e9)}@example.com`;
    const [u] = await this.db
      .insert(users)
      .values({ email: e, name: 'API check', passwordHash: await bcrypt.hash(String(randomInt(0, 1e12)), 10), emailVerifiedAt: new Date() })
      .returning();
    return this.session(u);
  }

  verify(token: string): AuthUser {
    const p = this.jwt.verify<{ sub: string; email: string; plan: string; ev?: boolean }>(token);
    return { id: p.sub, email: p.email, plan: p.plan, emailVerified: p.ev };
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

/**
 * Signed in AND email verified. The token says so after verification; otherwise (older tokens, or
 * verified on another device) the database decides.
 */
@Injectable()
export class VerifiedGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtGuard,
    private readonly auth: AuthService,
  ) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    this.jwt.canActivate(ctx);
    const user: AuthUser = ctx.switchToHttp().getRequest().user;
    if (user.emailVerified || (await this.auth.isVerified(user.id))) return true;
    throw new ForbiddenException({ message: 'Verify your email to plan trips. We sent you a 6-digit code.', code: 'EMAIL_NOT_VERIFIED' });
  }
}

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user);

type Req = Parameters<typeof clientIp>[0];

@Controller('auth')
export class AuthController {
  /** Per-IP caps on the unauthenticated email endpoints (the database also allows one code a minute per account). */
  private readonly forgotLimit = new RateLimiter(10, 60 * 60 * 1000);
  private readonly resetLimit = new RateLimiter(20, 60 * 60 * 1000);

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
    return this.auth.me(user.id);
  }

  @Post('verify-email')
  @HttpCode(200)
  @UseGuards(JwtGuard)
  verifyEmail(@CurrentUser() user: AuthUser, @Body(new ZodPipe(VerifyBody)) body: z.infer<typeof VerifyBody>) {
    return this.auth.verifyEmail(user.id, body.code);
  }

  @Post('resend-verification')
  @HttpCode(200)
  @UseGuards(JwtGuard)
  resend(@CurrentUser() user: AuthUser) {
    return this.auth.resendVerification(user.id);
  }

  @Post('forgot-password')
  @HttpCode(200)
  forgot(@Req() req: Req, @Body(new ZodPipe(ForgotBody)) body: z.infer<typeof ForgotBody>) {
    limit(this.forgotLimit, req);
    return this.auth.forgotPassword(body.email);
  }

  @Post('reset-password')
  @HttpCode(200)
  reset(@Req() req: Req, @Body(new ZodPipe(ResetBody)) body: z.infer<typeof ResetBody>) {
    limit(this.resetLimit, req);
    return this.auth.resetPassword(body);
  }
}

function limit(l: RateLimiter, req: Req) {
  if (l.hit(clientIp(req))) throw new HttpException({ statusCode: 429, message: 'Too many attempts. Try again later.' }, HttpStatus.TOO_MANY_REQUESTS);
}

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({ secret: env.JWT_SECRET, signOptions: { expiresIn: env.JWT_EXPIRES_IN as never } }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtGuard, VerifiedGuard, Mailer],
  exports: [AuthService, JwtGuard, VerifiedGuard, Mailer],
})
export class AuthModule {}
