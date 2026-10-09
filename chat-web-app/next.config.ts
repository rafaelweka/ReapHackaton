import type { NextConfig } from "next";

const publicHost = process.env.REAP_RETURN_URL?.replace(/^https?:\/\//, "").replace(/\/$/, "");

const nextConfig: NextConfig = {
  serverExternalPackages: ["openai"],
  allowedDevOrigins: publicHost ? [publicHost] : [],
};

export default nextConfig;
