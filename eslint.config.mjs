import nextConfig from 'eslint-config-next';

const config = [
  ...nextConfig,
  {
    ignores: ['coverage/**', 'reports/**', '.stryker-tmp/**'],
  },
];

export default config;
