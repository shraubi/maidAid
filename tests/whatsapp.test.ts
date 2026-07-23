import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  extractIncomingMessages,
  verifyMetaSignature,
} from "../src/integrations/whatsapp.js";

describe("WhatsApp integration", () => {
  it("extracts text and button replies", () => {
    const messages = extractIncomingMessages({
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  { id: "1", from: "336", type: "text", text: { body: "итог" } },
                  {
                    id: "2",
                    from: "336",
                    type: "interactive",
                    interactive: {
                      type: "button_reply",
                      button_reply: { id: "confirm", title: "Подтвердить" },
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(messages).toEqual([
      { id: "1", from: "336", text: "итог" },
      { id: "2", from: "336", text: "Подтвердить", actionId: "confirm" },
    ]);
  });

  it("verifies Meta's webhook signature", () => {
    const body = '{"hello":"world"}';
    const secret = "secret";
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    expect(verifyMetaSignature(body, signature, secret)).toBe(true);
    expect(verifyMetaSignature(body, "sha256=bad", secret)).toBe(false);
  });
});
