import { readFileSync } from "node:fs";
import { join } from "node:path";


let cached: Buffer | null = null;

export default function handler(_req: any, res: any) {
  if (!cached) {
    cached = readFileSync(join(process.cwd(), "api", "assets", "icon.png"));
  }
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.status(200).send(cached);
}

// Se o runtime for Edge/Vercel Functions:
export const config = { runtime: "nodejs" };