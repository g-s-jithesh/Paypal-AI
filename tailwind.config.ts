import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        paypal: {
          blue: '#003087',
          darkBlue: '#001C64',
          lightBlue: '#0070BA',
          accent: '#00CFE8',
          grayBg: '#F5F7FA',
        },
      },
    },
  },
  plugins: [],
};

export default config;
