/* eslint-env node */
module.exports = {
  root: true,
  parser: 'vue-eslint-parser',
  parserOptions: { parser: '@typescript-eslint/parser', ecmaVersion: 2022, sourceType: 'module' },
  plugins: ['@typescript-eslint', 'vue'],
  extends: ['eslint:recommended', 'plugin:vue/vue3-recommended', 'plugin:@typescript-eslint/recommended'],
  env: { browser: true, es2022: true },
  ignorePatterns: ['dist', 'node_modules', 'src/i18n/locales/*.json'],
  rules: {
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'warn',
    'vue/multi-word-component-names': 'off',
    'vue/no-v-html': 'off',
  },
};
