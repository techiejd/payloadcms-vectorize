import type { Config } from 'tailwindcss'

export default {
  content: ['./dev/app/**/*.{js,ts,jsx,tsx,mdx}', './src/components/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {},
  },
  plugins: [],
} satisfies Config
