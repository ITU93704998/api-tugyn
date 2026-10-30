export interface PublicContacts { supportEmail: string; commercialEmail: string }
export const DEFAULT_CONTACTS: PublicContacts = { supportEmail: "tugyntec@gmail.com", commercialEmail: "tugyntec@gmail.com" };
// Deliberately accepts a single plain address, never headers, display names or mailto URLs.
export function validEmail(value: unknown): value is string {
  return typeof value === "string" && value.length <= 254 && /^[A-Za-z0-9._+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(value) && value.split("@")[0].length <= 64 && !value.split("@")[0].startsWith(".") && !value.split("@")[0].endsWith(".") && !value.split("@")[0].includes("..");
}
export function parseContacts(value: unknown): PublicContacts | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  if (!validEmail(data.supportEmail) || !validEmail(data.commercialEmail)) return null;
  return { supportEmail: data.supportEmail, commercialEmail: data.commercialEmail };
}
