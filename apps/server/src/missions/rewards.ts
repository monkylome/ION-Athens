/**
 * Rewards for citizen missions, taken from the City's "Athens Card" benefits
 * in the AthensGov sandbox. The sandbox says the programme is fictional; this
 * shows how points could unlock benefits the City already has.
 */
import { z } from "zod";

export const benefitSchema = z
  .object({
    id: z.string(),
    partner: z.string().nullish(),
    category: z.string().nullish(),
    title: z.string(),
    description: z.string().nullish(),
    discount_percent: z.number().nullish(),
    address: z.string().nullish(),
    lat: z.number().nullish(),
    lng: z.number().nullish(),
  })
  .passthrough();
export const benefitPageSchema = z.object({ items: z.array(benefitSchema) }).passthrough();
export type Benefit = z.infer<typeof benefitSchema>;

export interface Reward {
  id: string;
  title: string;
  partner: string;
  category: string;
  pointsRequired: number;
  unlocked: boolean;
  /** True when the City itself provides it, so it costs the City almost nothing. */
  municipal: boolean;
}

const MUNICIPAL = /δημοτικ|τεχνόπολ|athens charge/i;

/** Benefits the City gives from its own venues are the cheapest to offer, so they unlock first. */
export function pointsFor(b: Benefit): { points: number; municipal: boolean } {
  const municipal = MUNICIPAL.test(b.partner ?? "");
  const free = /δωρεάν|προτεραιότητα/i.test(b.title);
  if (municipal) return { points: free ? 50 : 80, municipal };
  return { points: free ? 100 : 120, municipal };
}

export function toRewards(benefits: readonly Benefit[], points: number): Reward[] {
  return benefits
    .map((b) => {
      const p = pointsFor(b);
      return {
        id: b.id, title: b.title, partner: b.partner ?? "", category: b.category ?? "",
        pointsRequired: p.points, unlocked: points >= p.points, municipal: p.municipal,
      };
    })
    .sort((a, b) => a.pointsRequired - b.pointsRequired || Number(b.municipal) - Number(a.municipal) || a.title.localeCompare(b.title, "el"));
}
