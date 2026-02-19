
import { GoogleGenAI, Type } from "@google/genai";
import { AnalysisBatch, CustomerCategory, PriorityLevel, EntityType } from "../types";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

/**
 * Transcribes audio data using Gemini multimodal capabilities.
 */
export const transcribeAudio = async (base64Data: string, mimeType: string): Promise<string> => {
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-flash-latest',
      contents: [
        {
          parts: [
            {
              inlineData: {
                data: base64Data,
                mimeType: mimeType,
              },
            },
            {
              text: "Please transcribe this audio message and provide a brief summary. If the content involves business (such as pricing inquiries, ordering, logistics, or payments), please highlight these specifically in the summary. Output in English and provide only the summary text without any introductory remarks.",
            },
          ],
        },
      ],
    });

    return response.text || "[Unable to transcribe]";
  } catch (error: any) {
    console.error("Transcription error:", error);
    if (error?.message?.includes("Region not supported")) {
      return "[Error: AI models are not supported in your region]";
    }
    return "[Transcription failed]";
  }
};

/**
 * Analyzes CRM/SRM data from message batches.
 */
export const analyzeCRMData = async (batches: AnalysisBatch[], knownCustomers: string[], knownVendors: string[], knownSpam: string[]) => {
  const prompt = `
    Analyze the following WhatsApp message threads and classify the senders. 
    
    CRITICAL INSTRUCTION FOR CLASSIFICATION:
    - Senders are often UNKNOWN. You MUST use the message content AND attachment names to classify them.
    - SPAM ANALYSIS: If the content is unsolicited marketing, suspicious links, or looks like repetitive automated spam, classify as SPAM.
    - INVOICE / RECEIPT ANALYSIS: 
      * If a sender is sending an invoice, delivery note, or price list TO us, they are a VENDOR.
      * If a sender is asking for an invoice, sending proof of payment, or asking for prices FROM us, they are a CUSTOMER.
    
    User Provided Lists (Higher Priority):
    - Known Customers: ${knownCustomers.join(', ') || 'None provided'}
    - Known Vendors: ${knownVendors.join(', ') || 'None provided'}
    - Known Spam/Blocked: ${knownSpam.join(', ') || 'None provided'}

    Entity Types:
    - Customer: Buying products/services from us.
    - Vendor: Providing/Selling products/services to us.
    - SPAM: Unsolicited or malicious content.
    - Unknown: If no clear evidence is found.

    Relationship Categories:
    - New: First-time interaction.
    - Existing: Known/Frequent contact.
    - Inquiry: Pricing/Quote negotiation.
    - Follow-up: Action item pending.
    - Low Priority: Personal or non-business.

    Priority Levels: High, Medium, Low.

    Input Threads (JSON):
    ${JSON.stringify(batches)}
  `;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-flash-latest',
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            analyses: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  sender: { type: Type.STRING },
                  timestamp: { type: Type.STRING },
                  type: { 
                    type: Type.STRING, 
                    enum: Object.values(EntityType) 
                  },
                  category: { 
                    type: Type.STRING, 
                    enum: Object.values(CustomerCategory) 
                  },
                  priority: { 
                    type: Type.STRING, 
                    enum: Object.values(PriorityLevel) 
                  },
                  todo: { type: Type.STRING }
                },
                required: ["sender", "timestamp", "type", "category", "priority", "todo"]
              }
            }
          }
        }
      }
    });

    const result = JSON.parse(response.text.trim());
    return result.analyses;
  } catch (error: any) {
    console.error("Gemini analysis error:", error);
    return [];
  }
};
