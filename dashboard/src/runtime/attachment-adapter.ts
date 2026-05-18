import type { AttachmentAdapter, CompleteAttachment, PendingAttachment } from "@assistant-ui/react";
import type { GatewayClient } from "@/gateway-client";

const ACCEPT = "*/*";

function classify(file: File): "image" | "document" | "file" {
  if (file.type.startsWith("image/")) return "image";
  return "file";
}

export function createAttachmentAdapter(
  client: GatewayClient,
  getSessionId: () => string | null,
): AttachmentAdapter {
  return {
    accept: ACCEPT,

    async add({ file }): Promise<PendingAttachment> {
      const sid = getSessionId();
      if (!sid) throw new Error("no session selected");
      try {
        const info = await client.uploadAttachment(sid, file);
        return {
          id: info.attachment_id,
          type: classify(file),
          name: info.filename ?? file.name,
          contentType: info.mime || file.type,
          // requires-action = uploaded, waiting for the user to send.
          status: { type: "requires-action", reason: "composer-send" },
          file,
        };
      } catch (exc) {
        return {
          id: `err-${Date.now()}`,
          type: classify(file),
          name: file.name,
          contentType: file.type,
          status: { type: "incomplete", reason: "error" },
          file,
        };
      }
    },

    async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
      if (
        attachment.status.type === "incomplete"
        || attachment.id.startsWith("err-")
      ) {
        throw new Error("attachment upload failed");
      }
      return {
        id: attachment.id,
        type: attachment.type,
        name: attachment.name,
        contentType: attachment.contentType,
        content: [],
        status: { type: "complete" },
        file: attachment.file,
      };
    },

    async remove(): Promise<void> {
      // Composer-only removal. Uploaded orphan cleanup is handled by retention.
    },
  };
}
