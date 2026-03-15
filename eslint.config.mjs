import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'build/**',
      'coverage/**',
      'node_modules/**',
      'eslint.config.mjs',
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
  // Additionally:
  //   require-await: mock methods must match async interface signatures even without await
  //   restrict-template-expressions: test assertions mix types in template literals normally
  //   no-non-null-asserted-optional-chain: tests legitimately assert known-present values with !
  //   prefer-promise-reject-errors: test scenarios intentionally reject with non-Error values
  //   no-unused-vars argsIgnorePattern: _-prefixed params suppress unused-arg warnings
  {
    files: ['**/*.test.ts', '**/*.e2e.test.ts', 'test-fixtures/**/*.ts', 'package-contract.test.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/no-non-null-asserted-optional-chain': 'off',
      '@typescript-eslint/prefer-promise-reject-errors': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { varsIgnorePattern: '^_', argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
  },
);
