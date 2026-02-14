/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      {
        source: "/plan",
        destination: "/api/plan"
      }
    ];
  }
};

module.exports = nextConfig;
