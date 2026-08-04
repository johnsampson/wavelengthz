module.exports = {
  content: ['./public/**/*.html', './public/**/*.js'],
  theme: {
    extend: {
      colors: {
        base: '#120C14',
        surface: '#1E1620',
        surface2: '#281D2C',
        brand: {
          50: '#FFF1F2',
          100: '#FFE1E4',
          300: '#FFA6B4',
          400: '#FF7A93',
          500: '#FF5A7A',
          600: '#F0407A',
          700: '#C6337C',
        },
        accent: {
          400: '#A78BFA',
          500: '#8B5CF6',
          600: '#6D4FE0',
        },
      },
      fontFamily: {
        sans: ['Manrope', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
