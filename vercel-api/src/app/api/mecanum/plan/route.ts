import { handleMecanumPlanRequest } from "@/lib/mecanum_handler";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return handleMecanumPlanRequest(request);
}

