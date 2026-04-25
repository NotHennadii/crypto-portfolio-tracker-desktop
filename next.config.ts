import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  output: "standalone",
  env: {
    NEXT_PUBLIC_APP_VERSION: process.env.npm_package_version ?? "0.1.0",
    NEXT_PUBLIC_ALLOW_GUEST_MODE: process.env.NEXT_PUBLIC_ALLOW_GUEST_MODE ?? "true",
  },
  turbopack: {
    root: projectRoot,
  },
};

export default nextConfig;
