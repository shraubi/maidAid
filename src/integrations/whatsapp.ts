import { createHmac, timingSafeEqual } from "node:crypto";
import type { BotResponse } from "../domain/types.js";

interface IncomingMessage {
  id: string;
  from: string;
  text: string;
  actionId?: string;
}

export function verifyMetaSignature(rawBody: string, signature: string | undefined, secret?: string): boolean {
  if (!secret) return true;
  if (!signature?.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function extractIncomingMessages(body: unknown): IncomingMessage[] {
  const result: IncomingMessage[] = [];
  const payload = body as {
    entry?: Array<{
      changes?: Array<{
        value?: {
          messages?: Array<{
            id?: string;
            from?: string;
            type?: string;
            text?: { body?: string };
            interactive?: {
              type?: string;
              button_reply?: { id?: string; title?: string };
              list_reply?: { id?: string; title?: string };
            };
          }>;
        };
      }>;
    }>;
  };
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const message of change.value?.messages ?? []) {
        if (!message.id || !message.from) continue;
        if (message.type === "text" && message.text?.body) {
          result.push({ id: message.id, from: message.from, text: message.text.body });
        } else if (message.type === "interactive") {
          const reply = message.interactive?.button_reply ?? message.interactive?.list_reply;
          if (reply?.id) {
            result.push({
              id: message.id,
              from: message.from,
              text: reply.title ?? reply.id,
              actionId: reply.id,
            });
          }
        }
      }
    }
  }
  return result;
}

export class WhatsAppClient {
  constructor(
    private readonly accessToken: string,
    private readonly phoneNumberId: string,
    private readonly apiVersion: string,
    private readonly allowedRecipient: string,
  ) {}

  async send(response: BotResponse): Promise<void> {
    const body = response.buttons?.length
      ? {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: this.allowedRecipient,
          type: "interactive",
          interactive: {
            type: "button",
            body: { text: response.text },
            action: {
              buttons: response.buttons.slice(0, 3).map((button) => ({
                type: "reply",
                reply: { id: button.id, title: button.title.slice(0, 20) },
              })),
            },
          },
        }
      : {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: this.allowedRecipient,
          type: "text",
          text: { preview_url: false, body: response.text },
        };
    const result = await fetch(
      `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    if (!result.ok) {
      const details = await result.text();
      throw new Error(`WhatsApp API ${result.status}: ${details}`);
    }
  }
}
