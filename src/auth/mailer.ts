import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { ENV, type Env } from '../config/env.js';

export interface Email {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Sends account emails through Amazon SES (EMAIL_FROM + AWS credentials). Local development
 * prints the email to the console; production never falls back to logging verification codes.
 */
@Injectable()
export class Mailer {
  private readonly log = new Logger(Mailer.name);
  private readonly ses?: SESv2Client;
  /** Last email "sent" in console mode, for tests and local scripts. */
  last?: Email;

  constructor(@Inject(ENV) private readonly env: Env) {
    const region = env.SES_REGION ?? env.AWS_REGION;
    if (env.EMAIL_FROM && region) this.ses = new SESv2Client({ region });
  }

  get configured() {
    return !!this.ses;
  }

  async send(mail: Email): Promise<void> {
    if (!this.ses) {
      if (this.env.VERCEL || this.env.NODE_ENV === 'production') {
        throw new ServiceUnavailableException('Email is not set up yet (EMAIL_FROM). Please try again later.');
      }
      this.last = mail;
      this.log.log(`[email not configured: printing instead]\nTo: ${mail.to}\nSubject: ${mail.subject}\n\n${mail.text}`);
      return;
    }
    await this.ses.send(
      new SendEmailCommand({
        FromEmailAddress: this.env.EMAIL_FROM,
        Destination: { ToAddresses: [mail.to] },
        Content: {
          Simple: {
            Subject: { Data: mail.subject, Charset: 'UTF-8' },
            Body: { Text: { Data: mail.text, Charset: 'UTF-8' }, Html: { Data: mail.html, Charset: 'UTF-8' } },
          },
        },
      }),
    );
  }
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** A short email with one big code; plain text plus a simple HTML version. */
export function codeEmail(kind: 'verify' | 'reset', to: string, code: string, minutes: number): Email {
  const verify = kind === 'verify';
  const subject = verify ? `${code} is your Travlio verification code` : `${code} is your Travlio password reset code`;
  const lead = verify ? 'Enter this code in Travlio to confirm your email address:' : 'Enter this code in Travlio to choose a new password:';
  const foot = verify
    ? "If you didn't create a Travlio account, you can ignore this email."
    : "If you didn't ask to reset your password, you can ignore this email; your password stays the same.";
  const text = `${lead}\n\n${code}\n\nThe code works for ${minutes} minutes.\n\n${foot}\n\nTravlio · travlio.app`;
  const html = `<!doctype html><html><body style="margin:0;background:#F3F0E8;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#17201C">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" style="max-width:480px;background:#FFFFFF;border:1px solid #DDD8CC;border-radius:16px" cellpadding="0" cellspacing="0"><tr><td style="padding:28px">
<p style="margin:0 0 18px;font-size:20px;font-weight:600;color:#1F4D3A">travlio</p>
<p style="margin:0 0 18px;font-size:15px;line-height:1.5">${esc(lead)}</p>
<p style="margin:0 0 18px;font-size:34px;font-weight:700;letter-spacing:8px;font-family:Menlo,Consolas,monospace">${esc(code)}</p>
<p style="margin:0 0 18px;font-size:14px;color:#6B726C">The code works for ${minutes} minutes.</p>
<p style="margin:0;font-size:13px;color:#6B726C;line-height:1.5">${esc(foot)}</p>
</td></tr></table>
<p style="margin:16px 0 0;font-size:12px;color:#6B726C">Sent to ${esc(to)} · travlio.app</p>
</td></tr></table></body></html>`;
  return { to, subject, text, html };
}
