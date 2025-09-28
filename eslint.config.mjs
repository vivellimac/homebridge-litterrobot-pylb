// eslint.config.mjs — ESLint 9 + TypeScript 5 flat config (zero warnings)
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    name: 'ignores',
    ignores: [
      'dist/**',
      'node_modules/**',
      'sidecar/**',         // Python sidecar
      'test/hbConfig/**',
      'src/@types/**'       // d.ts shims – keep out of lint
    ],
  },
  {
    name: 'javascript',
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    ...js.configs.recommended,
    rules: { 'no-console': 'off' },
  },
  {
    name: 'typescript-typechecked',
    files: ['**/*.ts', '**/*.tsx'],
    extends: [ ...tseslint.configs.recommendedTypeChecked ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json'],
        tsconfigRootDir: new URL('.', import.meta.url).pathname,
        sourceType: 'module',
      },
    },
    plugins: {
      import: (await import('eslint-plugin-import')).default,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/no-redundant-type-constituents': 'error',
      'import/order': ['error', { 'newlines-between': 'always', alphabetize: { order: 'asc' } }],
      'no-duplicate-imports': 'error',
      'no-console': 'off'
    },
  }
);
