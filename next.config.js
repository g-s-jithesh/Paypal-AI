/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['better-sqlite3'],
  reactStrictMode: true,
  output: 'standalone',
};

module.exports = nextConfig;
