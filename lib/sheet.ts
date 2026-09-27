import { z } from 'zod';

/**
 * The standard listing sheet (CLAUDE.md, "Fiche standard"). Every reader produces one,
 * every later step reads only from it: nothing in a video may come from elsewhere
 * (rule 3). Optional fields stay absent when the listing does not state them.
 */

export const PhotoSchema = z.object({
  url: z.string().url(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});
export type Photo = z.infer<typeof PhotoSchema>;

const EnergyClass = z.enum(['A', 'B', 'C', 'D', 'E', 'F', 'G']);

const Common = {
  platform: z.string().min(1),
  sourceUrl: z.string().url(),
  price: z.number().positive().optional(),
  city: z.string().min(1).optional(),
  postalCode: z.string().min(1).optional(),
  description: z.string().optional(),
  /** Phone number, only when the seller wrote it in the listing or gave it to us. */
  phone: z.string().min(1).optional(),
  photos: z.array(PhotoSchema),
};

export const VehicleSheetSchema = z.object({
  vertical: z.literal('auto'),
  ...Common,
  title: z.string().min(1),
  make: z.string().min(1),
  model: z.string().min(1),
  version: z.string().min(1).optional(),
  year: z.number().int().min(1900).max(2100).optional(),
  mileageKm: z.number().int().nonnegative().optional(),
  fuel: z.string().min(1).optional(),
  gearbox: z.string().min(1).optional(),
  powerHp: z.number().int().positive().optional(),
  currency: z.enum(['EUR', 'CHF']),
  sellerType: z.enum(['pro', 'particulier']),
  sellerName: z.string().min(1).optional(),
  sellerSiren: z.string().regex(/^\d{9}$/).optional(),
  warranty: z.string().min(1).optional(),
  equipment: z.array(z.string().min(1)),
});
export type VehicleSheet = z.infer<typeof VehicleSheetSchema>;

export const PropertySheetSchema = z.object({
  vertical: z.literal('immo'),
  ...Common,
  transaction: z.enum(['vente', 'location']),
  propertyType: z.string().min(1),
  currency: z.literal('EUR'),
  surfaceM2: z.number().positive().optional(),
  landM2: z.number().positive().optional(),
  rooms: z.number().int().positive().optional(),
  bedrooms: z.number().int().nonnegative().optional(),
  floor: z.string().min(1).optional(),
  district: z.string().min(1).optional(),
  dpe: EnergyClass.optional(),
  ges: EnergyClass.optional(),
  features: z.array(z.string().min(1)),
  agencyName: z.string().min(1).optional(),
  agencySiret: z.string().regex(/^\d{14}$/).optional(),
});
export type PropertySheet = z.infer<typeof PropertySheetSchema>;

export const SheetSchema = z.discriminatedUnion('vertical', [VehicleSheetSchema, PropertySheetSchema]);
export type Sheet = z.infer<typeof SheetSchema>;

/** Throws a readable error listing every invalid field. */
export function parseSheet(input: unknown): Sheet {
  const result = SheetSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(racine)'} : ${i.message}`);
    throw new Error(`Fiche invalide :\n- ${issues.join('\n- ')}`);
  }
  return result.data;
}
