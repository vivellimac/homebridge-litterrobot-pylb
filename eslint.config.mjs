import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

const tsTypeChecked = tseslint.configs.recommendedTypeChecked.map((c) => ({
  ...c,
  files: ['src/**/*.ts'],
}));
const tsStylistic = tseslint.configs.stylisticTypeChecked.map((c) => ({
  ...c,
  files: ['src/**/*.ts'],
}));

export default [
  // Ignore build + vendor
  { ignores: ['dist/**', 'node_modules/**'] },

  // Base JS rules (applies to .js/.mjs files only; safe for config files)
  eslint.configs.recommended,

  // TypeScript presets, but explicitly scoped to our TS sources
  ...tsTypeChecked,
  ...tsStylistic,

  // Our strict rules (also scoped to TS files)
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parser: tseslint.parser,
      parserOptions: {
        project: ['./tsconfig.json'],
        tsconfigRootDir: process.cwd(),
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      // General strictness
      'no-console': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      'eqeqeq': ['error', 'smart'],
      'curly': ['error', 'all'],

      // TS-specific strictness
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],

      // Ergonomics
      '@typescript-eslint/explicit-module-boundary-types': 'off'
    },
  },
];
