export type Money = { amount: number; currency: "SGD" };

export type Ingredient = {
  id: string;
  name: string;
  quantity: string;
  optional: boolean;
  have: boolean;
  suggested?: boolean;
};

export type RecipeSource =
  | "plated_dish"
  | "recipe_document"
  | "typed_dish"
  | "typed_recipe"
  | "sample";

export type Recipe = {
  title: string;
  servings: number;
  ingredients: Ingredient[];
  source?: RecipeSource;
  notes?: string;
  method?: string[];
};

export type Candidate = {
  productId: string;
  variantId: string;
  name: string;
  merchant: string;
  merchantDomain: string;
  price: Money;
  available: boolean;
  imageUrl?: string;
};

export type CartLine = {
  ingredientId: string;
  ingredientName: string;
  candidate: Candidate;
  quantity: number;
  status: "selected" | "swapped" | "dropped" | "flagged";
  reason: string;
  alternatives: Candidate[];
};

export type ShippingOption = {
  id: string;
  name: string;
  price: Money;
  selected: boolean;
  estimatedDelivery?: {
    earliest?: string;
    latest?: string;
    source: "merchant" | "inferred" | "mock";
  };
};

export type Quote = {
  id: string;
  itemsSubtotal: Money;
  shipping: Money;
  tax: Money;
  finalAmount: Money;
  expiresAt: string;
  shippingOptions: ShippingOption[];
};

export type Checkout = {
  id: string;
  status: "REQUIRES_ACTION" | "PROCESSING" | "COMPLETED" | "FAILED" | "EXPIRED";
  approvalUrl?: string;
  orderId?: string;
  finalAmount?: Money;
};

export type Enrollment = {
  id: string;
  status: "REQUIRES_ACTION" | "ACTIVE" | "FAILED" | "EXPIRED" | "REVOKED";
  approvalUrl?: string;
  last4?: string;
  expiresAt?: string;
  updatedAt?: string;
};

export type AuditEvent = {
  ts: string;
  source: "server" | "client";
  kind: string;
  message: string;
  method?: string;
  path?: string;
  httpStatus?: number;
  ok?: boolean;
  durationMs?: number;
  enrollmentId?: string;
  enrollmentStatus?: string;
  checkoutId?: string;
  checkoutStatus?: string;
  last4?: string;
  nextAction?: string;
  returnUrl?: string;
  errorCode?: string;
};

export type AgentEventKind =
  | "search"
  | "pick"
  | "quote"
  | "over_budget"
  | "swap"
  | "drop"
  | "ready"
  | "error"
  | "brand_filter"
  | "delivery_check"
  | "merchant";

export type AgentEvent = {
  ts: number;
  kind: AgentEventKind;
  message: string;
};

export type RecipeInput =
  | { kind: "photo"; imageBase64: string }
  | { kind: "text"; text: string }
  | { kind: "sample" };

export type DeliveryWindow = "any" | "morning" | "afternoon" | "evening";

export type Guardrails = {
  budget: Money;
  delivery?: {
    latestDate?: string;
    window?: DeliveryWindow;
  };
  brands?: {
    preferred: string[];
    blocked: string[];
  };
};

export type GuardrailChip = {
  id: "budget" | "delivery" | "brands";
  label: string;
  ok: boolean;
  detail: string;
};

export type MerchantScore = {
  domain: string;
  label: string;
  hits: number;
  missed: string[];
};

export type PlanResult = {
  merchant: MerchantScore;
  scores: MerchantScore[];
  lines: CartLine[];
  quote: Quote | null;
  events: AgentEvent[];
  guardrails: GuardrailChip[];
  canApprove: boolean;
  message?: string;
};
