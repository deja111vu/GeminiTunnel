// Mirrors the Code Assist API types used by gemini-cli. Kept narrow to the
// fields we actually consume.

export interface ClientMetadata {
  ideType: string;
  platform: string;
  pluginType: string;
  duetProject?: string;
}

export interface GeminiUserTier {
  id?: string;
  name?: string;
}

export interface LoadCodeAssistResponse {
  cloudaicompanionProject?: string;
  currentTier?: GeminiUserTier;
  paidTier?: GeminiUserTier;
  allowedTiers?: GeminiUserTier[];
}

export interface OnboardUserRequest {
  tierId: string;
  cloudaicompanionProject?: string;
  metadata: ClientMetadata;
}

export interface LongRunningOperation {
  name?: string;
  done?: boolean;
  response?: { cloudaicompanionProject?: { id?: string; name?: string } };
}

export interface RetrieveUserQuotaRequest {
  project: string;
  userAgent?: string;
}

export interface RetrieveUserQuotaResponse {
  buckets?: { modelId?: string; remainingAmount?: number; totalAmount?: number; resetTime?: string }[];
}

export interface ContentPart {
  text?: string;
  [k: string]: unknown;
}

export interface Content {
  role?: string;
  parts?: ContentPart[];
}

export interface GenerateContentRequest {
  model: string;
  project?: string;
  request: {
    contents: Content[];
    systemInstruction?: Content;
    tools?: unknown[];
    generationConfig?: Record<string, unknown>;
  };
}

export interface Candidate {
  content?: Content;
  finishReason?: string;
  index?: number;
}

export interface GenerateContentResponse {
  response?: { candidates?: Candidate[]; modelVersion?: string; usageMetadata?: unknown };
  traceId?: string;
}
