import { REPLY_PREVIEW_LEN } from "@/ui";

export function previewText(content: string, max: number = REPLY_PREVIEW_LEN): string {
  return content.replace(/\s+/g, " ").trim().slice(0, max) || "attachment";
}
