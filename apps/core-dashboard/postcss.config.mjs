/**
 * Tailwind 4 is a PostCSS plugin rather than a config file.
 *
 * Everything that used to live in tailwind.config.js now lives in CSS, next to
 * the styles it describes. See src/app/globals.css.
 */
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;
