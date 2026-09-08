import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  pageExtensions: ["ts", "tsx", "js", "jsx"],
  eslint: {
    // No ESLint config in this project; skip so Vercel builds don't fail.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
