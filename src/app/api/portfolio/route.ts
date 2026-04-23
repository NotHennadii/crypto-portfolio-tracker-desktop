import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    {
      error:
        "This endpoint is deprecated. Use /api/futures/monitor for BingX futures monitoring.",
    },
    { status: 410 }
  );
}
