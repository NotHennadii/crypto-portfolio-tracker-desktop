"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import { hasSupabaseEnv, isGuestModeEnabled } from "@/lib/supabase-env";

type AuthMode = "login" | "signup";

export default function AuthPage() {
  const router = useRouter();
  const authEnabled = hasSupabaseEnv();
  const guestEnabled = isGuestModeEnabled();
  const [mode, setMode] = useState<AuthMode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!authEnabled && guestEnabled) {
      router.replace("/");
      router.refresh();
      return;
    }
    if (!authEnabled && !guestEnabled) {
      setMessage("Вход недоступен: настройте Supabase env или включите guest mode.");
      return;
    }
    setLoading(true);
    setMessage(null);
    const supabase = getSupabaseBrowserClient();
    if (!email.trim() || !password.trim()) {
      setMessage("Введите email и пароль.");
      setLoading(false);
      return;
    }

    if (mode === "signup") {
      const emailRedirectTo =
        typeof window !== "undefined" ? `${window.location.origin}/auth` : undefined;
      const { error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          emailRedirectTo,
        },
      });
      if (error) {
        setMessage(error.message);
        setLoading(false);
        return;
      }
      setMessage("Письмо для подтверждения отправлено. После подтверждения вернитесь и выполните вход.");
      setMode("login");
      setLoading(false);
      return;
    }

    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    if (error) {
      setMessage(error.message);
      setLoading(false);
      return;
    }
    router.replace("/");
    router.refresh();
  };

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#071018] p-4 text-[#EAF7FF]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(57,208,255,0.1),transparent_44%),radial-gradient(circle_at_bottom_left,rgba(25,194,180,0.08),transparent_36%)]" />
      <section className="relative z-10 grid w-full max-w-6xl gap-5 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="overflow-hidden rounded-[20px] border border-[rgba(120,190,220,0.14)] bg-[#0C1822]/85">
          <Image
            src="/auth-preview.png"
            alt="Превью торгового блокнота"
            width={1024}
            height={576}
            priority
            className="h-full w-full object-cover"
          />
        </div>
        <div className="rounded-[20px] border border-[rgba(120,190,220,0.14)] bg-[linear-gradient(180deg,rgba(16,32,43,0.9),rgba(12,24,34,0.92))] p-6 backdrop-blur-sm">
          <h1 className="text-2xl font-semibold">{mode === "login" ? "Вход" : "Регистрация"}</h1>
          <p className="mt-1 text-sm text-[#7C96A3]">
            {authEnabled
              ? "Личный доступ к вашему торговому дашборду."
              : guestEnabled
                ? "Гостевой режим активен: вход отключен."
                : "Auth не настроен: добавьте Supabase env или включите guest mode."}
          </p>

          {authEnabled ? (
          <form onSubmit={handleSubmit} className="mt-5 space-y-3">
            <label className="block text-sm">
              <span className="text-[#A7C3D1]">Email</span>
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="mt-1 w-full rounded-xl border border-[rgba(120,190,220,0.16)] bg-[#0C1822]/90 px-3 py-2 text-sm text-[#EAF7FF] outline-none placeholder:text-[#6F8A97]"
                placeholder="you@example.com"
                autoComplete="email"
              />
            </label>
            <label className="block text-sm">
              <span className="text-[#A7C3D1]">Пароль</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="mt-1 w-full rounded-xl border border-[rgba(120,190,220,0.16)] bg-[#0C1822]/90 px-3 py-2 text-sm text-[#EAF7FF] outline-none placeholder:text-[#6F8A97]"
                placeholder="Минимум 6 символов"
                autoComplete={mode === "login" ? "current-password" : "new-password"}
              />
            </label>

            {message ? <p className="rounded-lg border border-[rgba(120,190,220,0.16)] bg-[#0C1822]/90 px-3 py-2 text-xs text-[#A7C3D1]">{message}</p> : null}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-xl border border-[rgba(84,214,255,0.28)] bg-[#132734] px-4 py-2 text-sm font-semibold text-[#77E7FF] hover:bg-[#163041] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? "Подождите..." : mode === "login" ? "Войти" : "Создать аккаунт"}
            </button>
          </form>
          ) : guestEnabled ? (
            <button
              type="button"
              onClick={() => {
                router.replace("/");
                router.refresh();
              }}
              className="mt-5 w-full rounded-xl border border-[rgba(84,214,255,0.28)] bg-[#132734] px-4 py-2 text-sm font-semibold text-[#77E7FF] hover:bg-[#163041]"
            >
              Продолжить как гость
            </button>
          ) : (
            <p className="mt-5 rounded-lg border border-[rgba(120,190,220,0.16)] bg-[#0C1822]/90 px-3 py-2 text-xs text-[#A7C3D1]">
              Supabase переменные не настроены, а guest mode выключен.
            </p>
          )}

          {authEnabled ? (
            <button
              type="button"
              onClick={() => {
                setMode((prev) => (prev === "login" ? "signup" : "login"));
                setMessage(null);
              }}
              className="mt-4 text-sm text-[#7C96A3] underline underline-offset-4 hover:text-[#A7C3D1]"
            >
              {mode === "login" ? "Нет аккаунта? Регистрация" : "Уже есть аккаунт? Вход"}
            </button>
          ) : null}
        </div>
      </section>
    </main>
  );
}
