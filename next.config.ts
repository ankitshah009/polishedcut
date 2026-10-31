import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ffmpeg, the Gemini SDK and fs access all need the Node runtime.
  serverExternalPackages: [
    "@google/genai",
    // socket.io-client (Photon event stream) stays a plain Node dependency.
    "socket.io-client",
  ],
};

export default nextConfig;
