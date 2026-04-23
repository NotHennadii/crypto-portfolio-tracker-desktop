import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { getSupabaseAnonKey, getSupabaseUrl, hasSupabaseEnv, isGuestModeEnabled } from "@/lib/supabase-env";

export async function proxy(request: NextRequest) {
  if (!hasSupabaseEnv() && isGuestModeEnabled()) {
    return NextResponse.next({ request });
  }
  if (!hasSupabaseEnv()) {
    const isAuthPage = request.nextUrl.pathname.startsWith("/auth");
    if (isAuthPage) {
      return NextResponse.next({ request });
    }
    return NextResponse.redirect(new URL("/auth", request.url));
  }
  const response = NextResponse.next({ request });
  const supabase = createServerClient(getSupabaseUrl(), getSupabaseAnonKey(), {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookieList) {
        for (const cookie of cookieList) {
          response.cookies.set(cookie.name, cookie.value, cookie.options);
        }
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const isAuthPage = request.nextUrl.pathname.startsWith("/auth");

  if (!user && !isAuthPage) {
    return NextResponse.redirect(new URL("/auth", request.url));
  }

  if (user && isAuthPage) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  return response;
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
