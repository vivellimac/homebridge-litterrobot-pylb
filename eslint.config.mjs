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
  { ignores: ['dist/**', 'node_modules/**'] },

  {
    languageOptions: {
      globals: { process: 'readonly' }
    }
  },

  eslint.configs.recommended,

  ...tsTypeChecked,
  ...tsStylistic,

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
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      'no-console': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      'eqeqeq': ['error', 'smart'],
      'curly': ['error', 'all'],

      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
    },
  },
];
