import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  // Ignore build + vendor
  {
    ignores: ['dist/**', 'node_modules/**']
  },

  // Base JS recommended rules
  eslint.configs.recommended,

  // TypeScript: strict + stylistic, with type-checking
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    files: ['src/**/*.ts'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        project: ['./tsconfig.json'],
        tsconfigRootDir: process.cwd()
      }
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

      // Reasonable ergonomics (keep API surface clean without overburdening)
      '@typescript-eslint/explicit-module-boundary-types': 'off'
    }
  }
];
