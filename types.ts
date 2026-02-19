
export enum EntityType {
  CUSTOMER = 'Customer',
  VENDOR = 'Vendor',
  SPAM = 'SPAM',
  UNKNOWN = 'Unknown'
}

export enum CustomerCategory {
  NEW = 'New',
  EXISTING = 'Existing',
  INQUIRY = 'Inquiry',
  FOLLOW_UP = 'Follow-up',
  LOW_PRIORITY = 'Low Priority'
}

export enum PriorityLevel {
  HIGH = 'High',
  MEDIUM = 'Medium',
  LOW = 'Low'
}

export interface WhatsAppMessage {
  id: string;
  timestamp: string;
  sender: string;
  content: string;
  attachmentName?: string;
  attachmentPath?: string;
  attachmentFile?: File;
  type: EntityType;
  category: CustomerCategory;
  priority: PriorityLevel;
  todo: string;
}

export interface RawParsedMessage {
  timestamp: string;
  sender: string;
  content: string;
  attachmentName?: string;
}

export interface AnalysisBatch {
  sender: string;
  messages: RawParsedMessage[];
}
