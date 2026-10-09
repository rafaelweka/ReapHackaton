export type Merchant = {
  domain: string;
  merchantName: string;
  label: string;
};

/** Search all three, then lock quote + checkout to the winner. Tie order is array order. */
export const MERCHANTS: Merchant[] = [
  { domain: "zenxin.com.sg", merchantName: "zenxin.com.sg", label: "Zenxin" },
  {
    domain: "supernature.com.sg",
    merchantName: "supernature.com.sg",
    label: "Supernature",
  },
  { domain: "thefishwives.com", merchantName: "thefishwives.com", label: "The Fishwives" },
];

export const SGD = "SGD" as const;

export const DEMO_SHIPPING = {
  firstName: "Avery",
  lastName: "Tan",
  phone: "+6591234567",
  addressLine1: "1 Raffles Place",
  city: "Singapore",
  postalCode: "048616",
  country: "SG",
};

export const STAPLES = [
  "salt",
  "sugar",
  "water",
  "oil",
  "pepper",
  "black pepper",
  "white pepper",
  "cooking oil",
  "vegetable oil",
  "olive oil",
];

export function isStaple(name: string): boolean {
  return STAPLES.includes(name.trim().toLowerCase());
}

export function sgd(amount: number): { amount: number; currency: "SGD" } {
  return { amount, currency: SGD };
}

export function formatSgd(amount: number): string {
  return `S$${amount.toFixed(2)}`;
}
