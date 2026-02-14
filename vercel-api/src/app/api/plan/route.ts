import { handlePlanRequest } from "@/lib/handler";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return handlePlanRequest(request);
}
