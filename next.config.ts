import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ffmpeg, the Gemini SDK and fs access all need the Node runtime.
  serverExternalPackages: [
    "@google/genai",
    // spectrum-ts pulls in gRPC and protobuf for iMessage; keep it out of the bundle too.
    "spectrum-ts",
    "@spectrum-ts/core",
    "@spectrum-ts/imessage",
    "@spectrum-ts/telegram",
    "@spectrum-ts/whatsapp-business",
    "@spectrum-ts/slack",
    "@spectrum-ts/terminal",
  ],
};

export default nextConfig;
