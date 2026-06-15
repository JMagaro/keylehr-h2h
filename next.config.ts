import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // Team logos: ESPN crests (primary, shown on-site) plus the nflverse GitHub
    // ("/raw/" URLs redirect to raw.githubusercontent.com) and Wikipedia hosts
    // for completeness (wordmark / squared / wikipedia logo variants).
    remotePatterns: [
      { protocol: "https", hostname: "a.espncdn.com" },
      { protocol: "https", hostname: "a1.espncdn.com" },
      { protocol: "https", hostname: "a2.espncdn.com" },
      { protocol: "https", hostname: "raw.githubusercontent.com" },
      { protocol: "https", hostname: "upload.wikimedia.org" },
    ],
  },
};

export default nextConfig;
