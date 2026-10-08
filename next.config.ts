import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Voice clone samples are posted through a server action (default limit is 1 MB).
    serverActions: { bodySizeLimit: "4.5mb" },
  },
};

export default nextConfig;
