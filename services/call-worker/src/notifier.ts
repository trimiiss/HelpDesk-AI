import nodemailer from 'nodemailer';

export interface CallbackMessage {
  name: string;
  phone: string;
  message: string;
  callSid: string;
}

/** Add another channel, such as SMS or a webhook, by implementing this one method. */
export interface Notifier {
  send(message: CallbackMessage): Promise<void>;
}

export interface EmailNotifierOptions {
  smtpUrl: string;
  from: string;
  to: string;
}

/** Caller text stays in a plain-text body. It's untrusted, so it never goes in a header or HTML. */
export function formatEmail(message: CallbackMessage): { subject: string; text: string } {
  return {
    subject: 'New callback message from your phone assistant',
    text: [
      'A caller left a message.',
      '',
      `Name: ${message.name}`,
      `Phone: ${message.phone}`,
      '',
      'Message:',
      message.message,
      '',
      `Call reference: ${message.callSid}`,
    ].join('\n'),
  };
}

export function createEmailNotifier(options: EmailNotifierOptions): Notifier {
  const transport = nodemailer.createTransport(options.smtpUrl);

  return {
    async send(message) {
      await transport.sendMail({
        from: options.from,
        to: options.to,
        ...formatEmail(message),
      });
    },
  };
}
