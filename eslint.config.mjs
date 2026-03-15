import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'build/**',
      'coverage/**',
      'node_modules/**',
      'vitest.config.mjs',
      'vitest.e2e.config.mjs',
      'vitest.integration.config.mjs',
    ],
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },
  },
  // Test files use Record<string, unknown> intentionally to inspect raw state
  // without coupling tests to specific type definitions. Unsafe-access rules
  // would require casting every property access, adding noise with no safety benefit.
  {
    files: ['**/*.test.ts', '**/*.e2e.test.ts', 'test-fixtures/**/*.ts', 'package-contract.test.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
    },
  },
);
