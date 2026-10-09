import type { Candidate, Checkout, Enrollment, Quote } from "@/lib/types";
import * as reap from "@/lib/provider/reap";

export type CommerceProvider = {
  search(query: string, merchantName: string): Promise<Candidate[]>;
  createQuote(lines: { variantId: string; quantity: number }[]): Promise<Quote>;
  selectShippingOption(quoteId: string, shippingOptionId: string): Promise<Quote>;
  createEnrollment(returnUrl?: string): Promise<Enrollment>;
  getEnrollment(id: string): Promise<Enrollment>;
  findActiveEnrollment(): Promise<Enrollment | null>;
  createCheckout(quoteId: string, returnUrl?: string, enrollmentId?: string): Promise<Checkout>;
  getCheckout(id: string): Promise<Checkout>;
};

export const provider: CommerceProvider = reap;
export { ReapError } from "@/lib/provider/reap";
