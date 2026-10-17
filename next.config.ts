import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Here rather than redirect() in a page: a page-level redirect left in-app navigation on a blank /account.
  // Query strings carry over, so Stripe checkouts started before Billing moved still return correctly.
  async redirects() {
    return [
      { source: "/account", destination: "/account/billing", permanent: false },
      { source: "/billing", destination: "/account/billing", permanent: false },
    ];
  },
  experimental: {
    // Voice clone samples are posted through a server action (default limit is 1 MB).
    serverActions: { bodySizeLimit: "4.5mb" },
  },
};

export default nextConfig;
