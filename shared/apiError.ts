import type { ApiError } from './types.ts';

/** Error shape the UI understands, thrown by both the HTTP client and the in-browser engine. */
export class ApiFail extends Error {
  status: number;
  code: string;
  payload: ApiError | null;

  constructor(status: number, code: string, message: string, payload: ApiError | null = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}
