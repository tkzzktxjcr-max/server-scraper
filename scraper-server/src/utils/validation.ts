import { z } from "zod";

// ─────────────────────────────────────────────
// RAW LISTING SCHEMA (from API interception)
// ─────────────────────────────────────────────

export const RawListingSchema = z.object({
  source_id: z.string().min(1, "source_id is required"),
  url: z.string().min(1, "url is required"),
  title: z.string().min(1, "title is required"),
  price: z.number().positive("price must be positive"),
  type: z.string().min(1, "type is required"),
  city: z.string().optional().default(""),
  postal_code: z.string().optional().default(""),
  province: z.string().optional().default(""),
  bedrooms: z.number().int().nonnegative().optional().default(0),
  bathrooms: z.number().int().nonnegative().optional().default(0),
  surface_sqm: z.number().positive().optional().default(0),
  latitude: z.number().optional().default(0),
  longitude: z.number().optional().default(0),
  address: z.string().optional().default(""),
  photos: z.array(z.string()).optional().default([]),
  description: z.string().optional().default(""),
  energy_rating: z.string().optional().default(""),
  year_built: z.number().int().positive().optional().nullable().default(null),
  agent_name: z.string().optional().default(""),
  agent_phone: z.string().optional().default(""),
  agent_agency: z.string().optional().default(""),
  amenities: z.array(z.string()).optional().default([]),
});

export type RawListing = z.infer<typeof RawListingSchema>;

// ─────────────────────────────────────────────
// PROPERTY DATA SCHEMA (for Appwrite storage)
// ─────────────────────────────────────────────

export const PropertyDataSchema = z.object({
  site_id: z.string().min(1),
  source_id: z.string().min(1, "source_id is required for deduplication"),
  url: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  price: z.number().positive("price must be positive"),
  surface_sqm: z.number().nonnegative(),
  bedrooms: z.number().int().nonnegative(),
  bathrooms: z.number().int().nonnegative(),
  type: z.string().min(1),
  city: z.string(),
  postal_code: z.string(),
  province: z.string(),
  latitude: z.number(),
  longitude: z.number(),
  address: z.string(),
  photos: z.array(z.string()),
  agent_name: z.string(),
  agent_phone: z.string(),
  agent_agency: z.string(),
  amenities: z.array(z.string()),
  energy_rating: z.string(),
  year_built: z.number().int().positive().nullable(),
});

export type ValidatedPropertyData = z.infer<typeof PropertyDataSchema>;

// ─────────────────────────────────────────────
// VALIDATION HELPERS
// ─────────────────────────────────────────────

export interface ValidationResult<T> {
  success: boolean;
  data: T | null;
  errors: string[];
  warnings: string[];
}

export function validatePropertyData(data: unknown): ValidationResult<ValidatedPropertyData> {
  const result = PropertyDataSchema.safeParse(data);
  const warnings: string[] = [];

  if (!result.success) {
    const errors = result.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`
    );
    return { success: false, data: null, errors, warnings };
  }

  const validated = result.data;

  // Warnings for suspicious but technically valid data
  if (validated.price < 10000) {
    warnings.push(`Suspiciously low price: €${validated.price}`);
  }
  if (validated.price > 10000000) {
    warnings.push(`Suspiciously high price: €${validated.price}`);
  }
  if (validated.surface_sqm === 0) {
    warnings.push("Surface area is 0 — may be missing from source");
  }
  if (validated.bedrooms === 0 && validated.type !== "studio" && validated.type !== "commercial") {
    warnings.push("Bedrooms is 0 for non-studio/commercial property");
  }
  if (validated.city === "") {
    warnings.push("City is empty");
  }
  if (validated.photos.length === 0) {
    warnings.push("No photos found");
  }

  return { success: true, data: validated, errors: [], warnings };
}

export function validateRawListing(data: unknown): ValidationResult<RawListing> {
  const result = RawListingSchema.safeParse(data);

  if (!result.success) {
    const errors = result.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`
    );
    return { success: false, data: null, errors, warnings: [] };
  }

  return { success: true, data: result.data, errors: [], warnings: [] };
}

// ─────────────────────────────────────────────
// DATA CLEANING HELPERS
// ─────────────────────────────────────────────

export function cleanString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  return String(value).trim();
}

export function cleanNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const cleaned = value.replace(/[^\d.,\-]/g, "").replace(",", ".");
    const parsed = parseFloat(cleaned);
    return isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

export function cleanInt(value: unknown): number {
  return Math.floor(cleanNumber(value));
}

export function cleanEnergyRating(value: unknown): string {
  const cleaned = cleanString(value).toUpperCase().charAt(0);
  if (["A", "B", "C", "D", "E", "F", "G"].includes(cleaned)) {
    return cleaned;
  }
  return "";
}

export function cleanPhotos(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((v) => cleanString(v))
      .filter((v) => v.startsWith("http") && !v.includes("placeholder"));
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return cleanPhotos(parsed);
    } catch {
      return [];
    }
  }
  return [];
}

export function normalizePropertyType(raw: string): string {
  const lower = raw.toLowerCase().trim();
  if (lower.includes("apartment") || lower.includes("flat") || lower.includes("appartement")) return "apartment";
  if (lower.includes("villa")) return "villa";
  if (lower.includes("studio")) return "studio";
  if (lower.includes("commercial") || lower.includes("bureau") || lower.includes("office")) return "commercial";
  if (lower.includes("house") || lower.includes("maison") || lower.includes("huis") || lower.includes("woning")) return "house";
  return "house";
}