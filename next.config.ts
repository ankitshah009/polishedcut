import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ffmpeg, the Gemini SDK and fs access all need the Node runtime.
  serverExternalPackages: ["@google/genai"],
};

export default nextConfig;
