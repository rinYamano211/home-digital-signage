export interface HttpMetadata {
  status: number;
  retryAfter?: string;
}
export type HttpOutcome =
  | { kind: "response"; http: HttpMetadata; body: Uint8Array }
  | { kind: "body_error" | "body_too_large"; http: HttpMetadata }
  | { kind: "network_error" | "timeout" | "aborted"; http?: HttpMetadata };
export const ABSOLUTE_MAX_BODY_BYTES = 1_048_576;
export interface HttpAdapterConfig {
  url: string;
  maxBodyBytes: number;
  headers?: HeadersInit;
}
