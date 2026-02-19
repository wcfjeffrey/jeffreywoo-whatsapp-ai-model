
import { RawParsedMessage } from '../types';

export const parseWhatsAppChat = (text: string): RawParsedMessage[] => {
  // Remove invisible characters like LTR/RTL marks (\u200e, \u200f) and non-breaking spaces
  const cleanText = text.replace(/[\u200e\u200f\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/g, '');
  const lines = cleanText.split(/\r?\n/);
  const messages: RawParsedMessage[] = [];

  /**
   * Refined Patterns:
   * Pattern 2 (Android) now explicitly matches and discards the " - " separator.
   */
  const patterns = [
    // Pattern 1: iOS style [Timestamp] Name: Content
    /^\[?(\d{1,4}[./-]\d{1,2}[./-]\d{1,4},?\s(?:上午|下午|AM|PM)?\s?\d{1,2}:\d{2}(?::\d{2})?\s?(?:上午|下午|AM|PM)?)\]?\s+([^:]+):\s*(.*)$/i,
    
    // Pattern 2: Android style Timestamp - Name: Content
    /^(\d{1,4}[./-]\d{1,2}[./-]\d{1,4},?\s(?:上午|下午|AM|PM)?\s?\d{1,2}:\d{2}(?::\d{2})?\s?(?:上午|下午|AM|PM)?)\s+-\s+([^:]+):\s*(.*)$/i,
    
    // Pattern 3: Simple fallback
    /^(\d{1,4}[./-]\d{1,2}[./-]\d{1,4}.*?\d{1,2}:\d{2})\s+([^:]+):\s*(.*)$/i
  ];

  // Matches various attachment formats including full-width colons
  const attachmentRegex = /<(?:attached|附件)[:：]\s?([^>]+)>|([\w.-]+\.(?:jpg|jpeg|png|webp|pdf|docx|xlsx|pptx|txt|doc|xls|ppt|mp4|mov|avi|opus|ogg|m4a|mp3|wav))/i;

  let currentMessage: RawParsedMessage | null = null;

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;

    let matched = false;
    for (const pattern of patterns) {
      const match = trimmedLine.match(pattern);
      if (match) {
        if (currentMessage) messages.push(currentMessage);
        
        const [_, timestamp, sender, content] = match;
        
        // Remove the separator hyphen and leading/trailing dashes/spaces
        // This addresses "remove the - sign in SENDER"
        const cleanSender = sender.replace(/^[\s\-\u2013\u2014]+|[\s\-\u2013\u2014]+$/g, '').trim();
        
        const attachmentMatch = content.match(attachmentRegex);
        const attachmentName = attachmentMatch ? (attachmentMatch[1] || attachmentMatch[2]) : undefined;

        currentMessage = {
          timestamp: timestamp.trim(),
          sender: cleanSender,
          content: content.trim(),
          attachmentName: attachmentName?.trim()
        };
        matched = true;
        break;
      }
    }

    if (!matched && currentMessage) {
      currentMessage.content += ` ${trimmedLine}`;
      if (!currentMessage.attachmentName) {
        const attachmentMatch = trimmedLine.match(attachmentRegex);
        if (attachmentMatch) {
          currentMessage.attachmentName = (attachmentMatch[1] || attachmentMatch[2]).trim();
        }
      }
    }
  }

  if (currentMessage) messages.push(currentMessage);
  return messages;
};
